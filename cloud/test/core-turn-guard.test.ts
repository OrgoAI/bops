import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { WebSocketServer } from "ws";
import { creditLeft } from "../credit.ts";
import { closeDb, ownObject, query } from "../db.ts";
import { AI_CREDIT_EMPTY, AI_CREDIT_LOW } from "../protocol.ts";
import { guardClock, guardSweep, guardTiming, isWatched, KEEP_GOING, seed, startReserve } from "../turn-guard.ts";
import { LEDGER_IN_USE, TEST_DATABASE_URL, call, dropUsers, fakeOrgo, fakeProvider, keyOf, prepareDb, seedUser, startCloud, until, type Listening } from "./core-fakes.ts";

/**
 * Agent turns held to the user's AI credit while they run (cloud/turn-guard.ts): stopped once what
 * they're held at reaches what's left, paid when their use comes in, then set going again only when
 * that's safe, or left stopped with the Mac told why. Against orgo-web's ledger
 * (fixtures/orgo-bops-credit.sql) and a fake OpenAI whose turns the tests move along, with the Mac's
 * stream of a task kept open as the app keeps it.
 */

const tag = randomUUID().slice(0, 8);
const users: string[] = [];
let orgo: Listening, cloud: Listening;
let openai: Awaited<ReturnType<typeof fakeProvider>>;
let n = 0;
/** Held while this file uses the ledger (core-credit takes its access away for a moment otherwise). */
let ledger: pg.Client;

type FakeTurn = {
  id: string;
  object: "agent.session.turn";
  status: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  usage: unknown;
  subagent_id: string | null;
  seq: number;
};
/** Each fake session's turns, and how it behaves (a test's switches). */
const turns = new Map<string, FakeTurn[]>();
const modes = new Map<string, Set<string>>();
/** The Mac's open stream of each session, at the fake: the tests write OpenAI's events to it. */
const live = new Map<string, ServerResponse>();
/** Sessions whose first cancel the fake didn't carry out (mode "late-cancel"). */
const ignoredCancels = new Set<string>();

/** The guard's clock, which the fake OpenAI keeps too: advance() moves both on. */
let offset = 0;
guardClock.now = () => Date.now() + offset;
const now = () => Math.floor(guardClock.now() / 1000);
const advance = (seconds: number) => void (offset += seconds * 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const is = (session: string, mode: string) => !!modes.get(session)?.has(mode);
const turnOf = (id: string, status: string, startedAt: number, subagent: string | null = null): FakeTurn => ({
  id,
  object: "agent.session.turn",
  status,
  created_at: startedAt,
  started_at: startedAt,
  completed_at: null,
  usage: null,
  subagent_id: subagent,
  seq: ++n,
});
const finished = (t: FakeTurn, usage: unknown, completedAt = now()) => Object.assign(t, { status: "completed", completed_at: completedAt, usage });
/** What the cloud posted to a fake session (cancels, messages), in order. */
const posted = (session: string) =>
  openai.got.filter((g) => g.method === "POST" && g.path === `/v1/agents/sessions/${session}/events`).flatMap((g) => (g.json?.events ?? []) as { type: string; input?: unknown }[]);
const kinds = (session: string) => posted(session).map((e) => e.type.replace("agent.session.input.", ""));
/** The events of a streamed answer. */
const eventsIn = (text: string) =>
  text
    .split("\n\n")
    .map((e) => /^data: (.*)$/m.exec(e)?.[1])
    .filter((d): d is string => !!d)
    .map((d) => JSON.parse(d));
const as = (userId: string, method: string, path: string, json?: unknown) => call(cloud.url, method, path, { key: keyOf(userId), json });
const work = (text = "go") => ({ events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text }] }] }] });

/** OpenAI's event on the Mac's open stream of the session. */
function tell(session: string, event: Record<string, unknown>) {
  live.get(session)!.write(`event: ${event.type}\ndata: ${JSON.stringify({ session_id: session, ...event })}\n\n`);
}
const cancelledEvent = (turn: FakeTurn) => ({ type: "agent.session.turn.cancelled", turn_id: turn.id, turn: { ...turn, status: "cancelled" }, usage: null });

/** The Mac following a task's stream, as the app does while a thread works. */
async function macFollows(userId: string, session: string) {
  const mac = as(userId, "GET", `/proxy/openai/v1/agents/sessions/${session}/events`);
  await until(() => live.has(session), "the Mac's stream");
  return {
    tell: (event: Record<string, unknown>) => tell(session, event),
    /** What the Mac got, once the stream is over. */
    end: async () => {
      live.get(session)!.end();
      live.delete(session);
      return (await mac).text as string;
    },
  };
}

const setCredit = (userId: string, credit: number) => query("UPDATE public.bops_ai_credit SET free_micros = $2, plan_micros = 0 WHERE user_id = $1", [userId, credit]);

async function newUser(credit: number) {
  const id = randomUUID();
  users.push(id);
  await query("INSERT INTO public.profiles (id) VALUES ($1)", [id]);
  await seedUser(id);
  await creditLeft(id);
  await setCredit(id, credit);
  return id;
}

/** A task the Mac made through the cloud, at `model`, with its first turn running since `since` (when given). */
async function newTask(userId: string, opts: { model?: string; since?: number; modes?: string[] } = {}) {
  const made = await as(userId, "POST", "/proxy/openai/v1/agents/sessions", { agent: { model: opts.model ?? "gpt-6.1-sol" }, environment: { type: "none" } });
  assert.equal(made.status, 200, made.text);
  const task = made.json.id as string;
  modes.set(task, new Set(opts.modes ?? []));
  if (opts.since !== undefined) turns.get(task)!.push(turnOf(`turn_${task}_1`, "in_progress", opts.since));
  return task;
}
/** A sweep that comes after the last one (the clock moved on). */
async function sweep() {
  await sleep(5);
  await guardSweep();
}
/** Run with some of the guard's timing changed. */
async function timing<T>(change: Partial<typeof guardTiming>, run: () => Promise<T>): Promise<T> {
  const was = { ...guardTiming };
  Object.assign(guardTiming, change);
  try {
    return await run();
  } finally {
    Object.assign(guardTiming, was);
  }
}

/** orgo-web's ledger, in this throwaway database (made by its owner, bops_app here), one test file at a time. */
async function prepareLedger() {
  const sql = await readFile(fileURLToPath(new URL("./fixtures/orgo-bops-credit.sql", import.meta.url)), "utf8");
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  try {
    await c.query("SELECT pg_advisory_lock(hashtext('bops-edge-tests'))");
    await c.query(sql);
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtext('bops-edge-tests'))").catch(() => {});
    await c.end();
  }
}

before(async () => {
  await prepareDb();
  await prepareLedger();
  ledger = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await ledger.connect();
  await ledger.query("SELECT pg_advisory_lock_shared(hashtext($1))", [LEDGER_IN_USE]);
  process.env.BOPS_AI_CREDITS = "1";
  // Sweeps by hand; a stopped turn's use waited on for 3 seconds; a waiting turn read at every sweep.
  Object.assign(guardTiming, { everyMs: 40, settleMs: 3_000, waitingMs: 0 });
  orgo = await fakeOrgo();
  openai = await fakeProvider(async (g, res) => {
    if (g.method === "POST" && g.path === "/v1/agents/sessions") {
      const id = `asess_${tag}_${++n}`;
      turns.set(id, []);
      return { json: { id, object: "agent.session" } };
    }
    if (g.method === "POST" && g.path === "/v1/live/sessions") return { json: { session: { id: `rtc_${tag}_${++n}` } } };
    if (g.method === "POST" && /^\/v1\/live\/sessions\/[^/]+\/hangup$/.test(g.path)) return { json: {} };
    const s = /^\/v1\/agents\/sessions\/([^/]+)\/(.+)$/.exec(g.path);
    const list = s ? turns.get(s[1]) : undefined;
    if (!s || !list) return { status: 404, json: { error: { message: "No such session" } } };
    const [, session, rest] = s;
    if (g.method === "GET" && rest === "turns") {
      if (is(session, "failing")) return { status: 500, json: { error: { message: "boom" } } };
      // The newest first, a page at a time, as OpenAI lists them.
      const sorted = [...list].sort((a, b) => b.created_at - a.created_at || b.seq - a.seq);
      const limit = Number(g.query.get("limit") ?? 20);
      const after = g.query.get("after");
      const from = after ? sorted.findIndex((t) => t.id === after) + 1 : 0;
      return { json: { data: sorted.slice(from, from + limit), has_more: from + limit < sorted.length } };
    }
    if (g.method === "GET" && rest.startsWith("turns/")) {
      if (is(session, "failing-turn")) return { status: 500, json: { error: { message: "boom" } } };
      const t = list.find((x) => x.id === rest.slice(6));
      return t ? { json: t } : { status: 404, json: { error: { message: "No such turn" } } };
    }
    if (g.method === "GET" && rest === "events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      live.set(session, res);
      return;
    }
    if (g.method === "POST" && rest === "events") {
      const events = (g.json?.events ?? []) as { type: string }[];
      if (is(session, "failing-message") && events.some((e) => e.type === "agent.session.input.message")) return { status: 500, json: { error: { message: "boom" } } };
      if (is(session, "slow")) await sleep(300);
      for (const e of events) {
        if (e.type === "agent.session.input.cancel") {
          if (is(session, "late-cancel") && !ignoredCancels.has(session)) {
            ignoredCancels.add(session);
            continue;
          }
          for (const t of list.filter((x) => x.status === "in_progress")) {
            Object.assign(t, { status: "cancelled", completed_at: now() });
            // OpenAI may put the cancelled turn on the session's stream before it answers the cancel.
            if (is(session, "tells-first") && !t.subagent_id && live.has(session)) tell(session, cancelledEvent(t));
          }
        }
        if (e.type === "agent.session.input.message") list.push(turnOf(`turn_${session}_${list.length + 1}`, "in_progress", now()));
      }
      if (is(session, "tells-first")) await sleep(300);
      return { status: 202, json: {} };
    }
    return { status: 418, json: { error: "the fake doesn't know this" } };
  });
  // An in-app call's sideband: OpenAI reports two minutes of audio at once.
  const sidebands = new WebSocketServer({ noServer: true });
  openai.server.on("upgrade", (req, socket, head) => {
    if (!/^\/v1\/live\/sessions\/[^/]+\/attach$/.test(req.url ?? "")) return socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    sidebands.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ type: "session.usage.updated", usage: { seconds: 120 } })));
  });
  Object.assign(process.env, { OPENAI_API_KEY: "sk-test-main", BOPS_UPSTREAM_OPENAI: openai.url });
  cloud = await startCloud();
});

after(async () => {
  for (const r of live.values()) r.end();
  await dropUsers(users);
  await query("DELETE FROM public.bops_ai_credit_grants WHERE user_id = ANY($1::uuid[])", [users]);
  await query("DELETE FROM public.bops_ai_credit WHERE user_id = ANY($1::uuid[])", [users]);
  await query("DELETE FROM bops.cloud_accounts WHERE user_id = ANY($1::text[])", [users]);
  await query("DELETE FROM public.profiles WHERE id = ANY($1::uuid[])", [users]);
  await Promise.all([cloud?.close(), orgo?.close(), openai?.close(), ledger?.end()]);
  await closeDb();
});

const SOL = 500_000 / 60;
/** What a running turn is held at past its running time: the time to see it and stop it. */
const lead = () => (guardTiming.everyMs + guardTiming.stopMs) / 1000;

/* ---------------- Held, stopped, paid ---------------- */

test("a turn about to run past what the user has left is stopped and paid for, and with too little left the Mac is told how much", async () => {
  const u = await newUser(500_000);
  const task = await newTask(u, { since: now() - 20 });
  assert.ok(isWatched(task), "a task made through the cloud is watched");
  const turn = turns.get(task)![0];

  // 20 s in, held at (20 + the lead) × $0.50 a minute: under the $0.50 left, so it runs on.
  assert.ok((20 + lead()) * SOL < 500_000);
  await sweep();
  assert.deepEqual(kinds(task), []);

  // 60 s in, the hold reaches what's left: it's cancelled.
  advance(40);
  const mac = await macFollows(u, task);
  await sweep();
  assert.deepEqual(kinds(task), ["cancel"]);

  // The Mac's stream gets the cancelled turn, held until the cloud knows what next. Its use comes in ($0.48), and is paid.
  mac.tell(cancelledEvent(turn));
  turn.usage = { input_tokens: 0, output_tokens: 48_000 };
  await sweep();
  assert.equal(await creditLeft(u), 20_000);
  assert.deepEqual(kinds(task), ["cancel"], "$0.02 is no room to go on");

  const text = await mac.end();
  const ev = eventsIn(text).find((e) => e.turn_id === turn.id);
  assert.equal(ev.type, "agent.session.turn.failed");
  assert.equal(ev.turn.error.code, AI_CREDIT_LOW);
  assert.match(ev.turn.error.message, /more AI credit than you have left/);
  assert.doesNotMatch(ev.turn.error.message, /\$/, "no amounts: an older app sends it on by email, text or channel");
  assert.match(text, /^event: agent\.session\.turn\.failed\ndata: /m, "its type line says so too");
  assert.doesNotMatch(text, /turn\.cancelled/);
});

test("with no credit left at all, the Mac is told it's out (the app's out-of-credit message)", async () => {
  const u = await newUser(300_000);
  const task = await newTask(u, { since: now() - 60 });
  const turn = turns.get(task)![0];
  const mac = await macFollows(u, task);
  await sweep();
  assert.deepEqual(kinds(task), ["cancel"]);
  mac.tell(cancelledEvent(turn));
  turn.usage = { input_tokens: 0, output_tokens: 40_000 };
  await sweep();
  assert.equal(await creditLeft(u), -100_000, "the last seconds before the stop went past what was left");
  const ev = eventsIn(await mac.end()).find((e) => e.turn_id === turn.id);
  assert.equal(ev.type, "agent.session.turn.failed");
  assert.equal(ev.turn.error.code, AI_CREDIT_EMPTY);
});

test("one user's tasks share one balance: their holds add up, and every running one is stopped", async () => {
  const u = await newUser(1_000_000);
  const a = await newTask(u, { since: now() - 30 });
  const b = await newTask(u, { since: now() - 30 });
  await sweep();
  assert.deepEqual([...kinds(a), ...kinds(b)], []);
  advance(25);
  assert.ok(2 * (55 + lead()) * SOL >= 1_000_000);
  await sweep();
  assert.deepEqual([...kinds(a), ...kinds(b)], ["cancel", "cancel"]);
});

test("a finished turn is paid at once (and once), a task with nothing running is let go after a few sweeps, and work watches it again", async () => {
  const u = await newUser(5_000_000);
  const task = await newTask(u);
  turns.get(task)!.push(finished(turnOf(`turn_${task}_1`, "in_progress", now() - 30), { input_tokens: 0, output_tokens: 1_000 }));
  for (let i = 0; i < guardTiming.idleSweeps; i++) await sweep();
  assert.equal(isWatched(task), false);
  const rows = (await query<{ cost: number }>("SELECT cost_micros::float8 AS cost FROM bops.cloud_usage WHERE user_id = $1 AND kind = 'openai.tokens'", [u])).rows;
  assert.deepEqual(rows, [{ cost: 10_000 }]);
  assert.equal(await creditLeft(u), 4_990_000);

  const again = await as(u, "POST", `/proxy/openai/v1/agents/sessions/${task}/events`, work("again"));
  assert.equal(again.status, 202, again.text);
  assert.ok(isWatched(task));
});

/* ---------------- Set going again, or not ---------------- */

test("a task stopped while the user still has room keeps going while the Mac follows it, and its own turns lower its hold", async () => {
  const u = await newUser(1_000_000);
  const task = await newTask(u, { since: now() - 120 });
  const turn = turns.get(task)![0];
  const mac = await macFollows(u, task);
  await sweep();
  assert.deepEqual(kinds(task), ["cancel"]);
  mac.tell(cancelledEvent(turn));

  // It had spent $0.10 in its 2 minutes: $0.90 is left, room for a minute more at its hold.
  turn.usage = { input_tokens: 0, output_tokens: 10_000 };
  await sweep();
  assert.equal(await creditLeft(u), 900_000);
  assert.deepEqual(kinds(task), ["cancel", "message"]);
  assert.deepEqual(posted(task)[1].input, [{ role: "user", content: [{ type: "input_text", text: KEEP_GOING }] }]);

  // The Mac gets the cancelled turn as it came, and follows the task into its next turn.
  const ev = eventsIn(await mac.end()).find((e) => e.turn_id === turn.id);
  assert.equal(ev.type, "agent.session.turn.cancelled");

  // $0.10 over 120 s is 833 micro-dollars a second; half again is under gpt-6.1-sol's least, so it's held at that ($0.33 a minute).
  assert.equal(startReserve(task, "gpt-6.1-sol"), Math.ceil(((330_000 / 60) * (guardTiming.everyMs + guardTiming.stopMs)) / 1000));
});

test("a task nobody follows any more (the app quit, or its thread gave up) isn't set going again", async () => {
  const u = await newUser(1_000_000);
  const task = await newTask(u, { since: now() - 120 });
  await sweep();
  assert.deepEqual(kinds(task), ["cancel"]);
  turns.get(task)![0].usage = { input_tokens: 0, output_tokens: 10_000 };
  await sweep();
  assert.deepEqual(kinds(task), ["cancel"]);
});

test("the user's own Stop is never undone, whether it comes after the cloud's stop or just before it", async () => {
  // After: the cloud stopped it, then the user pressed Stop while that was being decided.
  const u = await newUser(1_000_000);
  const task = await newTask(u, { since: now() - 130 });
  const mac = await macFollows(u, task);
  await sweep();
  assert.deepEqual(kinds(task), ["cancel"]);
  const stop = await as(u, "POST", `/proxy/openai/v1/agents/sessions/${task}/events`, { events: [{ type: "agent.session.input.cancel" }] });
  assert.equal(stop.status, 202);
  turns.get(task)![0].usage = { input_tokens: 0, output_tokens: 10_000 };
  await sweep();
  await sweep();
  assert.deepEqual(kinds(task), ["cancel", "cancel"], "no Keep going");
  await mac.end();

  // Just before: the user's cancel hadn't landed when the cloud read the turn as running.
  const v = await newUser(1_000_000);
  const other = await newTask(v, { since: now() - 130, modes: ["late-cancel"] });
  const follows = await macFollows(v, other);
  await as(v, "POST", `/proxy/openai/v1/agents/sessions/${other}/events`, { events: [{ type: "agent.session.input.cancel" }] });
  await sweep();
  assert.deepEqual(kinds(other), ["cancel", "cancel"], "the user's, then the cloud's");
  turns.get(other)![0].usage = { input_tokens: 0, output_tokens: 10_000 };
  await sweep();
  assert.deepEqual(kinds(other), ["cancel", "cancel"], "no Keep going");
  await follows.end();
});

test("when only a helper was cancelled (the main turn had finished), nothing is set going again", async () => {
  const u = await newUser(1_000_000);
  const task = await newTask(u);
  const main = finished(turnOf(`turn_${task}_1`, "in_progress", now() - 300), { input_tokens: 0, output_tokens: 1_000 }, now() - 200);
  const helper = turnOf(`turn_${task}_h`, "in_progress", now() - 150, "sub_1");
  turns.get(task)!.push(main, helper);
  const mac = await macFollows(u, task);
  await sweep();
  assert.deepEqual(kinds(task), ["cancel"]);
  helper.usage = { input_tokens: 0, output_tokens: 5_000 };
  await sweep();
  assert.deepEqual(kinds(task), ["cancel"]);
  await mac.end();
});

test("a task is set going again at most a few times an hour, then stays stopped", async () => {
  await timing({ resumes: 1 }, async () => {
    const u = await newUser(1_000_000);
    const task = await newTask(u, { since: now() - 120 });
    const mac = await macFollows(u, task);
    await sweep();
    turns.get(task)![0].usage = { input_tokens: 0, output_tokens: 1_000 };
    await sweep();
    assert.deepEqual(kinds(task), ["cancel", "message"]);
    // Its next turn runs long against what's left: stopped again, and this time it stays stopped.
    const next = turns.get(task)!.at(-1)!;
    next.started_at = now() - 400;
    await sweep();
    assert.deepEqual(kinds(task), ["cancel", "message", "cancel"]);
    next.usage = { input_tokens: 0, output_tokens: 1_000 };
    await sweep();
    assert.deepEqual(kinds(task), ["cancel", "message", "cancel"]);
    await mac.end();
  });
});

/* ---------------- What the Mac's stream is told ---------------- */

test("when setting it going again fails, the Mac is told it stopped (not left waiting)", async () => {
  const u = await newUser(1_000_000);
  const task = await newTask(u, { since: now() - 130, modes: ["failing-message"] });
  const turn = turns.get(task)![0];
  const mac = await macFollows(u, task);
  await sweep();
  mac.tell(cancelledEvent(turn));
  turn.usage = { input_tokens: 0, output_tokens: 10_000 };
  await sweep();
  const ev = eventsIn(await mac.end()).find((e) => e.turn_id === turn.id);
  assert.equal(ev.type, "agent.session.turn.failed");
  assert.equal(ev.turn.error.code, AI_CREDIT_LOW);
});

test("a cancelled turn that reaches the Mac before OpenAI answers the cancel still gets the cloud's verdict", async () => {
  const u = await newUser(500_000);
  const task = await newTask(u, { since: now() - 70, modes: ["tells-first"] });
  const turn = turns.get(task)![0];
  const mac = await macFollows(u, task);
  await sweep();
  assert.deepEqual(kinds(task), ["cancel"]);
  turn.usage = { input_tokens: 0, output_tokens: 48_000 };
  await sweep();
  const ev = eventsIn(await mac.end()).find((e) => e.turn_id === turn.id);
  assert.equal(ev.type, "agent.session.turn.failed");
});

/* ---------------- Nothing slips past ---------------- */

test("a long main turn behind many helper turns is still held, and stopped, and its session never let go while it runs", async () => {
  await timing({ page: 20 }, async () => {
    const u = await newUser(50_000_000);
    const task = await newTask(u);
    const start = now() - 900;
    turns.get(task)!.push(turnOf(`turn_${task}_main`, "in_progress", start));
    for (let i = 0; i < 25; i++)
      turns.get(task)!.push(finished(turnOf(`turn_${task}_h${i}`, "in_progress", start + 10 + i * 30, "sub_x"), { input_tokens: 0, output_tokens: 100 }, start + 30 + i * 30));
    // The first read pages back to it; $50 covers its 15 minutes, so it runs on.
    await sweep();
    assert.deepEqual(kinds(task), []);
    // With $1 left, the newest page alone doesn't show it; it's read on its own, held, and stopped.
    await setCredit(u, 1_000_000);
    for (let i = 0; i < guardTiming.idleSweeps + 1; i++) await sweep();
    assert.deepEqual(kinds(task), ["cancel"]);
    assert.ok(isWatched(task));
  });
});

test("a message from a Mac that hangs up at once is still watched, held and stopped", async () => {
  const u = await newUser(5_000_000);
  const task = await newTask(u, { modes: ["slow"] });
  for (let i = 0; i < guardTiming.idleSweeps; i++) await sweep();
  assert.equal(isWatched(task), false, "an idle task is let go");
  const body = JSON.stringify(work());
  const { hostname, port } = new URL(cloud.url);
  await new Promise<void>((resolve) => {
    const sock = connect(Number(port), hostname, () =>
      sock.write(
        `POST /proxy/openai/v1/agents/sessions/${task}/events HTTP/1.1\r\nHost: ${hostname}:${port}\r\nAuthorization: Bearer ${keyOf(u)}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        () => setTimeout(() => (sock.destroy(), resolve()), 50),
      ),
    );
  });
  await until(() => kinds(task).length > 0, "the message reached OpenAI");
  assert.ok(isWatched(task));
  await until(() => turns.get(task)!.length > 0, "its turn");
  turns.get(task)!.at(-1)!.started_at = now() - 1200;
  await sweep();
  assert.deepEqual(kinds(task), ["message", "cancel"]);
});

test("a session with nothing open whose turns can't be read is read less often, then let go; one never read is kept", async () => {
  await timing({ maxErrors: 3 }, async () => {
    const u = await newUser(1_000_000);
    const task = await newTask(u);
    const never = await newTask(u, { modes: ["failing"] });
    await sweep();
    modes.get(task)!.add("failing");
    for (let i = 1; i <= 3; i++) {
      await guardSweep();
      await sleep(guardTiming.everyMs * 2 ** Math.min(i, 4) + 20);
    }
    assert.equal(isWatched(task), false);
    assert.equal(isWatched(never), true, "it got work, and nothing of it was ever seen");
  });
});

test("a turn that can't be read on its own is held as last seen, still running, and stopped", async () => {
  await timing({ page: 5 }, async () => {
    const u = await newUser(1_000_000);
    const task = await newTask(u);
    const start = now() - 20;
    const main = turnOf(`turn_${task}_main`, "in_progress", start);
    turns.get(task)!.push(main);
    // Newer helper turns push the main one off the newest page.
    for (let i = 0; i < 6; i++)
      turns.get(task)!.push(finished(turnOf(`turn_${task}_h${i}`, "in_progress", start + 1 + i, "sub_x"), { input_tokens: 0, output_tokens: 10 }, start + 2 + i));
    await sweep();
    assert.deepEqual(kinds(task), []);
    modes.get(task)!.add("failing-turn");
    advance(120);
    await sweep();
    assert.deepEqual(kinds(task), ["cancel"]);
  });
});

test("a session whose reads fail is held as last seen, and stopped with the user's others when it comes to that", async () => {
  const u = await newUser(1_000_000);
  const a = await newTask(u, { since: now() - 10 });
  const b = await newTask(u, { since: now() - 10 });
  await sweep();
  assert.deepEqual([...kinds(a), ...kinds(b)], []);
  modes.get(a)!.add("failing");
  advance(50);
  await sweep();
  assert.deepEqual(kinds(b), ["cancel"]);
  assert.deepEqual(kinds(a), ["cancel"], "its turn ran on all the while");
});

/* ---------------- What needs credit ---------------- */

test("cancelling a task never needs credit, giving it work does, and a new task needs room for its first seconds", async () => {
  const u = await newUser(0);
  const task = `asess_${tag}_owned_${++n}`;
  turns.set(task, []);
  await ownObject(u, "openai", "agent_session", task, "gpt-6.1-sol");

  const cancel = await as(u, "POST", `/proxy/openai/v1/agents/sessions/${task}/events`, { events: [{ type: "agent.session.input.cancel" }] });
  assert.equal(cancel.status, 202, cancel.text);
  const refused = await as(u, "POST", `/proxy/openai/v1/agents/sessions/${task}/events`, work("hi"));
  assert.equal(refused.status, 402);
  assert.equal(refused.json.code, AI_CREDIT_EMPTY);
  assert.deepEqual(kinds(task), ["cancel"], "refused work never reaches OpenAI");

  // $0.10 left: a gpt-6-astra task is held at $4 a minute, so it can't start (403: short, not out); gpt-6.1-sol's $0.50 can.
  await setCredit(u, 100_000);
  const astra = await as(u, "POST", "/proxy/openai/v1/agents/sessions", { agent: { model: "gpt-6-astra" }, environment: { type: "none" } });
  assert.equal(astra.status, 403);
  assert.equal(astra.json.code, AI_CREDIT_LOW);
  assert.deepEqual(astra.json.error.code, AI_CREDIT_LOW, "shaped like OpenAI's errors, so the app's OpenAI SDK keeps the code");
  assert.equal((await as(u, "POST", "/proxy/openai/v1/agents/sessions", { agent: { model: "gpt-6.1-sol" }, environment: { type: "none" } })).status, 200);
});

test("starts at the same moment share one balance: of many at once, only those the credit covers go through", async () => {
  // Room for exactly one gpt-6.1-sol start ($0.50 a minute for the lead's ~10 s), not two.
  const u = await newUser(100_000);
  const task = await newTask(u);
  await sweep();
  const tries = await Promise.all(Array.from({ length: 6 }, () => as(u, "POST", `/proxy/openai/v1/agents/sessions/${task}/events`, work())));
  assert.deepEqual(
    tries.map((t) => t.status).sort(),
    [202, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(kinds(task), ["message"]);
});

test("a message can't name a cheaper model for a task: it's held and paid at the model it was made with", async () => {
  const u = await newUser(5_000_000);
  const task = await newTask(u, { model: "gpt-6-astra" });
  for (let i = 0; i < guardTiming.idleSweeps; i++) await sweep();
  assert.equal(isWatched(task), false);
  const forged = await as(u, "POST", `/proxy/openai/v1/agents/sessions/${task}/events`, { ...work(), agent: { model: "gpt-6.1-sol" } });
  assert.equal(forged.status, 202, forged.text);
  assert.equal(startReserve(task, undefined), Math.ceil((4_000_000 / 60) * (guardTiming.everyMs + guardTiming.stopMs) / 1000));
});

test("a turn's time waiting (on the user, or queued) isn't held: only the running the cloud saw", async () => {
  const u = await newUser(1_000_000);
  const task = await newTask(u);
  const turn = turnOf(`turn_${task}_1`, "waiting", now() - 600);
  turns.get(task)!.push(turn);
  await sweep();
  // Ten minutes since it started, but it was waiting: running now, it's held for this sweep's worth and the lead, not $5.
  turn.status = "in_progress";
  await sweep();
  await sweep();
  assert.deepEqual(kinds(task), []);
});

test("a session with a turn last seen running is kept while its reads fail, and stopped once they come back", async () => {
  await timing({ maxErrors: 3 }, async () => {
    const u = await newUser(50_000_000);
    const task = await newTask(u, { since: now() - 100 });
    await sweep();
    modes.get(task)!.add("failing");
    for (let i = 1; i <= 4; i++) {
      await guardSweep();
      await sleep(guardTiming.everyMs * 2 ** Math.min(i, 4) + 20);
    }
    assert.ok(isWatched(task), "kept while its turn may still run");
    // Reads come back eight minutes on, with $1 left: the turn ran all along, so it's held for all of it, and stopped.
    await setCredit(u, 1_000_000);
    advance(500);
    modes.get(task)!.delete("failing");
    await guardSweep();
    assert.deepEqual(kinds(task), ["cancel"]);
  });
});

test("after a restart, a task replied to after it was seen finished is watched again (and one still finished isn't)", async () => {
  const u = await newUser(5_000_000);
  const replied = `asess_${tag}_replied_${++n}`;
  const done = `asess_${tag}_done_${++n}`;
  for (const s of [replied, done]) {
    turns.set(s, []);
    await ownObject(u, "openai", "agent_session", s, "gpt-6.1-sol");
  }
  // Read back and found finished a minute ago; one got a reply since.
  await query("UPDATE bops.cloud_objects SET used_at = now() - interval '2 minutes', checked_at = now() - interval '1 minute', settled_at = now() - interval '1 minute' WHERE object_id = ANY($1)", [[replied, done]]);
  await query("UPDATE bops.cloud_objects SET used_at = now() WHERE object_id = $1", [replied]);
  await seed();
  assert.equal(isWatched(replied), true);
  assert.equal(isWatched(done), false);
});

test("one user can have only so many tasks watched at once: past that, new ones are refused", async () => {
  await timing({ perUser: 2 }, async () => {
    const u = await newUser(5_000_000);
    await newTask(u);
    await newTask(u);
    const third = await as(u, "POST", "/proxy/openai/v1/agents/sessions", { agent: { model: "gpt-6.1-sol" }, environment: { type: "none" } });
    assert.equal(third.status, 429);
    // Someone else isn't held back by it.
    const v = await newUser(5_000_000);
    await newTask(v);
  });
});

test("an in-app call is hung up once its seconds use the credit up", async () => {
  const u = await newUser(50_000);
  const made = await as(u, "POST", "/proxy/openai/v1/live/sessions", { session: { model: "gpt-live-1" }, transport: { type: "webrtc", sdp: "v=0" } });
  assert.equal(made.status, 200, made.text);
  const id = made.json.session.id as string;
  // Two minutes at $0.05 a minute is $0.10, past the $0.05 left.
  await until(() => openai.got.some((g) => g.method === "POST" && g.path === `/v1/live/sessions/${id}/hangup`), "the hang-up");
  assert.equal(await creditLeft(u), -50_000);
});
