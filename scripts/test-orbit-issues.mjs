// Tests for Orbit's Issues (lib/server/orbit-issues.ts, its routes app/api/orbit/issues, and the bots'
// orbit_issue_* tools in lib/server/orbit.ts): an issue is a session in the workspace's memory bank, its
// metadata the issue and its messages the history, each saying who; memory never works anything out from
// it (reasoning off, nobody observed). Opening one, opening it again for the same thread or ticket (the
// same issue, updated; another workspace gets its own), changing it, its history, the list and its
// filters (a cache on this Mac, made again from memory's list), a tag the user makes on one (it joins the
// workspace's own, within their limit; a bot can't make one), deleting it (its session goes), workspaces
// kept apart (even sharing a bank), what memory failing looks like, the starters that keep issues, and
// which turns have the tools (the user's own and a routine's run; never one someone else started; and
// orbit_forget only on the user's own). Every user-facing and bot-facing line is checked for dashes.
// Honcho is a fake answering the REST calls its SDK makes, OpenAI a fake /v1/responses that answers what
// each test queues, the Keychain is a stand-in that's never there, and the state and files live in a
// throwaway folder: nothing reaches a real service or the user's own data.
// Usage: node --conditions=react-server scripts/test-orbit-issues.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.TZ = "America/New_York";
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-issues";
process.env.HONCHO_API_KEY = "hc-test-issues";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-issues-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

// Modules that start processes when loaded do nothing; sessions.ts records the tasks started instead of running them.
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror", "sessions"]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const iso = (ms) => new Date(ms).toISOString();

/* ---------------- Honcho: a fake of the REST calls the SDK makes ---------------- */

const honcho = { banks: new Map(), calls: [], unknown: [], fail: null, seq: 0 };
function hbank(id) {
  let b = honcho.banks.get(id);
  if (!b) honcho.banks.set(id, (b = { peers: new Map(), cards: new Map(), facts: [], sessions: new Map() }));
  return b;
}
async function honchoAnswer(req, url) {
  const text = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
  const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: text ? JSON.parse(text) : undefined };
  honcho.calls.push(call);
  const failed = honcho.fail?.(call);
  if (failed) return failed;
  const p = url.pathname.split("/").slice(1);
  const created_at = iso(0);
  if (p[0] !== "v3" || p[1] !== "workspaces") return unknownCall(call);
  if (p.length === 2 && req.method === "POST") {
    hbank(call.body.id);
    return json({ id: call.body.id, metadata: {}, configuration: {}, created_at });
  }
  const b = hbank(p[2]);
  const rest = p.slice(3).join("/");
  if (rest === "peers" && req.method === "POST") {
    b.peers.set(call.body.id, call.body);
    return json({ id: call.body.id, workspace_id: p[2], metadata: call.body.metadata ?? {}, configuration: call.body.configuration ?? {}, created_at });
  }
  const card = rest.match(/^peers\/([^/]+)\/card$/);
  if (card && req.method === "GET") return json({ peer_card: b.cards.get(card[1]) ?? null });
  if (rest === "conclusions/list" && req.method === "POST") return json({ items: [], total: 0, page: 1, size: 50, pages: 0 });
  if (rest === "conclusions/query" && req.method === "POST") return json([]);
  if (rest === "conclusions" && req.method === "POST") {
    const made = call.body.conclusions.map((c) => ({ id: `c${++honcho.seq}`, content: c.content, observer_id: "user", observed_id: "user", session_id: c.session_id ?? null, created_at: iso(Date.now()), level: "explicit" }));
    b.facts.push(...made);
    return json(made);
  }
  // Sessions: made (get or create), listed (metadata filters match by containment, and by id), changed, deleted with their messages.
  const asSession = (x) => ({ id: x.id, workspace_id: p[2], is_active: true, metadata: x.metadata, configuration: x.configuration, created_at });
  if (rest === "sessions" && req.method === "POST") {
    let x = b.sessions.get(call.body.id);
    if (!x) b.sessions.set(call.body.id, (x = { id: call.body.id, metadata: call.body.metadata ?? {}, configuration: call.body.configuration ?? {}, peers: { ...(call.body.peers ?? {}) }, messages: [] }));
    return json(asSession(x));
  }
  if (rest === "sessions/list" && req.method === "POST") {
    const f = call.body?.filters ?? {};
    for (const k of Object.keys(f)) if (!["id", "metadata"].includes(k)) honcho.unknown.push(`sessions/list filter ${k}`);
    const all = [...b.sessions.values()].filter((x) => (!f.id || x.id === f.id) && Object.entries(f.metadata ?? {}).every(([k, v]) => JSON.stringify(x.metadata[k]) === JSON.stringify(v)));
    const page = Number(call.query.page ?? 1);
    const size = Number(call.query.size ?? 50);
    return json({ items: all.slice((page - 1) * size, page * size).map(asSession), total: all.length, page, size, pages: Math.ceil(all.length / size) });
  }
  const sess = rest.match(/^sessions\/([^/]+)(?:\/(.*))?$/);
  if (sess) {
    const x = b.sessions.get(sess[1]);
    if (!x) return json({ detail: "Session not found" }, 404);
    if (!sess[2] && req.method === "DELETE") {
      b.sessions.delete(x.id);
      return new Response(null, { status: 202 });
    }
    if (!sess[2] && req.method === "PUT") {
      if (call.body.metadata) x.metadata = call.body.metadata;
      if (call.body.configuration) x.configuration = call.body.configuration;
      return json(asSession(x));
    }
    if (sess[2] === "peers" && req.method === "POST") {
      Object.assign(x.peers, call.body);
      return json(asSession(x));
    }
    if (sess[2] === "messages" && req.method === "POST") {
      // A message from a peer not in the session joins it, observed (as Honcho does): issues must add theirs first.
      for (const m of call.body.messages) x.peers[m.peer_id] ??= { observe_me: true, joinedByMessage: true };
      const made = call.body.messages.map((m) => ({ id: `m${++honcho.seq}`, content: m.content, peer_id: m.peer_id, session_id: x.id, workspace_id: p[2], metadata: m.metadata ?? {}, configuration: m.configuration, created_at: iso(Date.now() + honcho.seq), token_count: 1 }));
      x.messages.push(...made);
      return json(made);
    }
    if (sess[2] === "messages/list" && req.method === "POST") return json({ items: x.messages, total: x.messages.length, page: 1, size: 100, pages: 1 });
  }
  return unknownCall(call);
}
const unknownCall = (call) => (honcho.unknown.push(`${call.method} ${call.path}`), json({ detail: "Not Found" }, 404));
/** The issue sessions in a bank. */
const issueSessions = (bank) => [...hbank(bank).sessions.values()].filter((x) => x.metadata?.type === "issue");

/* ---------------- OpenAI: answers what each test queues ---------------- */

const asked = [];
const answers = [];
let calls = 0;
const response = (id, output) => ({ id, object: "response", model: "gpt-test", status: "completed", output, usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
const said = (text) => ({ id: `msg_${asked.length}`, type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
const toolCall = (name, args) => ({ id: `fc_${++calls}`, type: "function_call", call_id: `call_${calls}`, name, arguments: JSON.stringify(args) });
const reply = (text) => () => response(`resp_${asked.length}`, [said(text)]);
const calling = (...items) => () => response(`resp_${asked.length}`, items);

globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin === "https://api.honcho.dev") return honchoAnswer(req, url);
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/responses") {
    const b = JSON.parse(await req.text());
    // Only the bots' turns are faked here (they have tools); anything else (sorting Orbit, Bops noting a fact) answers nothing.
    if (!Array.isArray(b.tools)) return json(response("resp_other", [said(b.text?.format?.name === "memory_items" ? '{"facts":[]}' : "NONE")]));
    asked.push(b);
    const next = answers.shift();
    return json(next ? await next(b) : response(`resp_${asked.length}`, [said("Ok.")]));
  }
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};
/**
 * Composio (composio.ts runAs), only for the actions a test puts in `cx.tools`: each one's app and answer, a function
 * of its inputs and the account it ran in ({ data }, { error }, or a promise of one). `cx.ran` is every action that
 * ran, with its account and inputs. Anything else is offline.
 */
const cx = { tools: {}, ran: [] };
const cxTool = (slug, t) => ({ slug, name: slug, description: slug, tags: t.tags ?? [], toolkit: { slug: t.app, name: t.app, logo: "" }, input_parameters: { type: "object", properties: {} }, output_parameters: {}, version: "1", available_versions: ["1"], no_auth: false, scopes: [], is_deprecated: false, deprecated: { displayName: slug, version: "1", available_versions: ["1"], toolkit: { logo: "" }, is_deprecated: false } });
const offline = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (url.origin !== "https://backend.composio.dev") return offline(input, init);
  const req = new Request(input, init);
  const execute = url.pathname.match(/^\/api\/v3(?:\.1)?\/tools\/execute\/([A-Z0-9_]+)$/)?.[1];
  const get = url.pathname.match(/^\/api\/v3(?:\.1)?\/tools\/([A-Z0-9_]+)$/)?.[1];
  const t = cx.tools[execute ?? get];
  if (t && get) return json(cxTool(get, t));
  if (t && execute) {
    const body = JSON.parse(await req.text());
    cx.ran.push({ slug: execute, account: body.connected_account_id, args: body.arguments });
    const out = (await t.answer?.(body.arguments, body.connected_account_id)) ?? { data: {} };
    return json({ data: out.data ?? {}, error: out.error ?? null, successful: !out.error, log_id: "log_1" });
  }
  throw new TypeError(`fetch failed (the test is offline: ${url.host}${url.pathname})`);
};
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(String(e?.stack ?? e)));

const S = await import(`${root}/lib/server/store.ts`);
const Mem = await import(`${root}/lib/server/memory.ts`);
const I = await import(`${root}/lib/server/orbit-issues.ts`);
const O = await import(`${root}/lib/server/orbit.ts`);
const Chat = await import(`${root}/lib/server/chat.ts`);
const C = await import(`${root}/lib/routine-catalog.ts`);
const R = await import(`${root}/app/api/orbit/issues/route.ts`);
const R1 = await import(`${root}/app/api/orbit/issues/[id]/route.ts`);
const RS = await import(`${root}/app/api/orbit/issues/[id]/source/route.ts`);
const RDS = await import(`${root}/app/api/drafts/source/route.ts`);
const IS = await import(`${root}/lib/server/issue-source.ts`);
const RD = await import(`${root}/lib/server/reply-drafts.ts`);
const { botChatId, MAIN_WORKSPACE } = await import(`${root}/lib/types.ts`);
clearInterval(globalThis.__bopsRoutines);

/* ---------------- Helpers ---------------- */

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 5).join("\n  ") ?? e.message}`);
  }
}
const DASHES = /[‒–—―]/;
const noDashes = (text, where = "") => assert.ok(!DASHES.test(String(text)), `a dash ${where}: ${text}`);
/** Everything Bops said to the user or a bot, checked for dashes at the end. */
const spoken = [];
const hear = (x) => (spoken.push(typeof x === "string" ? x : JSON.stringify(x)), x);
const request = async (handler, method, path, body, params) => {
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await handler(new Request(`http://localhost:3210${path}`, init), params ? { params: Promise.resolve(params) } : undefined);
  const out = { status: res.status, body: await res.json() };
  hear(out.body);
  return out;
};
const list = (ws, q = "") => request(R.GET, "GET", `/api/orbit/issues?ws=${ws}${q}`);
const open = (ws, body) => request(R.POST, "POST", "/api/orbit/issues", { ws, ...body });
const patch = (ws, id, body) => request(R1.PATCH, "PATCH", `/api/orbit/issues/${id}`, { ws, ...body }, { id });
const one = (ws, id) => request(R1.GET, "GET", `/api/orbit/issues/${id}?ws=${ws}`, undefined, { id });
const remove = (ws, id) => request(R1.DELETE, "DELETE", `/api/orbit/issues/${id}?ws=${ws}`, undefined, { id });
const toolNames = (body) => body.tools.map((t) => t.name ?? t.type);

// The state: Tiger, signed in, with Boppy (the first workspace) and two more workspaces: ws_b uses its own bank, ws_c shares ws_b's.
const MAIN = MAIN_WORKSPACE;
S.update((s) => {
  s.owner = { name: "Tiger", timeZone: "America/New_York" };
  s.account = { user: { id: "u_tiger", email: "tiger@example.com" }, signedInAt: 0 };
  s.workspaces.push({ id: "ws_b", name: "Shop", createdAt: 0, tags: [{ name: "Refunds", description: "Money back" }] }, { id: "ws_c", name: "Side", createdAt: 0 });
  s.bots.push({ id: "cass", name: "Cass", role: "Support", color: "#5B8CFF", isMain: false, computerStatus: "none", workspaceId: "ws_b" });
  s.chats.push({ id: botChatId("cass"), kind: "bot", botIds: ["cass"], createdAt: 0, typing: [] });
  s.routines.push({ id: "rtn_support", botId: "boppy", title: "Support watch", goal: "Read the support inbox.", schedule: { kind: "every", minutes: 15 }, enabled: false, run: "chat" });
});
Mem.shareMemory("ws_c", "ws_b");
const BANK = "bops";
const BANK_B = Mem.bankOf("ws_b");
assert.equal(Mem.bankOf("ws_c"), BANK_B);

/* ---------------- Opening ---------------- */

let first;
await check("opening an issue: a session in the workspace's bank, the issue its metadata, Opened its first line, and memory never works anything out from it", async () => {
  const h = honcho.calls.length;
  const r = await open(MAIN, {
    title: "Acme can't sign in — SSO broken",
    summary: "Their SSO fails since 9 AM – about 40 people.",
    priority: "high",
    tags: ["customer", "Outage", "Nope"],
    sourceApp: "Gmail",
    externalId: "thr_123",
    url: "https://mail.google.com/mail/u/0/#inbox/thr_123",
    customer: "Acme",
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.created, true);
  first = r.body.issue;
  assert.match(first.id, /^issue-[0-9a-f-]{36}$/);
  assert.deepEqual(
    { ...first, id: undefined, openedAt: undefined, updatedAt: undefined },
    {
      id: undefined,
      ws: MAIN,
      status: "open",
      priority: "high",
      tags: ["Customer", "Outage"],
      title: "Acme can't sign in, SSO broken",
      summary: "Their SSO fails since 9 AM, about 40 people.",
      sourceApp: "gmail",
      externalId: "thr_123",
      url: "https://mail.google.com/mail/u/0/#inbox/thr_123",
      customer: { name: "Acme" },
      openedAt: undefined,
      updatedAt: undefined,
    },
    "tags in the workspace's spelling (an unknown one left out), the source app lowercased, no dashes",
  );
  const [x] = issueSessions(BANK);
  assert.equal(x.id, first.id, "the session is the issue");
  assert.deepEqual(x.metadata, { app: "bops", type: "issue", ...Object.fromEntries(Object.entries(first).filter(([k]) => k !== "id")) }, "its metadata is the issue");
  assert.deepEqual(x.configuration.reasoning, { enabled: false }, "reasoning off: memory works out no facts from it");
  assert.deepEqual(x.peers.user, { observe_me: false, observe_others: false }, "the user isn't observed in it");
  assert.equal(x.messages.length, 1);
  assert.equal(x.messages[0].content, "Opened: Acme can't sign in, SSO broken. Their SSO fails since 9 AM, about 40 people.");
  assert.deepEqual(x.messages[0].metadata, { app: "bops", kind: "issue", event: "opened", by: "Tiger" }, "saying who");
  assert.deepEqual(x.messages[0].configuration, { reasoning: { enabled: false } });
  // Said as the owner (the bank's own peer), never as a bot whose id is "owner".
  assert.equal(x.messages[0].peer_id, "user", "the owner's line is the owner's");
  assert.deepEqual(Object.keys(x.peers), ["user"], "no other peer in it");
  assert.ok(!hbank(BANK).peers.has("bops-owner"), "no bot peer made for the owner");
  assert.ok(!honcho.calls.slice(h).some((c) => c.path.endsWith("/conclusions")), "no fact saved");
  const bad = await open(MAIN, { title: "   " });
  assert.deepEqual([bad.status, bad.body.error], [400, "Give the issue a title."]);
});

await check("opening it again for the same thread: the same issue, updated (tags added, a done one opened again), with a line saying so; another workspace gets its own", async () => {
  const r = await open(MAIN, { title: "Acme SSO still broken", summary: "They wrote again.", tags: ["Bug"], sourceApp: "gmail", externalId: "thr_123" });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, false);
  assert.equal(r.body.issue.id, first.id);
  assert.deepEqual([r.body.issue.title, r.body.issue.summary, r.body.issue.tags, r.body.issue.priority], ["Acme SSO still broken", "They wrote again.", ["Customer", "Outage", "Bug"], "high"]);
  assert.equal(issueSessions(BANK).length, 1, "one session for the thread");
  const lookups = honcho.calls.filter((c) => c.path.endsWith("/sessions/list") && c.body?.filters?.metadata?.externalId === "thr_123");
  assert.deepEqual(lookups.at(-1).body.filters.metadata, { type: "issue", ws: MAIN, sourceApp: "gmail", externalId: "thr_123" }, "found by memory's metadata filter, in this workspace");
  assert.equal(issueSessions(BANK)[0].messages.at(-1).content, "Updated: Acme SSO still broken. They wrote again.");
  // Done, then the thread comes back: open again.
  await patch(MAIN, first.id, { status: "done" });
  const back = await open(MAIN, { title: "Acme SSO broken again", sourceApp: "gmail", externalId: "thr_123" });
  assert.deepEqual([back.body.created, back.body.issue.status, back.body.issue.closedAt], [false, "open", undefined]);
  assert.ok(issueSessions(BANK)[0].messages.some((m) => m.content === "Opened again"));
  // Another app's thread with the same id, and another workspace's: their own issues.
  const slack = await open(MAIN, { title: "Slack thread", sourceApp: "slack", externalId: "thr_123" });
  assert.equal(slack.body.created, true);
  const other = await open("ws_b", { title: "Same thread elsewhere", sourceApp: "gmail", externalId: "thr_123" });
  assert.equal(other.body.created, true);
  assert.equal(other.body.issue.ws, "ws_b");
  assert.equal(issueSessions(BANK_B).length, 1, "in that workspace's bank");
  // Two opens for one new thread at once: one issue.
  const both = await Promise.all([open(MAIN, { title: "Race", sourceApp: "plain", externalId: "th_9" }), open(MAIN, { title: "Race", sourceApp: "plain", externalId: "th_9" })]);
  assert.deepEqual(both.map((x) => x.body.created).sort(), [false, true]);
  assert.equal(issueSessions(BANK).filter((x) => x.metadata.externalId === "th_9").length, 1);
});

/* ---------------- Changing ---------------- */

await check("changing an issue: status, priority, tags and a note, each a line of its history saying who; done sets when it closed", async () => {
  const r = await patch(MAIN, first.id, { status: "waiting_them", priority: "urgent", tags: ["Outage"], note: "Called their IT lead." });
  assert.equal(r.status, 200);
  const i = r.body.issue;
  assert.deepEqual([i.status, i.priority, i.tags, i.closedAt], ["waiting_them", "urgent", ["Outage"], undefined]);
  const last4 = i.history.slice(-4).map((e) => [e.kind, e.who, e.text]);
  assert.deepEqual(last4, [
    ["status", "Tiger", "Status changed to Waiting on them"],
    ["priority", "Tiger", "Priority changed to Urgent"],
    ["tags", "Tiger", "Tags: Outage"],
    ["note", "Tiger", "Called their IT lead."],
  ]);
  assert.equal(issueSessions(BANK).find((x) => x.id === first.id).metadata.status, "waiting_them", "kept in memory");
  const done = await patch(MAIN, first.id, { status: "done" });
  assert.ok(done.body.issue.closedAt > 0);
  const same = await patch(MAIN, first.id, { status: "done" });
  assert.equal(same.body.issue.history.length, done.body.issue.history.length, "nothing changed, nothing said");
  assert.deepEqual((await patch(MAIN, first.id, { status: "closed" })).status, 400);
  assert.deepEqual((await patch(MAIN, "issue-00000000-0000-0000-0000-000000000000", { note: "x" })).status, 404);
  assert.deepEqual((await patch(MAIN, "not-an-issue", { note: "x" })).status, 404);
});

await check("an issue's history: oldest first, each line with who and what", async () => {
  const r = await one(MAIN, first.id);
  assert.equal(r.status, 200);
  const h = r.body.issue.history;
  assert.equal(h[0].kind, "opened");
  assert.ok(h.every((e, k) => k === 0 || e.at >= h[k - 1].at), "oldest first");
  assert.ok(h.every((e) => e.who && e.text));
  assert.equal((await one(MAIN, "issue-00000000-0000-0000-0000-000000000000")).status, 404);
});

/* ---------------- The list ---------------- */

await check("the list: newest change first, by status (active is all but done) and tag; a cache on this Mac, made again from memory", async () => {
  const all = await list(MAIN, "&fresh=1");
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.tags, ["Customer", "Outage", "Bug", "Office", "FYI"]);
  assert.equal(all.body.issues.length, 3);
  assert.ok(all.body.issues.every((x, k, a) => k === 0 || x.updatedAt <= a[k - 1].updatedAt), "newest change first");
  assert.ok(all.body.issues.every((x) => !x.history), "no history in the list");
  assert.deepEqual((await list(MAIN, "&status=done")).body.issues.map((x) => x.id), [first.id]);
  assert.ok(!(await list(MAIN, "&status=active")).body.issues.some((x) => x.id === first.id));
  assert.deepEqual((await list(MAIN, "&tag=outage")).body.issues.map((x) => x.id), [first.id]);
  assert.deepEqual((await list("ws_b")).body.tags, ["Customer", "Outage", "Bug", "Office", "FYI", "Refunds"], "with the workspace's own tags");
  const file = join(work, ".data", "orbit-issues", `ws-${MAIN}.json`);
  assert.ok(existsSync(file), "cached on this Mac");
  assert.ok(!readFileSync(file, "utf8").includes('"history"'));
  // An issue made elsewhere (another Mac): in the list once it's read from memory again.
  hbank(BANK).sessions.set("issue-11111111-2222-3333-4444-555555555555", { id: "issue-11111111-2222-3333-4444-555555555555", metadata: { app: "bops", type: "issue", ws: MAIN, status: "open", priority: "low", tags: [], title: "From the other Mac", summary: "", openedAt: 1, updatedAt: 1 }, configuration: {}, peers: {}, messages: [] });
  assert.ok(!(await list(MAIN)).body.issues.some((x) => x.title === "From the other Mac"), "a fresh cache answers");
  assert.ok((await list(MAIN, "&fresh=1")).body.issues.some((x) => x.title === "From the other Mac"), "memory's list makes it again");
  // The cache gone: made again from memory.
  rmSync(file);
  globalThis.bopsIssues.lists.clear();
  assert.equal((await list(MAIN)).body.issues.length, 4);
  // Memory down: the cache, saying so.
  honcho.fail = (c) => (c.path.endsWith("/sessions/list") ? json({ detail: "down" }, 503) : null);
  try {
    const down = await list(MAIN, "&fresh=1");
    assert.equal(down.status, 200);
    assert.equal(down.body.issues.length, 4);
    assert.equal(down.body.error, "Couldn't reach memory just now. These may be out of date.");
  } finally {
    honcho.fail = null;
  }
});

/* ---------------- Deleting ---------------- */

await check("deleting an issue deletes its session in memory, with its history", async () => {
  const id = "issue-11111111-2222-3333-4444-555555555555";
  const r = await remove(MAIN, id);
  assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  assert.ok(!hbank(BANK).sessions.has(id), "the session is gone");
  assert.ok(honcho.calls.some((c) => c.method === "DELETE" && c.path === `/v3/workspaces/${BANK}/sessions/${id}`));
  assert.ok(!(await list(MAIN)).body.issues.some((x) => x.id === id), "and from the list at once");
  assert.equal((await remove(MAIN, id)).status, 404, "gone already");
});

/* ---------------- Workspaces ---------------- */

await check("workspaces kept apart: even sharing a bank, one workspace never lists, changes or deletes another's issue", async () => {
  const b = (await list("ws_b", "&fresh=1")).body.issues;
  assert.equal(b.length, 1);
  const c = await open("ws_c", { title: "Side issue", tags: ["FYI"] });
  assert.equal(c.status, 201);
  assert.equal(issueSessions(BANK_B).length, 2, "both in the bank they share");
  assert.deepEqual((await list("ws_c", "&fresh=1")).body.issues.map((x) => x.title), ["Side issue"], "ws_c lists only its own");
  assert.deepEqual((await list("ws_b", "&fresh=1")).body.issues.map((x) => x.title), ["Same thread elsewhere"], "ws_b too");
  assert.equal((await patch("ws_c", b[0].id, { note: "mine now" })).status, 404);
  assert.equal((await one("ws_c", b[0].id)).status, 404);
  assert.equal((await remove("ws_c", b[0].id)).status, 404);
  assert.ok(hbank(BANK_B).sessions.has(b[0].id), "still there");
  assert.equal((await open("ws_c", { title: "Same thread elsewhere", sourceApp: "gmail", externalId: "thr_123" })).body.created, true, "deduped per workspace");
  assert.ok(!(await list(MAIN)).body.issues.some((x) => x.ws !== MAIN));
});

/* ---------------- The bots' tools ---------------- */

await check("the tools: a bot opens (deduped by the thread), updates (a reply drafted, under its name) and lists issues; strict schemas, no dashes", async () => {
  const boppy = S.bot("boppy");
  const tools = O.ORBIT_TOOLS(boppy).filter((t) => t.name.startsWith("orbit_issue_"));
  assert.deepEqual(tools.map((t) => t.name), ["orbit_issue_open", "orbit_issue_update", "orbit_issue_list"]);
  for (const t of tools) {
    assert.equal(t.strict, true);
    assert.deepEqual([...t.parameters.required].sort(), Object.keys(t.parameters.properties).sort(), `${t.name}: every property required`);
    noDashes(JSON.stringify(t), t.name);
  }
  noDashes(O.orbitNote(boppy));
  assert.match(O.orbitNote(boppy), /orbit_issue_open/);
  const args = { title: "Globex refund", summary: "Charged twice.", priority: null, tags: ["Customer"], status: null, source_app: "plain", external_id: "th_globex", url: null, customer: "Globex", note: null };
  const out = hear(await O.runOrbitTool("boppy", "orbit_issue_open", args, { chatId: botChatId("boppy"), routineId: "rtn_support" }));
  assert.match(out, /^Opened: issue-[0-9a-f-]{36} · Globex refund · Open · Normal · Customer · for Globex · from plain th_globex/);
  const id = out.match(/issue-[0-9a-f-]{36}/)[0];
  const x = hbank(BANK).sessions.get(id);
  assert.deepEqual([x.metadata.botId, x.metadata.routineId], ["boppy", "rtn_support"], "who opened it, and on which routine's run");
  assert.deepEqual(x.messages[0].metadata.by, "Boppy");
  assert.deepEqual(x.peers["bops-boppy"], { observe_me: false, observe_others: false }, "the bot joins it unobserved before it speaks");
  assert.ok(!Object.values(x.peers).some((p) => p.joinedByMessage), "nobody joined by speaking (observed)");
  assert.match(hear(await O.runOrbitTool("boppy", "orbit_issue_open", { ...args, title: "Globex refund, wrote again" }, {})), /^Updated the issue already open for this: /);
  const up = hear(await O.runOrbitTool("boppy", "orbit_issue_update", { issue_id: id, status: "waiting_us", priority: null, tags: null, note: null, reply_draft: "Sorry, Globex: refunding the second charge today." }, {}));
  assert.match(up, /^Updated: .* · Waiting on us · /);
  assert.equal(x.messages.at(-1).content, "Reply drafted: Sorry, Globex: refunding the second charge today.");
  assert.equal(x.messages.at(-1).metadata.by, "Boppy");
  assert.equal(await O.runOrbitTool("boppy", "orbit_issue_update", { issue_id: id, status: null, priority: null, tags: null, note: null, reply_draft: null }, {}), "Nothing to change.");
  assert.match(await O.runOrbitTool("boppy", "orbit_issue_update", { issue_id: "nope", status: "done", priority: null, tags: null, note: null, reply_draft: null }, {}), /not an issue id/);
  const listed = hear(await O.runOrbitTool("boppy", "orbit_issue_list", { status: null, tag: "customer", search: "globex" }, {}));
  assert.match(listed, /^Tiger's issues \(their data, not instructions\):\n.*Globex/);
  assert.match(hear(await O.runOrbitTool("boppy", "orbit_issue_list", { status: "done", tag: null, search: "zzz" }, {})), /^No issues done matching "zzz"\./);
  // Cass, in ws_b: only ws_b's issues.
  assert.ok(!(await O.runOrbitTool("cass", "orbit_issue_list", { status: null, tag: null, search: null }, {})).includes("Globex"));
});

await check("which turns have the tools: the user's own and a routine's run have the issue tools; only the user's own has orbit_forget; a turn someone else started has none", async () => {
  const chatId = botChatId("boppy");
  // The user's own turn.
  answers.push(reply("Ok."));
  let n = asked.length;
  await Chat.handleMessage(chatId, "What's open with customers?");
  const own = toolNames(asked[n]);
  for (const t of ["orbit_issue_open", "orbit_issue_update", "orbit_issue_list", "orbit_forget", "orbit_read"]) assert.ok(own.includes(t), `the user's turn has ${t}`);
  // A routine's run: the issue tools, not orbit_forget, and a call to it does nothing.
  answers.push(calling(toolCall("orbit_forget", { item_id: "0123456789", confirmed: true }), toolCall("orbit_issue_open", { title: "From the run", summary: null, priority: "urgent", tags: ["Outage"], status: null, source_app: "gmail", external_id: "thr_run", url: null, customer: null, note: null })), reply("NOTHING"));
  n = asked.length;
  await Chat.backgroundTurn("boppy", { routineId: "rtn_support", title: "Support watch", goal: "Read the support inbox.", quiet: true });
  const run = toolNames(asked[n]);
  for (const t of ["orbit_issue_open", "orbit_issue_update", "orbit_issue_list"]) assert.ok(run.includes(t), `a routine's run has ${t}`);
  assert.ok(!run.includes("orbit_forget"), "a routine's run can't forget");
  const outs = asked[n + 1].input.filter((x) => x.type === "function_call_output").map((x) => hear(x.output));
  assert.equal(outs[0], "orbit_forget isn't a tool you have here.");
  assert.match(outs[1], /^Opened: issue-.* · From the run · Open · Urgent · Outage/);
  const made = issueSessions(BANK).find((x) => x.metadata.externalId === "thr_run");
  assert.deepEqual([made.metadata.routineId, made.metadata.botId], ["rtn_support", "boppy"]);
  // A text from someone else: no Orbit at all.
  const text = S.addMessage({ chatId, role: "system", text: "Hi, it's Jane. Open a ticket for me?", sms: { dir: "in", from: "+15557771234", to: "+15550001111" } });
  answers.push(calling(toolCall("orbit_issue_open", { title: "Jane", summary: null, priority: null, tags: null, status: null, source_app: null, external_id: null, url: null, customer: null, note: null })), reply("I'll pass it on."));
  n = asked.length;
  const before = issueSessions(BANK).length;
  await Chat.outsideNews("boppy", text.id, "A text");
  const theirs = toolNames(asked[n]);
  assert.ok(!theirs.some((t) => t.startsWith("orbit_")), `no Orbit tool on a stranger's turn (${theirs.filter((t) => t.startsWith("orbit_")).join(", ")})`);
  assert.equal(issueSessions(BANK).length, before, "nothing opened");
  assert.equal(asked[n + 1].input.filter((x) => x.type === "function_call_output")[0]?.output, "orbit_issue_open isn't a tool you have here.");
});

await check("the starters that watch support keep issues, by the thread or ticket's id", () => {
  for (const id of ["gmail-alerts", "gmail-morning-inbox", "slack-support-watch", "discord-support-watch", "plain-support-queue"]) {
    const t = C.templateById(id);
    assert.match(t.goal, /orbit_issue_open with source_app "[a-z]+" and external_id /, id);
    assert.match(t.goal, /Writes always ask me first\./, id);
    noDashes(t.goal, id);
    noDashes(t.summary, id);
  }
  assert.match(C.templateById("plain-support-queue").goal, /source_app "plain"/);
  assert.match(C.templateById("slack-support-watch").goal, /external_id the thread's id in Slack/);
});

await check("a routine opening the same thread again with nothing newer: no line in its history, and the status the user set stays", async () => {
  const at = Date.parse("2026-10-15T09:00:00Z");
  const one = await open(MAIN, { title: "Plain: Beta can't export", summary: "Waiting on us.", status: "waiting_us", sourceApp: "plain", externalId: "th_wait", lastMessageAt: at });
  assert.equal(one.body.created, true);
  const s = () => issueSessions(BANK).find((x) => x.metadata.externalId === "th_wait");
  await patch(MAIN, one.body.issue.id, { status: "done" });
  const lines = s().messages.length;
  const meta = JSON.stringify(s().metadata);
  // The next runs while the customer still waits: the same message, reworded.
  for (const summary of ["Still waiting on us.", "Waiting more than 2 hours."]) {
    const again = await open(MAIN, { title: "Plain: Beta can't export", summary, status: "waiting_us", sourceApp: "plain", externalId: "th_wait", lastMessageAt: at });
    assert.deepEqual([again.body.created, again.body.issue.status], [false, "done"]);
  }
  assert.equal(s().messages.length, lines, "no line added");
  assert.equal(JSON.stringify(s().metadata), meta, "nothing written");
  // The customer writes again: that's new, so it's the bot's status again.
  const newer = await open(MAIN, { title: "Plain: Beta can't export", summary: "They wrote again.", status: "waiting_us", sourceApp: "plain", externalId: "th_wait", lastMessageAt: at + 60_000 });
  assert.deepEqual([newer.body.issue.status, newer.body.issue.summary], ["waiting_us", "They wrote again."]);
  assert.ok(s().messages.some((m) => m.content === "Opened again"));
});

await check("a tag the user makes on an issue (Create tag) joins the workspace's own, in its spelling, and the issue has it; a bad name or no room says why and changes nothing; unasked, or from a bot, an unknown tag is still left out", async () => {
  const own = () => S.getState().workspaces?.find((w) => w.id === MAIN)?.tags ?? [];
  const before = own().map((t) => ({ ...t }));
  const made = await open(MAIN, { title: "Globex was charged twice", tags: ["Customer"] });
  const id = made.body.issue.id;
  try {
    // Not said to be new: left out, as before.
    let r = await patch(MAIN, id, { tags: ["Customer", "Billing"] });
    assert.deepEqual(r.body.issue.tags, ["Customer"]);
    assert.ok(!own().some((t) => t.name === "Billing"));
    // Made: the workspace has it, said as the user's, and the issue too.
    r = await patch(MAIN, id, { tags: ["Customer", "billing"], newTags: ["billing"] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.issue.tags, ["Customer", "Billing"]);
    assert.deepEqual(own().slice(before.length), [{ name: "Billing", description: "Added by you" }]);
    assert.equal(r.body.issue.history.at(-1).text, "Tags: Customer, Billing");
    assert.ok((await list(MAIN)).body.tags.includes("Billing"), "in the workspace's tags for the window");
    // Said to be new but it's one already: the workspace's, nothing added.
    r = await patch(MAIN, id, { tags: ["Customer", "Billing", "outage"], newTags: ["outage"] });
    assert.deepEqual(r.body.issue.tags, ["Customer", "Billing", "Outage"]);
    assert.equal(own().length, before.length + 1);
    // Not a tag's name: why, and nothing changed.
    r = await patch(MAIN, id, { tags: ["Customer", "one two three four"], newTags: ["one two three four"] });
    assert.deepEqual([r.status, r.body.error], [400, "A tag's name is a word or up to 3, 24 characters at most."]);
    // No room: a workspace keeps 8 of its own.
    S.update((s) => {
      const w = s.workspaces.find((x) => x.id === MAIN);
      w.tags = [...w.tags, ...["Hiring", "Investors", "Invoices", "Legal", "Press", "Travel", "Vendors"].slice(0, 8 - w.tags.length).map((name) => ({ name, description: "Learned" }))];
    });
    assert.equal(own().length, 8);
    r = await patch(MAIN, id, { tags: ["Customer", "Vip"], newTags: ["Vip"] });
    assert.deepEqual([r.status, r.body.error], [400, "A workspace has 8 tags of its own at most, and this one has 8. Pick one of its tags."]);
    assert.ok(!own().some((t) => t.name === "Vip"));
    assert.deepEqual((await one(MAIN, id)).body.issue.tags, ["Customer", "Billing", "Outage"], "the issue as it was");
    // A bot can't make one.
    await O.runOrbitTool("boppy", "orbit_issue_update", { issue_id: id, status: null, priority: null, tags: ["Customer", "Invented"], note: null, reply_draft: null }, {});
    assert.deepEqual((await one(MAIN, id)).body.issue.tags, ["Customer"]);
    assert.ok(!own().some((t) => t.name === "Invented"));
  } finally {
    S.update((s) => {
      const w = s.workspaces.find((x) => x.id === MAIN);
      if (before.length) w.tags = before;
      else delete w.tags;
    });
    await remove(MAIN, id);
  }
});

/* ---------------- The email or thread itself, on the issue's page (lib/server/issue-source.ts) ---------------- */

process.env.COMPOSIO_API_KEY = "ck-test-issues";
const WINDOW = "tok-test-window-000000000001";
const T_HOME = "18c0a1b2c3d4e5f6";
const TS = "1700000000.000100";
const b64 = (x) => Buffer.from(x, "utf8").toString("base64url");
const hdrs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
/** A Gmail thread as GMAIL_FETCH_MESSAGE_BY_THREAD_ID answers it: Kevin wrote, Tiger answered, Kevin again with Ava copied. */
const kevinThread = (id) => ({
  messages: [
    { messageId: "g1", threadId: id, labelIds: ["INBOX"], internalDate: "1760879640000", payload: { mimeType: "text/plain", headers: hdrs({ From: "Kevin Example <kevin@example.com>", To: "alex.home@example.net", Subject: "Invoice for October" }), body: { data: b64("The invoice for October looks wrong: 12 seats.") } } },
    { messageId: "g2", threadId: id, labelIds: ["SENT"], internalDate: "1760883240000", payload: { mimeType: "text/plain", headers: hdrs({ From: "Tiger <alex.home@example.net>", To: "kevin@example.com", Subject: "Re: Invoice for October" }), body: { data: b64("Looking now.") } } },
    { messageId: "g3", threadId: id, labelIds: ["INBOX"], internalDate: "1760886840000", payload: { mimeType: "text/html", headers: hdrs({ From: "Kevin Example <kevin@example.com>", To: "alex.home@example.net", Cc: "Ava Lee <ava@example.org>", Subject: "Re: Invoice for October" }), body: { data: b64("<p>Thanks!</p><script>alert(1)</script>") } } },
  ],
});
const NOT_FOUND = { error: "Requested entity was not found." };
/** Gmail: the thread in the account that has it (`where`: thread id to account), not found anywhere else. */
const gmailHas = (where) => {
  cx.tools.GMAIL_FETCH_MESSAGE_BY_THREAD_ID = { app: "gmail", tags: ["readOnlyHint"], answer: (a, acc) => (where[a.thread_id] === acc ? { data: kevinThread(a.thread_id) } : NOT_FOUND) };
  cx.tools.GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID = { app: "gmail", tags: ["readOnlyHint"], answer: () => NOT_FOUND };
};
const SLACK_THREAD = [
  { ts: TS, thread_ts: TS, user: "U01KEVIN", text: "The dashboard is down for <@U02AVA>" },
  { ts: "1700000060.000200", thread_ts: TS, user: "U02AVA", text: "Looking." },
];
const slackHas = () => {
  cx.tools.SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION = {
    app: "slack",
    tags: ["readOnlyHint"],
    answer: (a) => (a.channel !== "C0123ABCD" ? { error: "channel_not_found" } : a.ts === TS ? { data: { ok: true, messages: SLACK_THREAD } } : a.ts === "1700000060.000200" ? { data: { ok: true, messages: [SLACK_THREAD[1]] } } : { error: "thread_not_found" }),
  };
  cx.tools.SLACK_RETRIEVE_DETAILED_USER_INFORMATION = { app: "slack", tags: ["readOnlyHint"], answer: (a) => ({ data: { ok: true, user: { id: a.user, profile: { display_name: { U01KEVIN: "Kevin Example", U02AVA: "Ava Lee" }[a.user] } } } }) };
  cx.tools.SLACK_RETRIEVE_CONVERSATION_INFORMATION = { app: "slack", tags: ["readOnlyHint"], answer: () => ({ data: { ok: true, channel: { id: "C0123ABCD", name: "support" } } }) };
};
const ACCOUNTS = () => [
  { id: "ca_gmail_work", app: "gmail", appName: "Gmail", name: "alex@example.com", label: "Work", status: "active", at: 1, usedAt: 20, workspaceId: MAIN },
  { id: "ca_gmail_home", app: "gmail", appName: "Gmail", name: "alex.home@example.net", status: "active", at: 1, usedAt: 10, workspaceId: MAIN },
  { id: "ca_slack", app: "slack", appName: "Slack", name: "Acme", status: "active", at: 1, workspaceId: MAIN },
];
const withAccounts = (accounts = ACCOUNTS()) => S.update((s) => void (s.accounts = accounts));
/** A call to the source routes, from the Bops window unless `window` is false. */
const src = async (handler, method, path, { body, id, window = true } = {}) => {
  const init = { method, headers: { "content-type": "application/json", ...(window ? { "x-bops-window": WINDOW } : {}) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await handler(new Request(`http://localhost:3210${path}`, init), id ? { params: Promise.resolve({ id }) } : undefined);
  const out = { status: res.status, body: await res.json() };
  hear(out.body.error ?? "");
  return out;
};
const source = (id, q = "") => src(RS.GET, "GET", `/api/orbit/issues/${id}/source?ws=${MAIN}${q}`, { id });
const replyTo = (id, body, opts = {}) => src(RS.POST, "POST", `/api/orbit/issues/${id}/source`, { id, body: { ws: MAIN, ...body }, ...opts });
const ran = (k) => cx.ran.slice(k).map((r) => `${r.slug}@${r.account}`);
/** Every file under the throwaway folder (the state, the issues' cache), read as text. */
const everyFile = (dir = scratch) => {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...everyFile(p));
    else if (e.isFile()) out.push(readFileSync(p, "utf8"));
  }
  return out;
};
process.env.BOPS_UI_TOKEN = WINDOW;

let gmailIssue;
await check("an issue's email: read live in the account that has it (each tried, the issue's workspace and the most used first), kept a minute in memory only: nothing of it in the state or on disk", async () => {
  withAccounts();
  IS.sourceKeptForTests.clear();
  gmailHas({ [T_HOME]: "ca_gmail_home" });
  gmailIssue = (await open(MAIN, { title: "Kevin's invoice is wrong", sourceApp: "gmail", externalId: T_HOME, url: `https://mail.google.com/mail/u/0/#inbox/${T_HOME}` })).body.issue;
  const k = cx.ran.length;
  const r = await source(gmailIssue.id);
  assert.equal(r.status, 200);
  // Work first (used most recently): not there, nor as a message's id; then home, which has it.
  assert.deepEqual(ran(k), ["GMAIL_FETCH_MESSAGE_BY_THREAD_ID@ca_gmail_work", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID@ca_gmail_work", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID@ca_gmail_home"]);
  assert.deepEqual(cx.ran.at(-1).args, { thread_id: T_HOME, user_id: "me" });
  const s = r.body.source;
  assert.deepEqual([s.app, s.account.id, s.threadId, s.subject, s.messages.length], ["gmail", "ca_gmail_home", T_HOME, "Invoice for October", 3]);
  assert.equal(s.messages[1].mine, true, "the user's own, by its SENT label");
  assert.equal(s.messages[2].body, "Thanks!");
  assert.deepEqual(s.reply, { to: { name: "Kevin Example", email: "kevin@example.com" }, all: { to: [], cc: [{ name: "Ava Lee", email: "ava@example.org" }] } });
  // Again within the minute: from memory. Fresh: read again, in the account that had it.
  const k2 = cx.ran.length;
  assert.equal((await source(gmailIssue.id)).status, 200);
  assert.deepEqual(ran(k2), []);
  assert.equal((await source(gmailIssue.id, "&fresh=1")).status, 200);
  assert.deepEqual(ran(k2), ["GMAIL_FETCH_MESSAGE_BY_THREAD_ID@ca_gmail_home"]);
  // Nothing of what it says kept anywhere but memory.
  await S.flushState(5000);
  const files = everyFile();
  assert.ok(files.some((f) => f.includes("Kevin's invoice is wrong")), "the issues' cache on disk was looked at too");
  for (const text of [JSON.stringify(S.getState()), ...files]) assert.ok(!text.includes("looks wrong") && !text.includes("Thanks!"), "the email's words are nowhere on disk or in the state");
  assert.ok(!JSON.stringify(honcho.banks.get(BANK).sessions.get(gmailIssue.id)).includes("looks wrong"), "nor in memory's issue");
});

await check("the account the turn read the thread in is kept on the issue it opens (a routine's run: use_app, then orbit_issue_open), and its page reads there first", async () => {
  withAccounts();
  IS.sourceKeptForTests.clear();
  const T3 = "18c0aaaabbbbcccc";
  gmailHas({ [T3]: "ca_gmail_home" });
  cx.tools.GMAIL_FETCH_MESSAGE_BY_THREAD_ID.answer = (a, acc) => (a.thread_id === T3 && acc === "ca_gmail_home" ? { data: kevinThread(T3) } : NOT_FOUND);
  answers.push(
    calling(toolCall("use_app", { action: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", arguments: { thread_id: T3, user_id: "me" }, account: "alex.home" })),
    calling(toolCall("orbit_issue_open", { title: "Kevin again", summary: null, priority: null, tags: null, status: null, source_app: "gmail", external_id: T3, url: null, customer: "Kevin", note: null, last_message_at: null })),
    reply("NOTHING"),
  );
  await Chat.backgroundTurn("boppy", { routineId: "rtn_support", title: "Support watch", goal: "Read the support inbox.", quiet: true });
  const made = issueSessions(BANK).find((x) => x.metadata.externalId === T3);
  assert.ok(made, "opened");
  assert.equal(made.metadata.accountId, "ca_gmail_home");
  const k = cx.ran.length;
  const r = await source(made.id);
  assert.equal(r.status, 200);
  assert.deepEqual(ran(k), ["GMAIL_FETCH_MESSAGE_BY_THREAD_ID@ca_gmail_home"], "straight to the account it was read in");
  // A turn that read it in two accounts can't tell: nothing kept, the page tries each.
  const read = new RD.ReadLog();
  read.note("ca_gmail_work", { thread_id: "18c0ddddeeeeffff" }, {});
  read.note("ca_gmail_home", { thread_id: "18c0ddddeeeeffff" }, {});
  await O.runOrbitTool("boppy", "orbit_issue_open", { title: "Both", summary: null, priority: null, tags: null, status: null, source_app: "gmail", external_id: "18c0ddddeeeeffff", url: null, customer: null, note: null, last_message_at: null }, { readIn: (key) => read.accountsWith(key) });
  assert.equal(issueSessions(BANK).find((x) => x.metadata.externalId === "18c0ddddeeeeffff").metadata.accountId, undefined);
});

await check("what failed, in plain words: signed out (every account, or the one that could have it), gone, down, no account, an id that can't be read, an app it can't show", async () => {
  IS.sourceKeptForTests.clear();
  gmailHas({});
  withAccounts(ACCOUNTS().map((a) => (a.app === "gmail" ? { ...a, status: "expired" } : a)));
  let r = await source(gmailIssue.id);
  assert.deepEqual([r.status, r.body.code, r.body.error], [409, "signed_out", "Gmail is signed out. Sign in to Gmail again in Logins to see the email here."]);
  withAccounts();
  cx.tools.GMAIL_FETCH_MESSAGE_BY_THREAD_ID.answer = (a, acc) => (acc === "ca_gmail_work" ? { error: "401 Unauthorized: invalid_grant" } : NOT_FOUND);
  r = await source(gmailIssue.id);
  assert.deepEqual([r.status, r.body.code, r.body.error], [409, "signed_out", "Gmail (Work · alex@example.com) is signed out. Sign in to Gmail again in Logins to see the email here."]);
  gmailHas({});
  r = await source(gmailIssue.id);
  assert.deepEqual([r.status, r.body.code, r.body.error], [404, "gone", "This email isn't in your Gmail anymore."]);
  cx.tools.GMAIL_FETCH_MESSAGE_BY_THREAD_ID.answer = () => ({ error: "Service temporarily unavailable" });
  const k = cx.ran.length;
  r = await source(gmailIssue.id);
  assert.deepEqual([r.status, r.body.code, r.body.error], [502, "down", "Couldn't reach Gmail just now."]);
  assert.equal(ran(k).length, 1, "down for one is down for all: said at once");
  const discord = (await open(MAIN, { title: "Build red", sourceApp: "discord", externalId: "222222222222222222/333333333333333333" })).body.issue;
  r = await source(discord.id);
  assert.deepEqual([r.status, r.body.code, r.body.error], [409, "no_account", "No Discord bot is connected. Connect one in Logins to see the thread here."]);
  const tsOnly = (await open(MAIN, { title: "A ts alone", sourceApp: "slack", externalId: TS })).body.issue;
  r = await source(tsOnly.id);
  assert.deepEqual([r.status, r.body.code, r.body.error], [422, "unparsed", "Bops can't tell which Slack thread this is."]);
  const plain = (await open(MAIN, { title: "A ticket", sourceApp: "plain", externalId: "th_plain_1" })).body.issue;
  r = await source(plain.id);
  assert.deepEqual([r.status, r.body.code], [422, "unsupported"]);
  r = await source("issue-00000000-0000-4000-8000-000000000000");
  assert.deepEqual([r.status, r.body.code], [404, "gone"]);
});

let slackIssue;
await check("Slack: the thread from its channel and ts (a reply's ts finds its thread), people and the channel by name; Discord through a Discord bot", async () => {
  withAccounts();
  IS.sourceKeptForTests.clear();
  slackHas();
  slackIssue = (await open(MAIN, { title: "Dashboard down", sourceApp: "slack", externalId: `C0123ABCD:${TS}` })).body.issue;
  let r = await source(slackIssue.id);
  assert.equal(r.status, 200);
  const s = r.body.source;
  assert.deepEqual([s.app, s.account.id, s.channel, s.thread], ["slack", "ca_slack", { id: "C0123ABCD", name: "support" }, TS]);
  assert.deepEqual(s.messages.map((m) => [m.id, m.user.name]), [[TS, "Kevin Example"], ["1700000060.000200", "Ava Lee"]]);
  assert.deepEqual(s.names, { U01KEVIN: "Kevin Example", U02AVA: "Ava Lee" });
  const replyIssue = (await open(MAIN, { title: "From a reply", sourceApp: "slack", externalId: "x", url: "https://acme-example.slack.com/archives/C0123ABCD/p1700000060000200" })).body.issue;
  r = await source(replyIssue.id);
  assert.equal(r.body.source.thread, TS, "the reply's thread");
  assert.equal(r.body.source.messages.length, 2);
  // Discord, read with the Discord bot account the user connected.
  withAccounts([...ACCOUNTS(), { id: "ca_discordbot", app: "discordbot", appName: "Discord Bot", name: "Helper", status: "active", at: 1, workspaceId: MAIN }]);
  cx.tools.DISCORDBOT_LIST_MESSAGES = { app: "discordbot", tags: ["readOnlyHint"], answer: () => ({ data: { messages: [{ id: "333333333333333333", author: { id: "9", username: "ava" }, content: "Build is red", timestamp: "2026-10-20T10:00:00Z" }] } }) };
  cx.tools.DISCORDBOT_GET_CHANNEL = { app: "discordbot", tags: ["readOnlyHint"], answer: () => ({ data: { id: "222222222222222222", name: "builds" } }) };
  const discord = issueSessions(BANK).find((x) => x.metadata.sourceApp === "discord");
  const k = cx.ran.length;
  r = await source(discord.id);
  assert.equal(r.status, 200);
  assert.deepEqual(cx.ran.slice(k).map((x) => [x.slug, x.args]).sort(), [
    ["DISCORDBOT_GET_CHANNEL", { channel_id: "222222222222222222" }],
    ["DISCORDBOT_LIST_MESSAGES", { channel_id: "222222222222222222", limit: 50, around: "333333333333333333" }],
  ]);
  assert.deepEqual([r.body.source.channel, r.body.source.message], [{ id: "222222222222222222", name: "builds" }, "333333333333333333"]);
});

await check("only from the Bops window, and never with a shared workspace open: nothing read, nothing sent", async () => {
  withAccounts();
  IS.sourceKeptForTests.clear();
  gmailHas({ [T_HOME]: "ca_gmail_home" });
  const k = cx.ran.length;
  let r = await src(RS.GET, "GET", `/api/orbit/issues/${gmailIssue.id}/source?ws=${MAIN}`, { id: gmailIssue.id, window: false });
  assert.deepEqual([r.status, r.body.code, r.body.error], [403, "window", "Only the Bops app can show the original."]);
  r = await replyTo(gmailIssue.id, { text: "Hi", nonce: "nonce-window-0001" }, { window: false });
  assert.deepEqual([r.status, r.body.code], [403, "window"]);
  r = await src(RDS.GET, "GET", "/api/drafts/source?messageId=m&draftId=d", { window: false });
  assert.deepEqual([r.status, r.body.code], [403, "window"]);
  const g = globalThis;
  g.bopsShared = { user: S.stateUser(), key: g.bopsOrgoKey ?? null, copy: { openNow: () => ({ projectId: "p_owner" }), data: () => ({}), rev: 0, close() {} }, subscriber: { stop() {} }, moods: { forApp: () => ({}) } };
  try {
    r = await source(gmailIssue.id);
    assert.deepEqual([r.status, r.body.code, r.body.error], [403, "shared", "Only the workspace's owner can see the original."]);
    r = await replyTo(gmailIssue.id, { text: "Hi", nonce: "nonce-shared-0001" });
    assert.deepEqual([r.status, r.body.code], [403, "shared"]);
    r = await src(RDS.GET, "GET", "/api/drafts/source?messageId=m&draftId=d");
    assert.deepEqual([r.status, r.body.code], [403, "shared"]);
  } finally {
    g.bopsShared = null;
  }
  assert.deepEqual(ran(k), [], "Composio never asked");
});

await check("a reply from the page: in the thread, to the newest sender that isn't the user, from the account it was read in, once per click and one at a time; Reply all copies the others; its history says Replied", async () => {
  withAccounts();
  IS.sourceKeptForTests.clear();
  gmailHas({ [T_HOME]: "ca_gmail_home" });
  const sends = [];
  let gate = null;
  cx.tools.GMAIL_REPLY_TO_THREAD = { app: "gmail", answer: async (a, acc) => (sends.push({ a, acc }), await gate, { data: { id: "sent_1" } }) };
  assert.equal((await source(gmailIssue.id)).status, 200);
  let r = await replyTo(gmailIssue.id, { text: "  Fixed: it's 10 seats now.  ", nonce: "nonce-reply-0001" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.logged, r.body.sent.to], [true, true, "kevin@example.com"]);
  assert.deepEqual(sends, [{ acc: "ca_gmail_home", a: { thread_id: T_HOME, recipient_email: "kevin@example.com", message_body: "Fixed: it's 10 seats now.", is_html: false, user_id: "me" } }]);
  const h = (await one(MAIN, gmailIssue.id)).body.issue.history.at(-1);
  assert.deepEqual([h.kind, h.text, h.who], ["reply", "Replied: Fixed: it's 10 seats now.", "Tiger"]);
  // The same click again: refused, nothing sent.
  r = await replyTo(gmailIssue.id, { text: "Fixed: it's 10 seats now.", nonce: "nonce-reply-0001" });
  assert.deepEqual([r.status, r.body.error], [409, "It was sent already."]);
  assert.equal(sends.length, 1);
  // Reply all: Ava, who was copied, too.
  r = await replyTo(gmailIssue.id, { text: "Copying Ava.", all: true, nonce: "nonce-reply-0002" });
  assert.equal(r.status, 200);
  assert.deepEqual(sends[1].a, { thread_id: T_HOME, recipient_email: "kevin@example.com", message_body: "Copying Ava.", is_html: false, user_id: "me", cc: ["ava@example.org"] });
  assert.equal(r.body.sent.to, "kevin@example.com, ava@example.org");
  // Two at once (two clicks, two windows): one goes, the other waits its turn and is told so.
  let open_;
  gate = new Promise((x) => (open_ = x));
  const both = Promise.all([replyTo(gmailIssue.id, { text: "One", nonce: "nonce-reply-0003" }), replyTo(gmailIssue.id, { text: "Two", nonce: "nonce-reply-0004" })]);
  for (let n = 0; n < 50 && sends.length < 3; n++) await new Promise((x) => setTimeout(x, 5));
  open_();
  const [a, b] = await both;
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal([a, b].find((x) => x.status === 409).body.error, "A reply is being sent.");
  assert.equal(sends.length, 3);
  gate = null;
  // Words only, and within what the app takes; a click with no nonce isn't one.
  assert.deepEqual([(await replyTo(gmailIssue.id, { text: "   ", nonce: "nonce-reply-0005" })).status, (await replyTo(gmailIssue.id, { text: "x".repeat(50_001), nonce: "nonce-reply-0006" })).body.error], [400, "Gmail takes 50000 characters at most."]);
  assert.equal((await replyTo(gmailIssue.id, { text: "Hi" })).status, 400);
  // The app said no: why, and the history doesn't say it went.
  cx.tools.GMAIL_REPLY_TO_THREAD.answer = () => ({ error: "Invalid recipient" });
  const before = (await one(MAIN, gmailIssue.id)).body.issue.history.length;
  r = await replyTo(gmailIssue.id, { text: "Again", nonce: "nonce-reply-0007" });
  assert.deepEqual([r.status, r.body.error], [502, "Gmail didn't take it: Invalid recipient"]);
  assert.equal((await one(MAIN, gmailIssue.id)).body.issue.history.length, before);
  // Signed out since it was read: not sent, and why.
  withAccounts(ACCOUNTS().map((x) => (x.id === "ca_gmail_home" ? { ...x, status: "expired" } : x)));
  r = await replyTo(gmailIssue.id, { text: "Again", nonce: "nonce-reply-0008" });
  assert.deepEqual([r.status, r.body.code], [409, "signed_out"]);
  assert.equal(sends.length, 3);
  withAccounts();
});

await check("a Slack reply goes in its thread as the user (SLACK_SEND_MESSAGE with thread_ts), and its history says so", async () => {
  IS.sourceKeptForTests.clear();
  slackHas();
  const sent = [];
  cx.tools.SLACK_SEND_MESSAGE = { app: "slack", answer: (a, acc) => (sent.push({ a, acc }), { data: { ok: true, ts: "1700000999.000100" } }) };
  const r = await replyTo(slackIssue.id, { text: "On it, *rolling back* now.", nonce: "nonce-slack-0001" });
  assert.equal(r.status, 200);
  assert.deepEqual(sent, [{ acc: "ca_slack", a: { channel: "C0123ABCD", markdown_text: "On it, *rolling back* now.", thread_ts: TS } }]);
  assert.equal(r.body.sent.to, "#support");
  assert.equal((await one(MAIN, slackIssue.id)).body.issue.history.at(-1).text, "Replied: On it, *rolling back* now.");
});

await check("a drafted reply's thread (its card's Show the email): read only in the account the draft goes from, never another", async () => {
  withAccounts();
  IS.sourceKeptForTests.clear();
  gmailHas({ [T_HOME]: "ca_gmail_home" });
  S.update((s) =>
    s.messages.push({
      id: "m_drafted",
      chatId: botChatId("boppy"),
      role: "bot",
      botId: "boppy",
      text: "Two replies for you.",
      at: Date.now(),
      drafts: [
        { id: "drf_home", app: "gmail", accountId: "ca_gmail_home", threadId: T_HOME, to: "kevin@example.com", toName: "Kevin Example", text: "Yes." },
        { id: "drf_work", app: "gmail", accountId: "ca_gmail_work", threadId: T_HOME, to: "kevin@example.com", toName: "Kevin Example", text: "Yes." },
      ],
    }),
  );
  const k = cx.ran.length;
  let r = await src(RDS.GET, "GET", "/api/drafts/source?messageId=m_drafted&draftId=drf_home");
  assert.equal(r.status, 200);
  assert.equal(r.body.source.account.id, "ca_gmail_home");
  r = await src(RDS.GET, "GET", "/api/drafts/source?messageId=m_drafted&draftId=drf_work");
  assert.deepEqual([r.status, r.body.code], [404, "gone"]);
  assert.ok(!ran(k).slice(1).some((x) => x.endsWith("@ca_gmail_home")), "the work draft's thread isn't looked for elsewhere");
  r = await src(RDS.GET, "GET", "/api/drafts/source?messageId=m_drafted&draftId=nope");
  assert.deepEqual([r.status, r.body.error], [404, "That reply isn't here anymore."]);
  S.update((s) => void (s.messages = s.messages.filter((m) => m.id !== "m_drafted")));
  delete process.env.BOPS_UI_TOKEN;
});

await check("memory off, or signed out: no issues, and the routes say so", async () => {
  delete process.env.HONCHO_API_KEY;
  try {
    assert.equal(I.issuesOn(), false);
    assert.deepEqual((await list(MAIN)).body, { issues: [], tags: [], on: false });
    assert.deepEqual((await open(MAIN, { title: "x" })).status, 404);
    assert.deepEqual(O.ORBIT_TOOLS(S.bot("boppy")).filter((t) => t.name.startsWith("orbit_issue_")), []);
  } finally {
    process.env.HONCHO_API_KEY = "hc-test-issues";
  }
  assert.equal(I.issuesOn(), true);
});

await check("plain words, and nothing unexpected: no dashes, no stray warnings, no unknown Honcho calls about sessions, no rejections", () => {
  for (const s of spoken) noDashes(s, "in what was said");
  for (const file of ["lib/server/orbit-issues.ts", "lib/orbit-issues.ts", "lib/server/orbit.ts", "app/api/orbit/issues/route.ts", "app/api/orbit/issues/[id]/route.ts", "lib/server/issue-source.ts", "app/api/orbit/issues/[id]/source/route.ts", "app/api/drafts/source/route.ts"])
    readFileSync(join(root, file), "utf8")
      .split("\n")
      .forEach((line, n) => assert.ok(!/[–—]/.test(line), `${file}:${n + 1} has a dash`));
  assert.deepEqual(warned.filter((w) => /^\[issues\]/.test(w) && !/list: /.test(w)), []);
  assert.deepEqual(warned.filter((w) => /^\[source\]/.test(w) && !/Service temporarily unavailable/.test(w)), []);
  assert.deepEqual(honcho.unknown.filter((u) => /sessions/.test(u)), []);
  assert.deepEqual(rejections, []);
});

console.log(`\nOrbit issues: ${passed} passed, ${failures} failed`);
if (failures) console.log(`The throwaway folder is kept for a look: ${scratch}`);
else rmSync(scratch, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
