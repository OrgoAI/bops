import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
import type { CloudUsage } from "../protocol.ts";
import { reconcile, reconcileTiming } from "../reconcile.ts";
import { recordUsage } from "../usage.ts";
import { call, dropUsers, fakeOrgo, fakeProvider, keyOf, newUserId, prepareDb, seedUser, sse, startCloud, until, type Listening } from "./core-fakes.ts";

/**
 * What the cloud counts, once each, at its real price and for its bot (cloud/usage.ts, proxy.ts,
 * reconcile.ts): model answers with the bot and kind of work the Mac says, cache writes, agent turns
 * and helpers' turns at their own count, web searches, turns read back from OpenAI when the Mac never
 * saw them finish, and the account page's sums (GET /v1/usage). Against a fake OpenAI.
 */

const tag = randomUUID().slice(0, 8);
const alice = newUserId("usage");
const bob = newUserId("usage-bob");
let orgo: Listening, cloud: Listening, openai: Awaited<ReturnType<typeof fakeProvider>>;
let n = 0;

/** The turns OpenAI lists for a session when the cloud reads it back (reconcile.ts), by session. */
const listed = new Map<string, unknown[]>();
/** A turn's usage as OpenAI's later accounting has it. */
const usage = (input: number, output: number, cached = 0) => ({ input_tokens: input, output_tokens: output, input_tokens_details: { cached_tokens: cached }, output_tokens_details: { reasoning_tokens: 0 } });
const search = (id: string, action = "search", status = "completed") => ({ id, type: "web_search_call", status, action: { type: action } });

const rows = async (userId: string, kind: string) =>
  (
    await query<{ units: number; cost: number; detail: Record<string, unknown> }>(
      "SELECT units::float8 AS units, cost_micros::float8 AS cost, detail FROM bops.cloud_usage WHERE user_id = $1 AND kind = $2 ORDER BY id",
      [userId, kind],
    )
  ).rows;
const byRef = async (userId: string, kind: string, ref: string) => (await rows(userId, kind)).find((r) => r.detail.ref === ref);

before(async () => {
  await prepareDb();
  await Promise.all([seedUser(alice), seedUser(bob)]);
  orgo = await fakeOrgo();
  openai = await fakeProvider(async (g, res) => {
    if (g.method === "POST" && g.path === "/v1/responses") {
      const asked = (g.json ?? {}) as { input?: unknown; stream?: unknown };
      const id = `resp_${tag}_${++n}`;
      const response = {
        id,
        object: "response",
        model: "gpt-6.1-sol",
        // "searches": an answer that searched the web and read a page (a task on the computer tool, lib/server/computer-task.ts).
        output: asked.input === "searches" ? [search(`ws_${id}_1`), search(`ws_${id}_page`, "open_page"), { id: `msg_${id}`, type: "message" }] : [],
        // "long": one response past 272K input tokens.
        usage: { input_tokens: asked.input === "long" ? 300_000 : 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 400, cache_write_tokens: 500 }, output_tokens_details: { reasoning_tokens: 60 } },
      };
      // Streamed: its words come a while after it starts, and its count at the end.
      if (asked.stream)
        return void sse(res, [
          { type: "response.created", response: { ...response, usage: null } },
          new Promise((r) => setTimeout(r, 400)),
          { type: "response.output_text.delta", delta: "Hi" },
          new Promise((r) => setTimeout(r, 100)),
          { type: "response.completed", response },
        ]);
      return { json: response };
    }
    if (g.method === "POST" && g.path === "/v1/agents/sessions") return { json: { id: `asess_${tag}_${++n}`, object: "agent.session" } };
    const s = /^\/v1\/agents\/sessions\/([^/]+)\/(.+)$/.exec(g.path);
    if (s && g.method === "GET" && s[2] === "events")
      return void sse(res, [
        { type: "agent.session.turn.created", session_id: s[1], turn_id: `turn_${s[1]}_root`, turn: { id: `turn_${s[1]}_root`, subagent_id: null } },
        { type: "agent.session.subagent.created", session_id: s[1], subagent: { id: `sub_${s[1]}`, name: "Helper" } },
        { type: "agent.session.turn.created", session_id: s[1], turn_id: `turn_${s[1]}_helper`, turn: { id: `turn_${s[1]}_helper`, subagent_id: `sub_${s[1]}` } },
        { type: "agent.session.turn.item.done", session_id: s[1], turn_id: `turn_${s[1]}_root`, item: search(`ws_${s[1]}_1`) },
        { type: "agent.session.turn.item.done", session_id: s[1], turn_id: `turn_${s[1]}_root`, item: search(`ws_${s[1]}_page`, "open_page") },
        { type: "agent.session.turn.item.done", session_id: s[1], turn_id: `turn_${s[1]}_root`, item: search(`ws_${s[1]}_running`, "search", "in_progress") },
        // A helper's turn: the event's `usage` is the root agent's, the turn's own count is the helper's.
        {
          type: "agent.session.turn.completed",
          session_id: s[1],
          turn_id: `turn_${s[1]}_helper`,
          turn: { id: `turn_${s[1]}_helper`, subagent_id: `sub_${s[1]}`, usage: usage(5_000, 500) },
          usage: usage(600_000, 6_000, 540_000),
        },
        // The root turn: 30 requests of 20K input, 90% cached, summed (past 272K, but not one request is).
        { type: "agent.session.turn.completed", session_id: s[1], turn_id: `turn_${s[1]}_root`, turn: { id: `turn_${s[1]}_root`, usage: usage(600_000, 6_000, 540_000) }, usage: usage(600_000, 6_000, 540_000) },
      ]);
    if (s && g.method === "POST" && s[2] === "events") return { json: {} };
    if (s && g.method === "GET" && s[2] === "items") return { json: { data: [search(`ws_${s[1]}_listed`), { id: "msg_1", type: "message" }], has_more: false } };
    // What the cloud reads back by itself (reconcile.ts), page by page.
    if (s && g.method === "GET" && s[2] === "turns") {
      const all = listed.get(s[1]);
      if (!all) return { status: 404, json: { error: "no such session" } };
      const after = g.query.get("after");
      const from = after ? all.findIndex((t) => (t as { id: string }).id === after) + 1 : 0;
      return { json: { data: all.slice(from, from + 2), has_more: from + 2 < all.length } };
    }
    if (s && g.method === "GET" && s[2] === "subagents") return { json: { data: listed.has(s[1]) ? [{ id: `sub_${s[1]}`, object: "agent.session.subagent" }] : [], has_more: false } };
    if (s && g.method === "GET" && /^subagents\/[^/]+\/items$/.test(s[2])) return { json: { data: [search(`ws_${s[1]}_helper`)], has_more: false } };
    return { status: 418, json: { error: "the fake doesn't know this" } };
  });
  Object.assign(process.env, { OPENAI_API_KEY: "sk-test-main", BOPS_UPSTREAM_OPENAI: openai.url });
  cloud = await startCloud();
});

after(async () => {
  await dropUsers([alice, bob]);
  await Promise.all([cloud?.close(), orgo?.close(), openai?.close()]);
  await closeDb();
});

const as = (userId: string, method: string, path: string, json?: unknown, headers: Record<string, string> = {}) => call(cloud.url, method, path, { key: keyOf(userId), json, headers });

test("a model's answer is counted once, for the bot and the kind of work the Mac says, with its cache writes at their own price", async () => {
  const r = await as(alice, "POST", "/proxy/openai/v1/responses", { model: "gpt-6.1-sol", input: "hi" }, { "x-bops-bot": "sam", "x-bops-source": "chat" });
  assert.equal(r.status, 200, r.text);
  assert.equal(openai.got.at(-1)!.headers["x-bops-bot"], undefined, "who it's for never reaches OpenAI");
  assert.equal(openai.got.at(-1)!.headers["x-bops-source"], undefined);
  const row = await until(() => byRef(alice, "openai.tokens", r.json.id));
  assert.deepEqual(
    { units: row.units, source: row.detail.source, botId: row.detail.botId, cached: row.detail.cached, cacheWrite: row.detail.cacheWrite, reasoning: row.detail.reasoning },
    { units: 1100, source: "chat", botId: "sam", cached: 400, cacheWrite: 500, reasoning: 60 },
  );
  // 100 plain input at $2, 400 cached at $0.10, 500 written to the cache at $2.50, 100 output at $10 (per 1M).
  assert.equal(row.cost, 100 * 2 + 400 * 0.1 + 500 * 2.5 + 100 * 10);
  // A header that isn't a plain short name isn't kept.
  const odd = await as(alice, "POST", "/proxy/openai/v1/responses", { model: "gpt-6.1-sol", input: "hi" }, { "x-bops-bot": "a b<script>", "x-bops-source": "Chat!" });
  const oddRow = await until(() => byRef(alice, "openai.tokens", odd.json.id));
  assert.deepEqual([oddRow.detail.botId, oddRow.detail.source], [undefined, "responses"]);
  // The Mac can't name the cloud's own kinds of work: "agent" (a summed turn, never long context) would make one long answer cheaper.
  const long = await as(alice, "POST", "/proxy/openai/v1/responses", { model: "gpt-6.1-sol", input: "long" }, { "x-bops-source": "agent" });
  const longRow = await until(() => byRef(alice, "openai.tokens", long.json.id));
  assert.equal(longRow.detail.source, "responses");
  // Past 272K in one response: input, cached and cache writes twice, output half as much again.
  assert.equal(longRow.cost, ((300_000 - 400 - 500) * 2 + 400 * 0.1 + 500 * 2.5) * 2 + 100 * 10 * 1.5);
});

test("a model's answer's web searches are counted once each, for its bot, streamed or not (a task on the computer tool searches in Responses)", async () => {
  const r = await as(alice, "POST", "/proxy/openai/v1/responses", { model: "gpt-6.1-sol", input: "searches" }, { "x-bops-bot": "iris", "x-bops-source": "session" });
  assert.equal(r.status, 200, r.text);
  const searched = await until(() => byRef(alice, "openai.web_search", `ws_${r.json.id}_1`));
  assert.deepEqual([searched.units, searched.cost, searched.detail.botId], [1, 10_000, "iris"]);
  // Reading a page it found is free (OpenAI bills searches).
  const read = await until(() => byRef(alice, "openai.web_search", `ws_${r.json.id}_page`));
  assert.deepEqual([read.units, read.cost], [0, 0]);

  // Streamed: its searches are in the response as it starts too, but they're counted once, when it's done.
  const streamed = await fetch(`${cloud.url}/proxy/openai/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${keyOf(alice)}`, "content-type": "application/json", "x-bops-bot": "iris", "x-bops-source": "session" },
    body: JSON.stringify({ model: "gpt-6.1-sol", input: "searches", stream: true }),
  });
  const id = /"id":"(resp_[^"]+)"/.exec(await streamed.text())?.[1];
  assert.ok(id, "the stream names its response");
  await until(() => byRef(alice, "openai.web_search", `ws_${id}_1`));
  await new Promise((r) => setTimeout(r, 300));
  const all = (await rows(alice, "openai.web_search")).filter((x) => String(x.detail.ref).startsWith(`ws_${id}`));
  assert.deepEqual(all.map((x) => [x.detail.ref, x.units]).sort(), [[`ws_${id}_1`, 1], [`ws_${id}_page`, 0]]);
});

test("a streamed answer the Mac stopped reading is still read to the end and counted (OpenAI bills it)", async () => {
  const asked = openai.got.length;
  await fetch(`${cloud.url}/proxy/openai/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${keyOf(alice)}`, "content-type": "application/json", "x-bops-bot": "sam", "x-bops-source": "chat" },
    body: JSON.stringify({ model: "gpt-6.1-sol", input: "hi", stream: true }),
    signal: AbortSignal.timeout(150),
  })
    .then((r) => r.text())
    .catch(() => null);
  await until(() => openai.got.length > asked, "OpenAI to be asked");
  const id = `resp_${tag}_${n}`;
  const row = await until(() => byRef(alice, "openai.tokens", id), "the answer to be counted", 3_000);
  assert.deepEqual([row.units, row.detail.botId, row.detail.source], [1100, "sam", "chat"]);
});

test("a task's turns: each once at its own count (a helper's too), for the session's bot, never at long-context rates; and its web searches", async () => {
  const made = await as(alice, "POST", "/proxy/openai/v1/agents/sessions", { agent: { model: "gpt-6.1-sol" } }, { "x-bops-bot": "sam" });
  assert.equal(made.status, 200, made.text);
  const session = made.json.id as string;
  const kept = (await query("SELECT bot_id, model, used_at FROM bops.cloud_objects WHERE provider = 'openai' AND object_id = $1", [session])).rows[0];
  assert.deepEqual([kept.bot_id, kept.model, !!kept.used_at], ["sam", "gpt-6.1-sol", true]);
  // The Mac reads the stream without saying the bot: the session's is used.
  assert.equal((await as(alice, "GET", `/proxy/openai/v1/agents/sessions/${session}/events`)).status, 200);
  const root = await until(() => byRef(alice, "openai.tokens", `turn_${session}_root`));
  assert.deepEqual([root.units, root.detail.source, root.detail.botId], [606_000, "agent", "sam"]);
  // 60,000 plain input at $2, 540,000 cached at $0.10, 6,000 output at $10: not doubled as one 600K request would be.
  assert.equal(root.cost, 60_000 * 2 + 540_000 * 0.1 + 6_000 * 10);
  const helper = await until(() => byRef(alice, "openai.tokens", `turn_${session}_helper`));
  assert.deepEqual([helper.units, helper.cost, helper.detail.botId], [5_500, 5_000 * 2 + 500 * 10, "sam"], "the helper's own count, not the root's");
  // Web searches: a search is a $0.01 tool call, opening a page isn't charged, one still running isn't counted yet.
  const searches = await until(async () => {
    const r = (await rows(alice, "openai.web_search")).filter((x) => String(x.detail.ref).startsWith(`ws_${session}`));
    return r.length >= 2 && r;
  });
  // Counted on the side, so in whatever order they land.
  assert.deepEqual(
    searches.map((x) => [x.detail.ref, x.detail.action, x.units, x.cost, x.detail.botId]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    // A page opened is kept, as no search: the account page's count of searches is what OpenAI bills.
    [
      [`ws_${session}_1`, "search", 1, 10_000, "sam"],
      [`ws_${session}_page`, "open_page", 0, 0, "sam"],
    ],
  );
  // The same searches seen again (the stream once more, the items list) are never counted twice; a new one in the list is.
  assert.equal((await as(alice, "GET", `/proxy/openai/v1/agents/sessions/${session}/events`)).status, 200);
  assert.equal((await as(alice, "GET", `/proxy/openai/v1/agents/sessions/${session}/items`)).status, 200);
  await until(async () => await byRef(alice, "openai.web_search", `ws_${session}_listed`));
  await new Promise((r) => setTimeout(r, 100));
  const all = (await rows(alice, "openai.web_search")).filter((x) => String(x.detail.ref).startsWith(`ws_${session}`));
  assert.equal(all.length, 3);
  assert.equal((await rows(alice, "openai.tokens")).filter((x) => String(x.detail.ref).startsWith(`turn_${session}`)).length, 2);
});

test("turns the Mac never saw finish are read back from OpenAI, counted once, and counted up when OpenAI's own count grows", async () => {
  Object.assign(reconcileTiming, { afterMs: 0, batch: 1000 });
  const made = await as(bob, "POST", "/proxy/openai/v1/agents/sessions", { agent: { model: "gpt-6.1-sol" } }, { "x-bops-bot": "iris" });
  const session = made.json.id as string;
  // The Mac saw the first turn end (from the stream), then the app quit.
  assert.equal((await as(bob, "GET", `/proxy/openai/v1/agents/sessions/${session}/events`)).status, 200);
  const seen = await until(() => byRef(bob, "openai.tokens", `turn_${session}_root`));
  // OpenAI's list: that turn with a later count, one the Mac never saw, and one still running.
  listed.set(session, [
    { id: `turn_${session}_root`, object: "agent.session.turn", status: "completed", usage: usage(610_000, 6_000, 540_000) },
    { id: `turn_${session}_unseen`, object: "agent.session.turn", status: "completed", usage: usage(2_000, 300) },
    { id: `turn_${session}_running`, object: "agent.session.turn", status: "in_progress", usage: null },
  ]);
  await query("UPDATE bops.cloud_objects SET used_at = now() - interval '6 minutes' WHERE object_id = $1", [session]);
  assert.equal(await reconcile([bob]), 1);
  const root = await byRef(bob, "openai.tokens", `turn_${session}_root`);
  assert.equal(root!.units, 616_000);
  assert.equal(root!.cost, seen.cost + 10_000 * 2, "only what's new is taken: 10,000 more plain input");
  const unseen = await byRef(bob, "openai.tokens", `turn_${session}_unseen`);
  assert.deepEqual([unseen!.units, unseen!.cost, unseen!.detail.botId, unseen!.detail.source], [2_300, 2_000 * 2 + 300 * 10, "iris", "agent"]);
  // The helper's search, which only the cloud's own read found.
  assert.equal((await byRef(bob, "openai.web_search", `ws_${session}_helper`))?.cost, 10_000);
  const state = async () => (await query("SELECT checked_at IS NOT NULL AS checked, settled_at IS NOT NULL AS settled FROM bops.cloud_objects WHERE object_id = $1", [session])).rows[0];
  assert.deepEqual(await state(), { checked: true, settled: false }, "a turn still runs: it's read again next sweep");
  // Read again: nothing is counted twice (the root, its helper from the stream, and the unseen turn),
  // however long ago it was first counted (a task picked back up after a week lists its old turns too).
  await query("UPDATE bops.cloud_usage SET at = now() - interval '10 days' WHERE user_id = $1", [bob]);
  const paid = (await rows(bob, "openai.tokens")).reduce((s, r) => s + r.cost, 0);
  assert.equal(await reconcile([bob]), 1);
  assert.equal((await rows(bob, "openai.tokens")).length, 3);
  assert.equal((await rows(bob, "openai.tokens")).reduce((s, r) => s + r.cost, 0), paid);
  assert.equal((await rows(bob, "openai.web_search")).filter((r) => r.detail.ref === `ws_${session}_helper`).length, 1);
  // It finishes; the next read counts it and the session is settled until it gets more work, or a day passes.
  listed.get(session)![2] = { id: `turn_${session}_running`, object: "agent.session.turn", status: "completed", usage: usage(1_000, 100) };
  assert.equal(await reconcile([bob]), 1);
  assert.equal((await byRef(bob, "openai.tokens", `turn_${session}_running`))?.units, 1_100);
  assert.deepEqual(await state(), { checked: true, settled: true });
  assert.equal(await reconcile([bob]), 0, "settled: not read again");
  // More work (a message to the task): read again.
  assert.equal((await as(bob, "POST", `/proxy/openai/v1/agents/sessions/${session}/events`, { events: [] })).status, 200);
  await until(async () => (await query("SELECT used_at > checked_at AS fresh FROM bops.cloud_objects WHERE object_id = $1", [session])).rows[0].fresh);
  assert.equal(await reconcile([bob]), 1);
  // A day after its last input, once more for OpenAI's later accounting; past two days, never.
  await query("UPDATE bops.cloud_objects SET used_at = now() - interval '25 hours', checked_at = now() - interval '24 hours 30 minutes' WHERE object_id = $1", [session]);
  assert.equal(await reconcile([bob]), 1);
  await query("UPDATE bops.cloud_objects SET used_at = now() - interval '3 days', checked_at = NULL WHERE object_id = $1", [session]);
  assert.equal(await reconcile([bob]), 0);
  // A session OpenAI no longer has is settled as it is.
  const gone = await as(bob, "POST", "/proxy/openai/v1/agents/sessions", { agent: { model: "gpt-6.1-sol" } });
  await query("UPDATE bops.cloud_objects SET used_at = now() - interval '6 minutes' WHERE object_id = $1", [gone.json.id]);
  assert.equal(await reconcile([bob]), 1);
  assert.equal((await query("SELECT settled_at IS NOT NULL AS settled FROM bops.cloud_objects WHERE object_id = $1", [gone.json.id])).rows[0].settled, true);
});

test("GET /v1/usage sums the user's own rows by kind, by day in their time zone, and by bot; the totals add up", async () => {
  const u = newUserId("usage-sheet");
  await seedUser(u);
  try {
    const at = (iso: string) => query("UPDATE bops.cloud_usage SET at = $2 WHERE id = (SELECT max(id) FROM bops.cloud_usage WHERE user_id = $1)", [u, iso]);
    await recordUsage(u, "openai.tokens", 1100, { source: "chat", botId: "sam", model: "gpt-6.1-sol", input: 1000, cached: 0, output: 100 });
    await at("2026-10-02T06:30:00Z"); // Oct 1 in Los Angeles
    await recordUsage(u, "openai.tokens", 606_000, { source: "agent", botId: "iris", model: "gpt-6.1-sol", input: 600_000, cached: 540_000, output: 6_000 });
    await at("2026-10-02T18:00:00Z");
    await recordUsage(u, "typesafe.tokens", 1200, { model: "jev-1.13.0", input: 1200, output: 0 });
    await at("2026-10-02T18:00:00Z");
    await recordUsage(u, "agentphone.voice_seconds", 90, { botId: "sam" });
    await at("2026-10-03T18:00:00Z");
    await recordUsage(u, "openai.web_search", 1, { action: "search", botId: "iris" });
    await at("2026-10-03T18:00:00Z");
    await recordUsage(u, "composio.calls", 1, { tool: "GMAIL_SEND_EMAIL", botId: "sam" });
    await at("2026-10-03T18:00:00Z");
    // Outside the month asked for, and another user's: not in it.
    await recordUsage(u, "verify.sms", 1);
    await at("2026-09-20T18:00:00Z");
    await recordUsage(alice, "verify.sms", 1);
    const from = Date.parse("2026-10-01T07:00:00Z");
    const to = Date.parse("2026-11-01T07:00:00Z");
    const r = await as(u, "GET", `/v1/usage?from=${from}&to=${to}&tz=America/Los_Angeles`);
    assert.equal(r.status, 200, r.text);
    const sheet = r.json as CloudUsage;
    assert.equal(sheet.charged, false, "this cloud prices each use but takes nothing (BOPS_AI_CREDITS isn't on)");
    const cost = { chat: 1000 * 2 + 100 * 10, agent: 60_000 * 2 + 540_000 * 0.1 + 6_000 * 10, jev: 51, call: 195_000, search: 10_000 };
    assert.deepEqual(
      sheet.kinds.map((k) => [k.kind, k.source ?? null, k.units, k.count, k.costMicros]),
      [
        ["agentphone.voice_seconds", null, 90, 1, cost.call],
        ["composio.calls", null, 1, 1, 0],
        ["openai.tokens", "agent", 606_000, 1, cost.agent],
        ["openai.tokens", "chat", 1100, 1, cost.chat],
        ["openai.web_search", null, 1, 1, cost.search],
        ["typesafe.tokens", null, 1200, 1, cost.jev],
      ],
    );
    assert.equal(sheet.costMicros, cost.chat + cost.agent + cost.jev + cost.call + cost.search);
    assert.deepEqual(sheet.days, [
      { day: "2026-10-01", tokens: 1100, costMicros: cost.chat },
      { day: "2026-10-02", tokens: 606_000 + 1200, costMicros: cost.agent + cost.jev },
      { day: "2026-10-03", tokens: 0, costMicros: cost.call + cost.search },
    ]);
    const bots = Object.fromEntries(sheet.bots.map((b) => [String(b.botId), [b.tokens, b.callSeconds, b.costMicros]]));
    assert.deepEqual(bots, { iris: [606_000, 0, cost.agent + cost.search], sam: [1100, 90, cost.chat + cost.call], null: [1200, 0, cost.jev] });
    // Every way of cutting it adds up to the same total.
    for (const parts of [sheet.kinds, sheet.days, sheet.bots]) assert.equal(parts.reduce((s, p) => s + p.costMicros, 0), sheet.costMicros);
    assert.equal(sheet.days.reduce((s, d) => s + d.tokens, 0), sheet.bots.reduce((s, b) => s + b.tokens, 0));
    // A time zone Postgres doesn't know is UTC; a range that isn't one is a 400.
    assert.equal((await as(u, "GET", `/v1/usage?from=${from}&to=${to}&tz=Mars/Base`)).json.days[0].day, "2026-10-02");
    assert.equal((await as(u, "GET", `/v1/usage?from=${to}&to=${from}`)).status, 400);
    assert.equal((await call(cloud.url, "GET", `/v1/usage?from=${from}&to=${to}`)).status, 401);
  } finally {
    await dropUsers([u]);
  }
});

test("rows written before seconds were counted (call.minutes) are still a call's seconds for its bot on the account page", async () => {
  const u = newUserId("usage-old");
  await seedUser(u);
  try {
    await query(`INSERT INTO bops.cloud_usage (user_id, kind, units, detail, cost_micros) VALUES ($1, 'call.minutes', 1.5, '{"botId":"sam"}', 97500)`, [u]);
    await recordUsage(u, "agentphone.voice_seconds", 30, { botId: "sam" });
    const r = await as(u, "GET", `/v1/usage?from=${Date.now() - 86_400_000}&to=${Date.now() + 60_000}`);
    assert.equal(r.status, 200, r.text);
    const sheet = r.json as CloudUsage;
    assert.deepEqual(
      sheet.bots.map((b) => [b.botId, b.callSeconds, b.costMicros]),
      [["sam", 90 + 30, 97_500 + 65_000]],
    );
  } finally {
    await dropUsers([u]);
  }
});
