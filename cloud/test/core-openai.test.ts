import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { after, before, test } from "node:test";
import OpenAI from "openai";
import { SidebandWS } from "openai/resources/live/sideband/ws";
import { WebSocketServer } from "ws";
import { closeDb, objectOwner, ownObject, query } from "../db.ts";
import { dropUsers, fakeOrgo, fakeProvider, gate, keyOf, newUserId, prepareDb, rawCall, seedUser, sse, startCloud, until, type Listening } from "./core-fakes.ts";

/**
 * /proxy/openai, driven by the real OpenAI SDK pointed at the cloud the way the Mac points it
 * (baseURL <cloud>/proxy/openai/v1, the Orgo key as its API key), against a fake OpenAI.
 */

const tag = randomUUID().slice(0, 8);
const alice = newUserId("alice");
const bob = newUserId("bob");
let orgo: Listening, cloud: Listening, openai: Awaited<ReturnType<typeof fakeProvider>>;
let n = 0;
/** Holds a streamed response after its first event until the test lets it go. */
let streamHold: Promise<void> = Promise.resolve();
/** What the fake sideband saw: the Authorization of each connection. */
const sidebandAuth: string[] = [];

const sdk = (userId: string) => new OpenAI({ apiKey: keyOf(userId), baseURL: `${cloud.url}/proxy/openai/v1`, maxRetries: 0 });
/** A response's or turn's token row: its tokens, and what it cost (pricing.ts; "gpt-test" has no price there, so it's priced as gpt-6-astra). */
const tokensFor = async (ref: string) =>
  (await query("SELECT units::float8 AS units, cost_micros::float8 AS cost FROM bops.cloud_usage WHERE kind = 'openai.tokens' AND detail->>'ref' = $1", [ref])).rows;

before(async () => {
  await prepareDb();
  await Promise.all([seedUser(alice), seedUser(bob)]);
  orgo = await fakeOrgo();
  openai = await fakeProvider(async (g, res) => {
    if (g.method === "POST" && g.path === "/v1/responses") {
      const id = `resp_${tag}_${++n}`;
      if (g.json?.stream)
        return void sse(res, [
          { type: "response.created", response: { id, object: "response", status: "in_progress" } },
          streamHold,
          { type: "response.output_text.delta", delta: "hi" },
          { type: "response.completed", response: { id, object: "response", model: "gpt-test", usage: { input_tokens: 7, output_tokens: 3 } } },
        ]);
      return { json: { id, object: "response", model: "gpt-test", output: [], usage: { input_tokens: 10, output_tokens: 5 } }, headers: { "set-cookie": "a=b", "openai-organization": "org-orgo" } };
    }
    if (g.method === "POST" && g.path === "/v1/live/sessions") return { json: { session: { id: `rtc_${tag}_${++n}` }, transport: { type: "webrtc", sdp: "v=0" } } };
    if (g.method === "POST" && /^\/v1\/live\/sessions\/[^/]+\/(accept|reject|hangup)$/.test(g.path)) return { json: {} };
    if (g.method === "POST" && g.path === "/v1/agents/sessions") return { json: { id: `asess_${tag}_${++n}`, object: "agent.session", environment: { id: "env_1", remote_url: "wss://x" } } };
    const s = /^\/v1\/agents\/sessions\/([^/]+)\/(.+)$/.exec(g.path);
    if (s && g.method === "GET" && s[2] === "events")
      return void sse(res, [
        { type: "agent.session.turn.created", event_id: "e1", session_id: s[1], turn_id: `turn_${tag}_A`, turn: { id: `turn_${tag}_A`, subagent_id: null } },
        { type: "agent.session.subagent.created", event_id: "e2", subagent: { id: `sub_${tag}_A`, object: "agent.session.subagent", name: "Helper" } },
        { type: "agent.session.turn.created", event_id: "e3", session_id: s[1], turn_id: `turn_${tag}_B`, turn: { id: `turn_${tag}_B`, subagent_id: `sub_${tag}_A` } },
        { type: "agent.session.turn.completed", event_id: "e4", session_id: s[1], turn_id: `turn_${tag}_A`, turn: { id: `turn_${tag}_A` }, usage: { input_tokens: 100, output_tokens: 20 } },
        // Another session's event in the stream is never taken as this user's.
        { type: "agent.session.turn.created", event_id: "e5", session_id: "asess_someone_else", turn_id: `turn_${tag}_X`, turn: { id: `turn_${tag}_X` } },
      ]);
    if (s && g.method === "POST" && s[2] === "events") return { json: {} };
    if (s && g.method === "GET" && s[2].startsWith("turns/"))
      return { json: { id: s[2].slice(6), object: "agent.session.turn", status: "completed", usage: { input_tokens: 100, output_tokens: 20 } } };
    if (s && g.method === "GET" && s[2] === "items") return { json: { data: [{ id: "item_1", type: "message" }], has_more: false } };
    if (s && g.method === "GET" && s[2] === "subagents") return { json: { data: [{ id: `sub_${tag}_B`, object: "agent.session.subagent", name: "Second", status: "active" }], has_more: false } };
    if (s && g.method === "GET" && /^subagents\/[^/]+\/items$/.test(s[2])) return { json: { data: [], has_more: false } };
    return { status: 418, json: { error: "the fake doesn't know this" } };
  });
  // The call sideband: says hello, reports usage, and echoes what it's sent.
  const sidebands = new WebSocketServer({ noServer: true });
  openai.server.on("upgrade", (req, socket, head) => {
    sidebandAuth.push(String(req.headers.authorization));
    if (!/^\/v1\/live\/sessions\/[^/]+\/attach/.test(req.url ?? "")) return socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    sidebands.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: "session.started" }));
      ws.send(JSON.stringify({ type: "session.usage.updated", usage: { seconds: 42 } }));
      ws.on("message", (data) => ws.send(JSON.stringify({ type: "echo", got: JSON.parse(String(data)) })));
    });
  });
  Object.assign(process.env, { OPENAI_API_KEY: "sk-test-main", BOPS_UPSTREAM_OPENAI: openai.url });
  cloud = await startCloud();
});

after(async () => {
  await dropUsers([alice, bob]);
  await Promise.all([cloud?.close(), orgo?.close(), openai?.close()]);
  await closeDb();
});

test("a response goes out with the cloud's key, never the caller's, and is the user's", async () => {
  const r = await sdk(alice).responses.create({ model: "gpt-test", input: "hello" });
  const sent = openai.got.at(-1)!;
  assert.equal(sent.headers.authorization, "Bearer sk-test-main");
  assert.ok(!JSON.stringify(sent.headers).includes(keyOf(alice)), "the Orgo key never reaches OpenAI");
  assert.equal(await objectOwner("openai", r.id), alice);
  assert.deepEqual(await until(() => tokensFor(r.id).then((x) => x.length && x)), [{ units: 15, cost: 10 * 10 + 5 * 50 }]);
});

test("only a short list of the Mac's headers goes on; cookies and OpenAI's account headers don't come back", async () => {
  const res = await new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
    const { hostname, port } = new URL(cloud.url);
    const body = JSON.stringify({ model: "gpt-test", input: "hi" });
    const req = request(
      {
        hostname,
        port,
        method: "POST",
        path: "/proxy/openai/v1/responses",
        headers: {
          authorization: `Bearer ${keyOf(alice)}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          "openai-organization": "org-someone",
          "openai-project": "proj-someone",
          "api-key": "sk-someone",
          cookie: "session=1",
          "x-forwarded-for": "10.0.0.1",
          connection: "keep-alive, x-hop",
          "x-hop": "1",
          "openai-beta": "agents=v1",
          "x-stainless-lang": "js",
        },
      },
      (r) => {
        r.resume();
        r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
  assert.equal(res.status, 200);
  const sent = openai.got.at(-1)!.headers;
  for (const h of ["openai-organization", "openai-project", "api-key", "cookie", "x-forwarded-for", "x-hop"]) assert.equal(sent[h], undefined, h);
  assert.equal(sent.authorization, "Bearer sk-test-main");
  assert.equal(sent["openai-beta"], "agents=v1");
  assert.equal(sent["x-stainless-lang"], "js");
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(res.headers["openai-organization"], undefined);
});

test("previous_response_id and conversations must be the user's own", async () => {
  const mine = await sdk(alice).responses.create({ model: "gpt-test", input: "one" });
  await assert.rejects(sdk(bob).responses.create({ model: "gpt-test", input: "two", previous_response_id: mine.id }), { status: 404 });
  await assert.rejects(sdk(alice).responses.create({ model: "gpt-test", input: "two", previous_response_id: "resp_never_seen" }), { status: 404 });
  await assert.rejects(sdk(alice).responses.create({ model: "gpt-test", input: "two", conversation: "conv_someone" } as never), { status: 404 });
  // The same reference spelled another way is checked the same.
  await assert.rejects(sdk(bob).responses.create({ model: "gpt-test", input: "two", PreviousResponseId: mine.id } as never), { status: 404 });
  const next = await sdk(alice).responses.create({ model: "gpt-test", input: "two", previous_response_id: mine.id });
  assert.ok(next.id);
});

test("references to stored files, vector stores, items and prompts are refused; a tool's own schema isn't read", async () => {
  const refused = [
    { input: [{ role: "user", content: [{ type: "input_file", file_id: "file-someone" }] }] },
    { input: "x", tools: [{ type: "file_search", vector_store_ids: ["vs_someone"] }] },
    { input: [{ type: "item_reference", id: "msg_someone" }] },
    { input: [{ type: "reasoning", id: "rs_someone", summary: [] }] },
    { input: "x", prompt: { id: "pmpt_someone" } },
    { input: "x", tools: [{ type: "code_interpreter", container: "cntr_someone" }] },
  ];
  for (const body of refused) await assert.rejects(sdk(alice).responses.create({ model: "gpt-test", ...body } as never), { status: 403 }, JSON.stringify(body));
  const ok = await sdk(alice).responses.create({
    model: "gpt-test",
    input: "x",
    tools: [{ type: "function", name: "open", strict: false, parameters: { type: "object", properties: { file_id: { type: "string" } } } }],
    metadata: { conversation: "anything" },
  });
  assert.ok(ok.id);
});

test("a streamed response comes through event by event, and is the user's before the Mac sees it", async () => {
  const hold = gate();
  streamHold = hold.promise;
  const stream = await sdk(alice).responses.create({ model: "gpt-test", input: "hi", stream: true });
  const events = stream[Symbol.asyncIterator]();
  const first = (await events.next()).value as { type: string; response: { id: string } };
  assert.equal(first.type, "response.created");
  // OpenAI hasn't sent the rest yet: the first event wasn't waiting on the whole stream.
  assert.equal(await objectOwner("openai", first.response.id), alice);
  hold.open();
  const rest: string[] = [];
  for (let e = await events.next(); !e.done; e = await events.next()) rest.push((e.value as { type: string }).type);
  assert.deepEqual(rest, ["response.output_text.delta", "response.completed"]);
  assert.deepEqual(await until(() => tokensFor(first.response.id).then((x) => x.length && x)), [{ units: 10, cost: 7 * 10 + 3 * 50 }]);
});

test("the Agents API: a session, its event stream, turns, items and helpers, all the user's", async () => {
  const client = sdk(alice);
  const made = (await client.beta.agents.sessions.create({ agent: { model: "gpt-test" }, environment: { type: "self_hosted", workspace_directory: "/w" } } as never)) as unknown as { id: string };
  assert.equal(await objectOwner("openai", made.id), alice);
  const types: string[] = [];
  for await (const e of (await client.beta.agents.sessions.events.stream(made.id)) as AsyncIterable<{ type: string }>) types.push(e.type);
  assert.equal(types.length, 5);
  for (const id of [`turn_${tag}_A`, `turn_${tag}_B`, `sub_${tag}_A`]) assert.equal(await objectOwner("openai", id), alice, id);
  assert.equal(await objectOwner("openai", `turn_${tag}_X`), null, "another session's turn isn't recorded");
  await client.beta.agents.sessions.events.create(made.id, { events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: "go" }] }] }] } as never);
  await client.beta.agents.sessions.turns.retrieve(`turn_${tag}_A`, { session_id: made.id });
  // The turn's tokens came in its event and again when it was looked up: counted once, at its session's model.
  assert.deepEqual(await until(() => tokensFor(`turn_${tag}_A`).then((x) => x.length && x)), [{ units: 120, cost: 100 * 10 + 20 * 50 }]);
  assert.equal((await query("SELECT model FROM bops.cloud_objects WHERE provider = 'openai' AND object_id = $1", [made.id])).rows[0].model, "gpt-test");
  const items = [];
  for await (const item of client.beta.agents.sessions.items.list(made.id)) items.push(item);
  assert.equal(items.length, 1);
  for await (const h of client.beta.agents.sessions.subagents.list(made.id)) assert.equal(h.id, `sub_${tag}_B`);
  assert.equal(await objectOwner("openai", `sub_${tag}_B`), alice);
  for await (const item of client.beta.agents.sessions.subagents.items.list(`sub_${tag}_B`, { session_id: made.id })) assert.fail(`no items, got ${item.id}`);
});

test("another user's Agents API session, turn or helper is 404, and so is one the cloud never saw", async () => {
  const mine = (await sdk(alice).beta.agents.sessions.create({ agent: { model: "gpt-test" }, environment: { type: "self_hosted", workspace_directory: "/w" } } as never)) as unknown as { id: string };
  const theirs = (await sdk(bob).beta.agents.sessions.create({ agent: { model: "gpt-test" }, environment: { type: "self_hosted", workspace_directory: "/w" } } as never)) as unknown as { id: string };
  const asBob = sdk(bob);
  await assert.rejects(asBob.beta.agents.sessions.events.stream(mine.id), { status: 404 });
  await assert.rejects(asBob.beta.agents.sessions.events.create(mine.id, { events: [] } as never), { status: 404 });
  await assert.rejects(asBob.beta.agents.sessions.items.list(mine.id), { status: 404 });
  // His own session in the path doesn't make Alice's turn or helper his.
  await assert.rejects(asBob.beta.agents.sessions.turns.retrieve(`turn_${tag}_A`, { session_id: theirs.id }), { status: 404 });
  await assert.rejects(asBob.beta.agents.sessions.subagents.items.list(`sub_${tag}_A`, { session_id: theirs.id }), { status: 404 });
  await assert.rejects(asBob.beta.agents.sessions.items.list("asess_never_seen"), { status: 404 });
});

test("only the endpoints the app uses get through", async () => {
  const mine = await sdk(alice).responses.create({ model: "gpt-test", input: "x" });
  const client = sdk(alice);
  await assert.rejects(client.models.list(), { status: 403 });
  await assert.rejects(client.responses.retrieve(mine.id), { status: 403 });
  await assert.rejects(client.conversations.create({}), { status: 403 });
  await assert.rejects(client.files.list(), { status: 403 });
  await assert.rejects(client.beta.agents.sessions.list(), { status: 403 });
  await assert.rejects(client.vectorStores.list(), { status: 403 });
  assert.ok(!openai.got.some((g) => /^\/v1\/(models|conversations|files|vector_stores)/.test(g.path)));
});

test("paths are taken as written: dot segments, encoded slashes and empty segments are refused", async () => {
  const mine = (await sdk(alice).beta.agents.sessions.create({ agent: { model: "gpt-test" }, environment: { type: "self_hosted", workspace_directory: "/w" } } as never)) as unknown as { id: string };
  const theirs = (await sdk(bob).beta.agents.sessions.create({ agent: { model: "gpt-test" }, environment: { type: "self_hosted", workspace_directory: "/w" } } as never)) as unknown as { id: string };
  const tricks = [
    `/proxy/openai/v1/agents/sessions/${mine.id}/../${theirs.id}/items`,
    `/proxy/openai/v1/agents/sessions/${mine.id}/%2E%2E/${theirs.id}/items`,
    `/proxy/openai/v1/agents/sessions/${theirs.id}%2Fx/items`,
    `/proxy/openai/v1/agents/sessions/${mine.id}/./items`,
    `/proxy/openai/v1//agents/sessions/${mine.id}/items`,
    `/proxy/openai/v1/agents/sessions/${mine.id}\\..\\${theirs.id}/items`,
    `/proxy/agentphone/../openai/v1/agents/sessions/${theirs.id}/items`,
  ];
  for (const path of tricks) assert.equal((await rawCall(cloud.url, "GET", path, keyOf(alice))).status, 400, path);
  assert.equal((await rawCall(cloud.url, "GET", `/proxy/openai/v1/agents/sessions/${mine.id}/items`, keyOf(alice))).status, 200);
});

test("live sessions: accept, reject, hang up and attach only to the user's own", async () => {
  const call = `rtc_${tag}_phone`;
  await ownObject(alice, "openai", "live_session", call); // as /hooks/openai records an incoming call
  await sdk(alice).live.sessions.accept(call, { session: { type: "live", model: "gpt-live-1" } } as never);
  await assert.rejects(sdk(bob).live.sessions.accept(call, { session: { type: "live", model: "gpt-live-1" } } as never), { status: 404 });
  await assert.rejects(sdk(bob).live.sessions.reject(call, { status_code: 486 }), { status: 404 });
  await assert.rejects(sdk(bob).live.sessions.hangup(call), { status: 404 });
  // A call in the app: the session it makes is the user's.
  const inApp = (await sdk(alice).live.create({ session: { model: "gpt-live-1" }, transport: { type: "webrtc", sdp: "v=0" } } as never)) as unknown as { session: { id: string } };
  assert.equal(await objectOwner("openai", inApp.session.id), alice);
  await sdk(alice).live.sessions.hangup(inApp.session.id);

  // The sideband, from the SDK's own address for it.
  const sb = new SidebandWS(sdk(alice), { session_id: call });
  const events: { type: string; got?: unknown }[] = [];
  sb.on("event", (e) => events.push(e as never));
  await until(() => events.some((e) => e.type === "session.started"), "the sideband to open");
  sb.send({ type: "session.commentary.append", delegation_id: null, content: "hello" } as never);
  const echo = await until(() => events.find((e) => e.type === "echo"), "the echo");
  assert.deepEqual(echo.got, { type: "session.commentary.append", delegation_id: null, content: "hello" });
  assert.equal(sidebandAuth.at(-1), "Bearer sk-test-main");
  sb.close();
  const seconds = await until(async () => (await query("SELECT units::float8 AS units, cost_micros::float8 AS cost FROM bops.cloud_usage WHERE user_id = $1 AND kind = 'openai.live_seconds' AND detail->>'ref' = $2", [alice, call])).rows[0]);
  assert.deepEqual(seconds, { units: 42, cost: 42 * 895 });

  // Bob's sideband to Alice's call is refused before OpenAI is ever asked.
  const seen = sidebandAuth.length;
  const theirs = new SidebandWS(sdk(bob), { session_id: call });
  const failed = await new Promise<Error>((resolve) => theirs.on("error", resolve));
  assert.ok(failed);
  assert.equal(sidebandAuth.length, seen);
});

test("a body over 25 MB is refused", async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const { hostname, port } = new URL(cloud.url);
    const req = request(
      { hostname, port, method: "POST", path: "/proxy/openai/v1/responses", headers: { authorization: `Bearer ${keyOf(alice)}`, "content-type": "application/json", "content-length": String(26 * 1024 * 1024) } },
      (r) => {
        resolve(r.statusCode ?? 0);
        req.destroy();
      },
    );
    req.on("error", reject);
    req.write("{}");
  });
  assert.equal(status, 413);
});
