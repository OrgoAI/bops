import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { closeDb, query } from "../db.ts";
import { STATE_CONFLICT, WRONG_USER, type CloudMessagesPage, type CloudState, type CloudStateConflict, type CloudStateHead } from "../protocol.ts";
import { loadState, REMOVED_KEEP_DAYS, sweepRemovedMessages } from "../state.ts";
import { connectMac, dropUsers, fakeOrgo, keyOf, newUserId, prepareDb, startCloud, until, type Listening } from "./edge-fakes.ts";

/**
 * The app's state in the cloud (cloud/state.ts, protocol.ts): the blob written over its version, the
 * messages as rows, each user only ever their own, a big chat paged, builds from before still served
 * until a newer one writes, and the migration that moved the messages out of the blobs.
 */

let orgo: Listening;
let cloud: Listening;
const users: string[] = [];
const user = (what: string) => {
  const id = newUserId(what);
  users.push(id);
  return id;
};

before(async () => {
  await prepareDb();
  orgo = await fakeOrgo();
  cloud = await startCloud();
});

after(async () => {
  await cloud.close();
  await orgo.close();
  await dropUsers(users);
  await query("DELETE FROM bops.app_state_backups WHERE user_id = ANY($1::text[])", [users]);
  await closeDb();
});

/** A call as a newer build makes it: the key's user, named, protocol 2, from a device. `as`: name another user than the key's. */
function call(userId: string, path: string, init: { method?: string; body?: unknown; as?: string; device?: string; gzip?: boolean; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${keyOf(userId)}`,
    "x-bops-user": init.as ?? userId,
    "x-bops-protocol": "2",
    "x-bops-device": init.device ?? "mac-a",
    ...init.headers,
  };
  let body: string | Buffer | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
    if (init.gzip) {
      body = gzipSync(body);
      headers["content-encoding"] = "gzip";
    }
  }
  return fetch(`${cloud.url}${path}`, { method: init.method ?? "GET", headers, body });
}
const putState = (userId: string, base: number, state: Record<string, unknown>, init: Parameters<typeof call>[2] = {}) => call(userId, "/v1/state", { method: "PUT", body: { base, state }, ...init });
const postMessages = (userId: string, upsert: unknown[], remove: string[] = [], init: Parameters<typeof call>[2] = {}) =>
  call(userId, "/v1/messages", { method: "POST", body: { upsert, remove }, ...init });
const page = async (userId: string, after: number, limit?: number) =>
  (await (await call(userId, `/v1/messages?after=${after}${limit ? `&limit=${limit}` : ""}`)).json()) as CloudMessagesPage;
const headOf = async (userId: string) => (await (await call(userId, "/v1/state/head")).json()) as CloudStateHead;
const msg = (i: number, extra: Record<string, unknown> = {}) => ({ id: `msg_${String(i).padStart(6, "0")}`, chatId: "chat_boppy", role: "user", text: `hello ${i}`, at: 1_700_000_000_000 + i, ...extra });

test("a first write makes the state (base 0), and each write after goes over the version it read", async () => {
  const id = user("versions");
  assert.equal((await call(id, "/v1/state")).status, 404, "nothing yet");
  assert.deepEqual(await headOf(id), { version: 0, seq: 0, writer: null });

  let res = await putState(id, 0, { owner: { name: "A" }, bots: [{ id: "boppy", isMain: true }], messages: [msg(1)] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 1 });
  const got = (await (await call(id, "/v1/state")).json()) as CloudState;
  assert.deepEqual(got, { version: 1, seq: 0, protocol: 2, writer: "mac-a", state: { owner: { name: "A" }, bots: [{ id: "boppy", isMain: true }] } }, "messages never go in the blob");

  // Another Mac wrote first: 409 with what's there now, and nothing written.
  assert.equal((await putState(id, 1, { owner: { name: "B" } }, { device: "mac-b" })).status, 200);
  res = await putState(id, 1, { owner: { name: "A again" } });
  assert.equal(res.status, 409);
  const conflict = (await res.json()) as CloudStateConflict;
  assert.equal(conflict.code, STATE_CONFLICT);
  assert.deepEqual([conflict.version, conflict.state], [2, { owner: { name: "B" } }]);
  assert.deepEqual(await headOf(id), { version: 2, seq: 0, writer: "mac-b" });
  // Merged, and written over what's there now.
  assert.deepEqual(await (await putState(id, 2, { owner: { name: "A+B" } })).json(), { version: 3 });
  assert.deepEqual((await loadState(id))?.state, { owner: { name: "A+B" } });

  assert.equal((await putState(id, -1, {})).status, 400);
  assert.equal((await call(id, "/v1/state", { method: "PUT", body: { base: 3, state: [] } })).status, 400);
});

test("each user only ever reads and writes their own", async () => {
  const a = user("iso-a");
  const b = user("iso-b");
  await putState(a, 0, { owner: { name: "A" } });
  await postMessages(a, [msg(1), msg(2)]);

  assert.equal((await call(b, "/v1/state")).status, 404, "B has nothing");
  assert.deepEqual((await page(b, 0)).messages, [], "and none of A's messages");

  // B's key naming A: refused, whatever the call.
  for (const [path, init] of [
    ["/v1/state", {}],
    ["/v1/state/head", {}],
    ["/v1/messages?after=0", {}],
    ["/v1/state", { method: "PUT", body: { base: 1, state: { owner: { name: "B wrote this" } } } }],
    ["/v1/messages", { method: "POST", body: { upsert: [msg(9)], remove: ["msg_000001"] } }],
    ["/v1/state/backups", { method: "POST", body: {} }],
  ] as const) {
    const res = await call(b, path, { ...init, as: a });
    assert.equal(res.status, 409, `${init.method ?? "GET"} ${path}`);
    assert.equal(((await res.json()) as { code: string }).code, WRONG_USER);
  }
  // Calls only a newer build makes must name the user.
  assert.equal((await fetch(`${cloud.url}/v1/messages?after=0`, { headers: { Authorization: `Bearer ${keyOf(a)}` } })).status, 400);
  assert.equal((await fetch(`${cloud.url}/v1/state/head`)).status, 401);

  assert.deepEqual((await loadState(a))?.state, { owner: { name: "A" } }, "A's state as A left it");
  assert.deepEqual((await page(a, 0)).messages.map((m) => m.id), ["msg_000001", "msg_000002"]);
  assert.equal((await page(b, 0)).messages.length, 0);

  // B, as B, writing and removing messages with A's ids: B's own rows, A's untouched.
  assert.equal((await postMessages(b, [msg(1, { text: "B's own" })], ["msg_000002"])).status, 200);
  assert.deepEqual((await page(b, 0)).messages.map((m) => [m.id, (m.json as { text: string }).text]), [["msg_000001", "B's own"]]);
  assert.deepEqual((await page(a, 0)).messages.map((m) => [m.id, (m.json as { text: string }).text]), [["msg_000001", "hello 1"], ["msg_000002", "hello 2"]], "A's rows as A wrote them");
});

test("messages: written whole, read by what changed since a seq, removed as an empty row", async () => {
  const id = user("messages");
  let res = await postMessages(id, [msg(1), msg(2), msg(3)]);
  assert.equal(res.status, 200);
  const { seq: s1 } = (await res.json()) as { seq: number };
  assert.ok(s1 > 0);
  let p = await page(id, 0);
  assert.deepEqual(p.messages.map((m) => [m.id, m.json?.text]), [["msg_000001", "hello 1"], ["msg_000002", "hello 2"], ["msg_000003", "hello 3"]]);
  assert.equal(p.seq, s1);
  assert.equal(p.more, false);

  // The same message again changes nothing (no Mac reads it twice); a tapback on one is a new write.
  res = await postMessages(id, [msg(1), msg(2, { reactions: [{ by: "owner", type: "love", at: 5 }] })]);
  const { seq: s2 } = (await res.json()) as { seq: number };
  p = await page(id, s1);
  assert.deepEqual(p.messages.map((m) => m.id), ["msg_000002"]);
  assert.deepEqual(p.messages[0].json?.reactions, [{ by: "owner", type: "love", at: 5 }]);
  assert.equal(p.seq, s2);

  // Removed: from a seq on it comes as null; from the start it's left out.
  await postMessages(id, [], ["msg_000003", "msg_nobody"]);
  p = await page(id, s2);
  assert.deepEqual(p.messages.map((m) => [m.id, m.json]), [["msg_000003", null]]);
  assert.deepEqual((await page(id, 0)).messages.map((m) => m.id), ["msg_000001", "msg_000002"]);
  const h = await headOf(id);
  assert.equal(h.seq, p.seq);

  // Written again after its removal, it's back.
  await postMessages(id, [msg(3, { text: "back" })]);
  assert.deepEqual((await page(id, 0)).messages.map((m) => m.json?.text), ["hello 1", "hello 2", "back"]);

  // What isn't a message is refused; one too big too; nothing of a refused batch is written.
  assert.equal((await postMessages(id, [{ chatId: "x" }])).status, 400);
  assert.equal((await postMessages(id, [msg(7), msg(8, { text: "x".repeat(300 * 1024) })])).status, 413);
  assert.equal((await call(id, "/v1/messages", { method: "POST", body: { upsert: [], remove: [1] } })).status, 400);
  assert.equal((await page(id, 0)).messages.length, 3);
  assert.equal((await call(id, "/v1/messages?after=-1")).status, 400);
  assert.equal((await call(id, "/v1/messages?after=0&limit=0")).status, 400);
});

test("a big chat: written in batches, read back in pages, in order", async () => {
  const id = user("big-chat");
  const total = 12_000;
  const all = Array.from({ length: total }, (_, i) => msg(i, { text: `message ${i} `.repeat(8) }));
  const started = Date.now();
  for (let i = 0; i < total; i += 3000) assert.equal((await postMessages(id, all.slice(i, i + 3000), [], { gzip: true })).status, 200);
  const wrote = Date.now() - started;

  let after = 0;
  const seen: string[] = [];
  let pages = 0;
  for (;;) {
    const res = await call(id, `/v1/messages?after=${after}&limit=2000`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(res.headers.get("content-encoding"), "gzip", "pages come gzipped to a client that asks");
    const p = (await res.json()) as CloudMessagesPage;
    pages++;
    seen.push(...p.messages.map((m) => m.id));
    after = p.seq;
    if (!p.more) break;
  }
  assert.equal(pages, 6);
  assert.equal(seen.length, total);
  assert.deepEqual(seen, all.map((m) => m.id), "oldest first, none twice, none missing");
  // One more message is one row: the next read since the last seq is that one message.
  await postMessages(id, [msg(total)]);
  assert.deepEqual((await page(id, after)).messages.map((m) => m.id), [msg(total).id]);
  assert.ok(wrote < 30_000, `12,000 messages written in ${wrote} ms`);

  // A build from before still gets its whole state back, the messages in, in order.
  await putState(id, 0, { owner: { name: "Big" } });
  const old = await fetch(`${cloud.url}/v1/state`, { headers: { Authorization: `Bearer ${keyOf(id)}`, "accept-encoding": "gzip" } });
  assert.equal(old.headers.get("content-encoding"), "gzip");
  const body = (await old.json()) as { state: { messages: { id: string }[] } };
  assert.equal(body.state.messages.length, total + 1);
  assert.equal(body.state.messages[0].id, "msg_000000");
});

test("builds from before: their whole-state upload is taken until a newer build writes, then refused", async () => {
  const id = user("old-build");
  const oldPut = (state: Record<string, unknown>, version = 5) =>
    fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: { Authorization: `Bearer ${keyOf(id)}`, "content-type": "application/json" }, body: JSON.stringify({ version, state }) });
  assert.equal((await oldPut({ owner: { name: "Old" }, messages: [msg(1), msg(2), msg(3)] })).status, 200);
  // Kept apart, as a newer build reads it.
  const got = (await (await call(id, "/v1/state")).json()) as CloudState;
  assert.deepEqual([got.version, got.protocol, got.state], [5, 1, { owner: { name: "Old" } }]);
  assert.deepEqual((await page(id, 0)).messages.map((m) => m.id), ["msg_000001", "msg_000002", "msg_000003"]);
  // Its next upload is again the whole state: a message it no longer has is removed.
  assert.equal((await oldPut({ owner: { name: "Old" }, messages: [msg(1), msg(3)] }, 6)).status, 200);
  assert.deepEqual((await page(id, 0)).messages.map((m) => m.id), ["msg_000001", "msg_000003"]);

  // A newer build writes: from then on the old upload is refused, and nothing of it lands.
  assert.equal((await putState(id, 6, { owner: { name: "New" } })).status, 200);
  const refused = await oldPut({ owner: { name: "Old again" }, messages: [] }, 7);
  assert.equal(refused.status, 426);
  assert.match(((await refused.json()) as { error: string }).error, /Update Bops/);
  assert.deepEqual((await loadState(id))?.state, { owner: { name: "New" } });
  assert.equal((await page(id, 0)).messages.length, 2);
});

test("a write is told to the user's connected Mac, and only theirs", async () => {
  const a = user("notify-a");
  const b = user("notify-b");
  const macA = await connectMac(cloud.url, a);
  const macB = await connectMac(cloud.url, b);
  try {
    await putState(a, 0, { owner: { name: "A" } });
    await until(() => macA.frames.find((f) => f.t === "state" && f.version === 1), "A's Mac hearing of the write");
    const { seq } = (await (await postMessages(a, [msg(1)])).json()) as { seq: number };
    await until(() => macA.frames.find((f) => f.t === "state" && f.seq === seq), "A's Mac hearing of the message");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(macB.frames.filter((f) => f.t === "state").length, 0, "B's Mac hears nothing of A's");
  } finally {
    macA.ws.close();
    macB.ws.close();
  }
});

test("Start over keeps a copy of the whole state, messages and all", async () => {
  const id = user("backup");
  assert.equal((await call(id, "/v1/state/backups", { method: "POST", body: {} })).status, 404, "nothing to copy");
  await putState(id, 0, { owner: { name: "Kept" } });
  await postMessages(id, [msg(1), msg(2)]);
  const res = await call(id, "/v1/state/backups", { method: "POST", body: {} });
  assert.equal(res.status, 200);
  const r = await query<{ state: { owner: unknown; messages: { id: string }[] } }>("SELECT state FROM bops.app_state_backups WHERE user_id = $1", [id]);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0].state.owner, { name: "Kept" });
  assert.deepEqual(r.rows[0].state.messages.map((m) => m.id), ["msg_000001", "msg_000002"]);
});

test("removed messages are swept after 30 days; live ones never are; the user's highest seq swept is kept", async () => {
  const id = user("sweep");
  await postMessages(id, [msg(1), msg(2)]);
  await postMessages(id, [], ["msg_000001"]);
  const removed = (await query<{ seq: string }>("SELECT seq FROM bops.chat_messages WHERE user_id = $1 AND json IS NULL", [id])).rows[0];
  await query("UPDATE bops.chat_messages SET updated_at = now() - make_interval(days => $2) WHERE user_id = $1", [id, REMOVED_KEEP_DAYS + 1]);
  assert.ok((await sweepRemovedMessages()) >= 1, "it says how many went");
  const r = await query<{ id: string }>("SELECT id FROM bops.chat_messages WHERE user_id = $1", [id]);
  assert.deepEqual(r.rows.map((x) => x.id), ["msg_000002"]);
  // So a reader with an older cursor knows it missed a removal (cloud/agent.ts); a later sweep never moves it back.
  const kept = async () => Number((await query<{ seq: string }>("SELECT swept_seq AS seq FROM bops.app_state WHERE user_id = $1", [id])).rows[0].seq);
  assert.equal(await kept(), Number(removed.seq));
  await sweepRemovedMessages();
  assert.equal(await kept(), Number(removed.seq));
});

test("the migration moves messages out of the states already uploaded, and runs again safely", async () => {
  const id = user("migrate");
  // A row as a build from before left it, before 0010 ran.
  await query(`INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, $2::jsonb, 9)`, [
    id,
    JSON.stringify({ owner: { name: "M" }, messages: [msg(1), msg(2, { at: 1.5e12 + 0.5 }), { text: "no id" }, "not a message"] }),
  ]);
  const sql = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations", "0010_chat_messages.sql"), "utf8");
  await query(sql);
  await query(sql);
  assert.deepEqual((await loadState(id))?.state, { owner: { name: "M" } });
  const rows = (await query<{ id: string; chat_id: string; at: string }>("SELECT id, chat_id, at FROM bops.chat_messages WHERE user_id = $1 ORDER BY id", [id])).rows;
  assert.deepEqual(rows.map((x) => [x.id, x.chat_id, Number(x.at)]), [["msg_000001", "chat_boppy", 1_700_000_000_001], ["msg_000002", "chat_boppy", 1.5e12]]);
});

test("the migrations run in order, one per number: the messages' after 0009_usage, already applied in prod", async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations");
  // As cloud/db.ts migrate() takes them: by name, each recorded under its name without .sql.
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const numbers = files.map((f) => f.slice(0, 4));
  assert.equal(new Set(numbers).size, numbers.length, `two migrations share a number: ${files.join(", ")}`);
  assert.ok(files.indexOf("0010_chat_messages.sql") > files.indexOf("0009_usage.sql") && files.includes("0009_usage.sql"));
  for (const f of files) assert.match(await readFile(join(dir, f), "utf8"), new RegExp(`VALUES \\('${f.replace(/\.sql$/, "")}'\\)`), `${f} records itself under its own name`);
  const applied = (await query<{ version: string }>("SELECT version FROM bops.schema_migrations WHERE version IN ('0009_usage', '0010_chat_messages')")).rows.map((r) => r.version).sort();
  assert.deepEqual(applied, ["0009_usage", "0010_chat_messages"]);
});
