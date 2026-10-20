// Tests for the apps the bots make, recorded in Orgo (lib/server/made-apps-sync.ts, with made-apps.ts and
// remove.ts): a new app's record goes at once and each version's code after it (a build, a change, a Go
// back), what it keeps goes too (If-Match the last agreed, the later change winning a conflict either way),
// a delete deletes it in Orgo, and a version holding a secret stays on this Mac; Orgo away, every change
// waits in an outbox on disk and goes after a restart, and the list on this Mac (made-apps/apps.json)
// survives one; an app another Mac made is listed from Orgo, its code fetched when it's opened and its data
// when it reads it, then kept; one changed there comes here (asked again before it may ask its bot), one
// deleted there goes here, and a late change from here to one deleted gets 409 and goes; an app from before
// Orgo kept them goes as a full copy at start (never with deleteMissing); a deleted bot's apps stay under
// the main bot, with the delete's question saying so; a deleted workspace's go from this Mac.
//
// orgo-web (lib/bops-made-apps, its routes field for field), its bucket's presigned GETs and OpenAI are
// fakes on made-up origins, and the state lives in a throwaway folder: nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-made-apps-sync.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-made-apps-sync";
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
const ORGO_KEY = "sk_orgo_test_made_apps_sync";
globalThis.bopsOrgoKey = ORGO_KEY;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
process.env.BOPS_SERVER_JS = join(root, "server.js");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-made-apps-sync-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

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
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));
const logged = [];
for (const k of ["info", "warn", "error"]) console[k] = (...a) => logged.push(a.map(String).join(" "));
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(String(e?.stack ?? e)));

const PID = "11111111-2222-4333-8444-555555555555";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/* ---------------- A fake OpenAI: each build writes the next file in `code` ---------------- */

const code = [];
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const usage = { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const done = (text) => ({ id: "resp_x", object: "response", model: "gpt-test", status: "completed", output: [{ id: "msg_x", type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage });

/* ---------------- A fake orgo-web: /api/projects/{id}/bops/apps, as lib/bops-made-apps answers ---------------- */

const orgo = { apps: new Map(), blobs: new Map(), calls: [], down: false, clock: Date.now(), seq: 0 };
const now = () => new Date((orgo.clock = Math.max(Date.now(), orgo.clock + 1))).toISOString();
const keyOf = (bopsId) => `${PID}:${bopsId}`;
const view = (a) => ({
  id: a.id,
  bopsId: a.bopsId,
  botId: a.botId,
  title: a.title,
  currentVersion: a.currentVersion,
  deviceId: a.deviceId,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
  deletedAt: a.deletedAt,
  versions: [...a.versions.values()].sort((x, y) => x.n - y.n),
  data: a.data,
});
const iso = (v) => new Date(typeof v === "number" ? v : Date.parse(v)).toISOString();
/** Text orgo-web stores (lib/bops-made-apps/body.ts storable): no NUL, no half of an emoji. */
const storable = (t) => typeof t !== "string" || !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t);
/** PUT …/apps/{id} and the full copy: made, changed, or unchanged; a deleted one stays deleted. */
function upsert(bopsId, b, deviceId) {
  if (!storable(b.title) || (b.versions ?? []).some((v) => !storable(v.note))) return { status: "invalid" };
  let a = orgo.apps.get(keyOf(bopsId));
  if (a?.deletedAt) return { status: "deleted", a };
  const created = !a;
  if (!a) {
    a = { id: `uuid_${++orgo.seq}`, bopsId, botId: b.botId, title: b.title ?? "", currentVersion: b.currentVersion, deviceId: deviceId ?? b.deviceId ?? null, createdAt: iso(b.createdAt), updatedAt: now(), deletedAt: null, versions: new Map(), data: null };
    orgo.apps.set(keyOf(bopsId), a);
  }
  let added = 0;
  for (const v of b.versions ?? [])
    if (!a.versions.has(v.n)) {
      a.versions.set(v.n, { n: v.n, note: v.note ?? "", sha256: null, bytes: null, createdAt: iso(v.at) });
      added++;
    }
  if (b.currentVersion !== 0 && !a.versions.has(b.currentVersion)) return { status: "invalid" };
  const dev = deviceId ?? b.deviceId ?? a.deviceId;
  const changed = a.botId !== b.botId || a.title !== (b.title ?? "") || a.currentVersion !== b.currentVersion || a.deviceId !== dev || a.createdAt !== iso(b.createdAt);
  if (!created && (changed || added)) Object.assign(a, { botId: b.botId, title: b.title ?? "", currentVersion: b.currentVersion, deviceId: dev, createdAt: iso(b.createdAt), updatedAt: now() });
  return { status: created ? "created" : changed || added ? "updated" : "unchanged", a };
}
function softDelete(a) {
  if (a.deletedAt) return;
  Object.assign(a, { deletedAt: now(), data: null });
  a.updatedAt = a.deletedAt;
  a.versions.clear();
}
/** Another Mac (or orgo.ai) at work on Orgo's copy: what its routes would have stored. */
const elsewhere = {
  makeApp(bopsId, { title, botId = "boppy", versions = [], data, deviceId = "mac_other" }) {
    upsert(bopsId, { botId, title, currentVersion: versions.length ? versions.at(-1).n : 0, createdAt: Date.now(), versions: versions.map((v) => ({ n: v.n, note: v.note, at: Date.now() })) }, deviceId);
    const a = orgo.apps.get(keyOf(bopsId));
    for (const v of versions) {
      const bytes = Buffer.from(v.code);
      orgo.blobs.set(sha(bytes), bytes);
      Object.assign(a.versions.get(v.n), { sha256: sha(bytes), bytes: bytes.length });
    }
    if (data !== undefined) elsewhere.putData(bopsId, data);
    return a;
  },
  putData(bopsId, data) {
    const a = orgo.apps.get(keyOf(bopsId));
    const bytes = Buffer.from(JSON.stringify(data));
    orgo.blobs.set(sha(bytes), bytes);
    a.data = { sha256: sha(bytes), bytes: bytes.length, updatedAt: now() };
    a.updatedAt = now();
  },
};

async function fakeOrgo(req, url) {
  const body = req.method === "GET" || req.method === "DELETE" ? undefined : Buffer.from(await req.arrayBuffer());
  orgo.calls.push({ method: req.method, path: url.pathname, query: url.search, body, ifMatch: req.headers.get("if-match"), auth: req.headers.get("authorization") });
  if (req.headers.get("authorization") !== `Bearer ${ORGO_KEY}`) return json({ error: "Unauthorized" }, 401);
  if (orgo.down) return json({ error: "Apps are not available right now. Try again.", code: "bops_apps_unavailable" }, 503);
  const m = url.pathname.match(/^\/api\/projects\/([^/]+)\/bops\/apps(?:\/(app_[A-Za-z0-9]+))?(?:\/(versions|data))?(?:\/(\d+))?$/);
  if (!m) return new Response("<!doctype html><title>404</title>", { status: 404, headers: { "content-type": "text/html" } });
  const [, pid, bopsId, sub, n] = m;
  if (pid !== PID) return json({ error: "Workspace not found.", code: "not_found" }, 404);
  const b = body && body.length && req.headers.get("content-type")?.startsWith("application/json") && sub !== "data" ? JSON.parse(body.toString()) : undefined;
  if (!bopsId && req.method === "GET") {
    const since = url.searchParams.get("since");
    const all = [...orgo.apps.values()];
    const at = now();
    if (!since) return json({ apps: all.filter((a) => !a.deletedAt || url.searchParams.get("deleted") === "1").map(view), at, full: true });
    const after = (Number(since) || Date.parse(since)) - 120_000;
    return json({ apps: all.filter((a) => Date.parse(a.updatedAt) > after).map(view), at, full: false });
  }
  if (!bopsId && req.method === "PUT") {
    const out = { created: 0, updated: 0, unchanged: 0, deleted: 0, alreadyDeleted: [], apps: [] };
    for (const x of b.apps) {
      const r = upsert(x.bopsId, x, b.deviceId);
      if (r.status === "invalid") return json({ error: "The app is not valid.", code: "invalid_app" }, 400);
      if (r.status === "deleted") out.alreadyDeleted.push(x.bopsId);
      else out[r.status]++;
      out.apps.push(view(r.a));
    }
    if (b.deleteMissing)
      for (const a of orgo.apps.values())
        if (a.deviceId === b.deviceId && !b.apps.some((x) => x.bopsId === a.bopsId) && !a.deletedAt) {
          softDelete(a);
          out.deleted++;
        }
    return json(out);
  }
  const a = orgo.apps.get(keyOf(bopsId));
  if (!sub) {
    if (req.method === "GET") return a ? json({ app: view(a) }) : json({ error: "App not found.", code: "app_not_found" }, 404);
    if (req.method === "PUT") {
      const r = upsert(bopsId, b);
      if (r.status === "deleted") return json({ error: "This app was deleted.", code: "app_deleted", deletedAt: r.a.deletedAt }, 409);
      if (r.status === "invalid") return json({ error: "The app is not valid.", code: "invalid_app" }, 400);
      return json({ app: view(r.a) }, r.status === "created" ? 201 : 200);
    }
    if (req.method === "DELETE") {
      if (!a) return json({ error: "App not found.", code: "app_not_found" }, 404);
      softDelete(a);
      return json({ deleted: true, deletedAt: a.deletedAt });
    }
  }
  if (sub === "versions") {
    const v = a?.versions.get(Number(n));
    if (req.method === "GET") {
      if (!a || a.deletedAt || !v) return json({ error: "That version does not exist.", code: "version_not_found" }, 404);
      if (!v.sha256) return json({ error: "This version’s code isn’t uploaded yet.", code: "code_not_found" }, 404);
      return json({ version: v, url: `https://blobs.test/${v.sha256}` });
    }
    if (!a) return json({ error: "App not found.", code: "app_not_found" }, 404);
    if (a.deletedAt) return json({ error: "This app was deleted.", code: "app_deleted", deletedAt: a.deletedAt }, 409);
    if (!storable(b.note) || !storable(b.code)) return json({ error: "The version is not valid.", code: "invalid_version" }, 400);
    // The skill bundles' secret scan, as far as these tests need it: a live Stripe key.
    const line = b.code.split("\n").findIndex((l) => /sk_live_[0-9a-zA-Z]{20,}/.test(l));
    if (line >= 0) return json({ error: "A file holds what looks like a secret.", code: "secret_found", problems: [{ path: `v${n}.tsx`, line: line + 1, reason: "stripe_key" }] }, 422);
    const bytes = Buffer.from(b.code);
    if (v?.sha256) return v.sha256 === sha(bytes) ? json({ version: v }) : json({ error: "This version has other code.", code: "version_exists", version: v }, 409);
    orgo.blobs.set(sha(bytes), bytes);
    const stored = { n: Number(n), note: v?.note ?? b.note ?? "", sha256: sha(bytes), bytes: bytes.length, createdAt: v?.createdAt ?? iso(b.at ?? Date.now()) };
    a.versions.set(Number(n), stored);
    return json({ version: stored }, 201);
  }
  if (sub === "data") {
    if (req.method === "GET") return a && !a.deletedAt && a.data ? json({ data: a.data, url: `https://blobs.test/${a.data.sha256}` }) : json({ error: "This app has no saved data.", code: "data_not_found" }, 404);
    if (!a) return json({ error: "App not found.", code: "app_not_found" }, 404);
    if (a.deletedAt) return json({ error: "This app was deleted.", code: "app_deleted", deletedAt: a.deletedAt }, 409);
    const match = req.headers.get("if-match");
    if (match && (match === "*" ? !a.data : a.data?.sha256 !== match)) return json({ error: "This app’s data changed since you read it.", code: "data_changed", sha256: a.data?.sha256 ?? null }, 412);
    JSON.parse(body.toString());
    if (a.data?.sha256 === sha(body)) return json({ data: a.data });
    orgo.blobs.set(sha(body), body);
    a.data = { sha256: sha(body), bytes: body.length, updatedAt: now() };
    a.updatedAt = now();
    return json({ data: a.data }, 201);
  }
  return json({ error: "no" }, 405);
}

globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/responses") {
    const b = JSON.parse(await req.text());
    if (b.stream)
      return sse([
        { type: "response.output_text.delta", item_id: "msg_b", output_index: 0, content_index: 0, delta: code.shift() ?? "", logprobs: [], sequence_number: 1 },
        { type: "response.completed", sequence_number: 2, response: done("") },
      ]);
    return json(done("An answer."));
  }
  if (url.origin === "https://orgo.test") return fakeOrgo(req, url);
  // A presigned GET from the bucket: no key.
  if (url.origin === "https://blobs.test") {
    orgo.calls.push({ method: "GET", path: url.pathname, blob: true, auth: req.headers.get("authorization") });
    const bytes = orgo.blobs.get(url.pathname.slice(1));
    return bytes ? new Response(bytes) : new Response("NoSuchKey", { status: 404 });
  }
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};

/* ---------------- Bops ---------------- */

const S = await import(`${root}/lib/server/store.ts`);
const A = await import(`${root}/lib/server/made-apps.ts`);
const F = await import(`${root}/lib/server/made-apps-sync.ts`);
const O = await import(`${root}/lib/server/sync-outbox.ts`);
const R = await import(`${root}/lib/server/remove.ts`);
const { appsStayLine, botChatId } = await import(`${root}/lib/types.ts`);
const T = F.madeAppsSyncForTests;
S.update((s) => {
  s.owner = { name: "Alex" };
  s.workspaces = [
    { id: "ws_main", name: "Main", createdAt: 0, orgoProjectId: PID },
    { id: "ws_two", name: "Two", createdAt: 1 },
  ];
  s.bots = [
    { id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none" },
    { id: "max", name: "Max", role: "Sales", color: "#5B8CFF", isMain: false, computerStatus: "none", computer: "shared" },
    { id: "tess", name: "Tess", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", workspaceId: "ws_two" },
  ];
});
T.reset();

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e?.stack ?? e).split("\n").slice(0, 8).join("\n     ")}`);
  }
}
const app = (id) => S.getState().madeApps?.find((a) => a.id === id);
const there = (id) => orgo.apps.get(keyOf(id));
const waitBuilt = async (id) => {
  for (let i = 0; i < 150 && app(id)?.building; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(app(id)?.building, undefined, "the build ended");
};
const folder = (id) => join(S.userDir(), "made-apps", id);
const build = async (change, appId, title = "Counter") => {
  const made = A.buildApp("max", botChatId("max"), { ...(appId ? { appId } : { title }), change });
  await waitBuilt(made.id);
  return made.id;
};
const sent = () => orgo.calls.filter((c) => !c.blob).map((c) => `${c.method} ${c.path.replace(`/api/projects/${PID}/bops/apps`, "…")}`);
const settle = async () => {
  for (let i = 0; i < 5; i++) await T.flush();
};

let counter;
await check("A new app's record goes to Orgo at once (building, version 0), then its first version's code: by this Mac, under its owner's workspace", async () => {
  orgo.calls = [];
  code.push("// Counts\nexport default function App() { return <p>1</p>; }\n");
  const made = A.buildApp("max", botChatId("max"), { title: "Counter", change: "Count things." });
  counter = made.id;
  assert.equal(made.deviceId, F.thisDevice(), "the Mac that built it");
  await waitBuilt(counter);
  await settle();
  const a = there(counter);
  assert.ok(a, sent().join(", "));
  assert.deepEqual([a.title, a.botId, a.currentVersion, a.deviceId], ["Counter", "max", 1, F.thisDevice()]);
  const v1 = readFileSync(join(folder(counter), "v1.tsx"));
  assert.deepEqual(a.versions.get(1).sha256, sha(v1), "its code, byte for byte");
  assert.ok(sent().indexOf(`PUT …/${counter}`) < sent().indexOf(`PUT …/${counter}/versions/1`), "the record before the code");
  assert.equal(app(counter).syncedAt, app(counter).updatedAt, "Orgo has this Mac's copy");
  assert.ok(orgo.calls.every((c) => c.blob || c.auth === `Bearer ${ORGO_KEY}`), "the signed-in key");
});

await check("A change (a new build) and a Go back each go as a new version: the record, then the code", async () => {
  code.push("// Counts by two\nexport default function App() { return <p>2</p>; }\n");
  await build("Count by two.", counter);
  A.goBack(counter, 1);
  await settle();
  const a = there(counter);
  assert.equal(a.currentVersion, 3);
  assert.deepEqual([...a.versions.keys()], [1, 2, 3]);
  assert.equal(a.versions.get(3).sha256, a.versions.get(1).sha256, "back to v1's code");
  assert.equal(a.versions.get(3).note, "Back to v1");
});

await check("What it keeps goes too, If-Match what the two last agreed on; a conflict goes by the later change, either way", async () => {
  await A.bridge(counter, "data.set", { key: "n", value: 1 });
  orgo.calls = [];
  await settle();
  const local = () => readFileSync(join(folder(counter), "data.json"));
  assert.equal(there(counter).data.sha256, sha(local()));
  const first = orgo.calls.find((c) => c.path.endsWith("/data"));
  assert.equal(first.ifMatch, null, "nothing agreed yet: none");
  assert.equal(first.body.toString(), local().toString(), "the data as this Mac wrote it");
  await A.bridge(counter, "data.set", { key: "n", value: 2 });
  const agreed = there(counter).data.sha256;
  orgo.calls = [];
  await settle();
  assert.equal(orgo.calls.find((c) => c.path.endsWith("/data")).ifMatch, agreed);
  assert.equal(there(counter).data.sha256, sha(local()));
  // Changed here, then later on another Mac: the other Mac's stands, here too.
  await A.bridge(counter, "data.set", { key: "n", value: 3 });
  await new Promise((r) => setTimeout(r, 5));
  elsewhere.putData(counter, { n: 30 });
  await settle();
  assert.deepEqual(JSON.parse(local().toString()), { n: 30 }, "the later change, from the other Mac");
  assert.equal(await A.bridge(counter, "data.get", { key: "n" }), 30);
  // Changed on another Mac, then later here: this Mac's goes over it.
  elsewhere.putData(counter, { n: 40 });
  await new Promise((r) => setTimeout(r, 5));
  await A.bridge(counter, "data.set", { key: "n", value: 4 });
  await settle();
  const stored = orgo.blobs.get(there(counter).data.sha256);
  assert.equal(JSON.parse(stored.toString()).n, 4, "the later change, from here");
});

await check("Delete: gone from this Mac, files and all, and from Orgo (its versions and data with it, the record kept as deleted)", async () => {
  orgo.calls = [];
  A.deleteApp(counter);
  assert.equal(app(counter), undefined);
  assert.equal(existsSync(folder(counter)), false);
  await settle();
  assert.deepEqual(sent(), [`DELETE …/${counter}`]);
  const a = there(counter);
  assert.ok(a.deletedAt);
  assert.equal(a.versions.size, 0);
  assert.equal(a.data, null);
});

await check("Orgo away: every change waits in the outbox on disk; after a restart the list is still here (made-apps/apps.json) and it all goes", async () => {
  orgo.down = true;
  code.push("// Notes\nexport default function App() { return <p>notes</p>; }\n");
  const notes = await build("Keep notes.", undefined, "Notes");
  await A.bridge(notes, "data.set", { key: "list", value: ["a"] });
  code.push("// Todo\nexport default function App() { return <p>todo</p>; }\n");
  const todo = await build("Keep a todo list.", undefined, "Todo");
  A.deleteApp(todo);
  await settle();
  assert.equal(there(notes), undefined, "Orgo didn't take it");
  O.outboxForTests.writeAll();
  const box = JSON.parse(readFileSync(join(S.userDir(), "outbox", "made-apps.json"), "utf8")).entries.map((e) => `${e.item.op} ${e.item.appId === notes ? "notes" : "todo"}`);
  assert.deepEqual(box, ["app notes", "version notes", "data notes", "delete todo"], "the deleted one's record and code aren't worth sending");
  // Bops quits: the outboxes and the list are written, memory forgets them.
  O.outboxForTests.restart();
  T.restart();
  assert.equal(S.getState().madeApps, undefined, "forgotten in memory");
  orgo.down = false;
  orgo.calls = [];
  F.startMadeAppsSync();
  assert.ok(app(notes), "the list from this Mac's copy");
  assert.equal(app(todo), undefined);
  for (let i = 0; i < 100 && !there(notes)?.data; i++) await new Promise((r) => setTimeout(r, 20));
  await settle();
  const a = there(notes);
  assert.ok(a?.versions.get(1)?.sha256, "its record and code");
  assert.equal(a.data.sha256, sha(readFileSync(join(folder(notes), "data.json"))), "its data");
  assert.ok(sent().includes(`DELETE …/${todo}`), "the delete went");
  assert.equal(there(todo), undefined, "Orgo never had it: its 404 is done");
  O.outboxForTests.writeAll();
  assert.equal(existsSync(join(S.userDir(), "outbox", "made-apps.json")), false, "nothing left to send");
  assert.ok(sent().some((c) => c === "PUT …"), "this Mac's own as a full copy at start");
  assert.ok(orgo.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/bops/apps")).every((c) => !JSON.parse(c.body.toString()).deleteMissing), "never deleteMissing");
  A.deleteApp(notes);
  await settle();
});

await check("Another Mac's app: listed from Orgo, its code fetched the first time it's opened here and its data the first time it reads it, then kept", async () => {
  elsewhere.makeApp("app_othermac1", { title: "Tracker", versions: [{ n: 1, note: "Tracks", code: "// Tracks\nexport default function App() { return <p>tracker</p>; }\n" }], data: { seen: 7 } });
  orgo.calls = [];
  assert.equal(await T.pullApps("ws_main"), true);
  const a = app("app_othermac1");
  assert.deepEqual([a.title, a.botId, a.ws, a.version, a.deviceId, a.chatId], ["Tracker", "boppy", "ws_main", 1, "mac_other", botChatId("boppy")]);
  assert.match(orgo.calls[0].query, /^\?since=/, "only what changed since the last read");
  assert.equal(existsSync(join(folder("app_othermac1"), "v1.tsx")), false, "nothing fetched until it's opened");
  assert.match(await A.viewPage("app_othermac1"), /tracker/);
  assert.ok(existsSync(join(folder("app_othermac1"), "v1.tsx")), "kept here");
  assert.ok(orgo.calls.some((c) => c.blob && c.auth === null), "from the bucket's presigned GET, no key sent");
  assert.equal(await A.bridge("app_othermac1", "data.get", { key: "seen" }), 7);
  orgo.calls = [];
  assert.match(await A.viewPage("app_othermac1"), /tracker/);
  assert.equal(await A.bridge("app_othermac1", "data.get", { key: "seen" }), 7);
  assert.deepEqual(orgo.calls, [], "opened again: nothing fetched");
});

await check("Changed on another Mac (a new version): taken here, its code fetched when opened, and the app asked again before it may ask its bot", async () => {
  A.allow("app_othermac1", "bot", true);
  const a = there("app_othermac1");
  const v2 = Buffer.from("// Tracks more\nexport default function App() { return <p>tracker 2</p>; }\n");
  orgo.blobs.set(sha(v2), v2);
  a.versions.set(2, { n: 2, note: "Tracks more", sha256: sha(v2), bytes: v2.length, createdAt: now() });
  Object.assign(a, { currentVersion: 2, title: "Tracker+", updatedAt: now() });
  await T.pullApps("ws_main");
  assert.deepEqual([app("app_othermac1").version, app("app_othermac1").title, app("app_othermac1").allowed], [2, "Tracker+", undefined]);
  assert.match(await A.viewPage("app_othermac1"), /tracker 2/);
});

await check("Changed on this Mac, the app made on another: its new version goes to Orgo, the Mac that built it stays named", async () => {
  code.push("// Tracks a lot\nexport default function App() { return <p>tracker 3</p>; }\n");
  await build("Track a lot.", "app_othermac1");
  await settle();
  const a = there("app_othermac1");
  assert.deepEqual([a.currentVersion, a.deviceId], [3, "mac_other"]);
  assert.ok(a.versions.get(3).sha256);
});

await check("Deleted on another Mac: goes here too, files and all; a late change from here to one deleted gets 409 and goes", async () => {
  softDelete(there("app_othermac1"));
  await T.pullApps("ws_main");
  assert.equal(app("app_othermac1"), undefined);
  assert.equal(existsSync(folder("app_othermac1")), false);
  // Changed here while it was being deleted there: Orgo says app_deleted, and it goes here too.
  code.push("// Late\nexport default function App() { return <p>late</p>; }\n");
  const late = await build("Something late.", undefined, "Late");
  await settle();
  softDelete(there(late));
  code.push("// Later\nexport default function App() { return <p>later</p>; }\n");
  await build("Change it.", late);
  await settle();
  assert.equal(app(late), undefined, "a delete is never undone");
  assert.equal(existsSync(folder(late)), false);
});

await check("Orgo's whole list (no ?since= yet): one Orgo had from here and no longer lists was deleted there", async () => {
  code.push("// Gone\nexport default function App() { return <p>gone</p>; }\n");
  const gone = await build("Make one.", undefined, "Gone");
  await settle();
  orgo.apps.delete(keyOf(gone));
  // A restart with no read of the list kept yet: no since.
  T.restart();
  const list = join(S.userDir(), "made-apps", "apps.json");
  writeFileSync(list, JSON.stringify({ ...JSON.parse(readFileSync(list, "utf8")), since: {} }));
  F.loadLocalApps();
  assert.ok(app(gone), "on this Mac until Orgo says");
  orgo.calls = [];
  await T.pullApps("ws_main");
  assert.equal(orgo.calls[0].query, "", "the whole list");
  assert.equal(app(gone), undefined);
});

await check("An app from before Orgo kept them: sent as a full copy at start, with its versions' code and its data (never deleteMissing)", async () => {
  const old = "app_fromb4";
  mkdirSync(folder(old), { recursive: true });
  writeFileSync(join(folder(old), "v1.tsx"), "// Old\nexport default function App() { return <p>old</p>; }\n");
  writeFileSync(join(folder(old), "data.json"), JSON.stringify({ kept: true }));
  S.update((s) => s.madeApps.push({ id: old, title: "Old one", botId: "max", chatId: botChatId("max"), ws: "ws_main", version: 1, versions: [{ n: 1, note: "Old", at: 1 }], createdAt: 1, updatedAt: 1 }));
  orgo.calls = [];
  assert.equal(await T.sendAll("ws_main"), true);
  await settle();
  const a = there(old);
  assert.deepEqual([a.deviceId, a.currentVersion], [F.thisDevice(), 1], "made on this Mac");
  assert.ok(a.versions.get(1).sha256, "its code");
  assert.equal(a.data.sha256, sha(readFileSync(join(folder(old), "data.json"))), "its data");
  const copy = orgo.calls.find((c) => c.method === "PUT" && c.path === `/api/projects/${PID}/bops/apps`);
  const body = JSON.parse(copy.body.toString());
  assert.equal(body.deleteMissing, undefined);
  assert.equal(body.deviceId, F.thisDevice());
  assert.ok(!body.apps.some((x) => x.deviceId === "mac_other"), "only this Mac's own");
});

await check("A bot deleted: the apps it made stay, under the workspace's main bot (the delete's question says so), and Orgo's record follows", async () => {
  const st = S.getState();
  assert.equal(st.madeApps.filter((a) => a.botId === "max").length, 1);
  assert.equal(appsStayLine(st, st.bots.find((b) => b.id === "max")), "The app it made stays, under Boppy.");
  assert.equal(appsStayLine({ bots: st.bots, madeApps: [...st.madeApps, { ...st.madeApps[0], id: "app_x", botId: "max" }] }, st.bots.find((b) => b.id === "max")), "The 2 apps it made stay, under Boppy.");
  assert.equal(appsStayLine(st, st.bots.find((b) => b.id === "boppy")), null, "none made: nothing said");
  for (const f of ["components/app/bot-menu.tsx", "components/app/bot-panel.tsx"]) assert.match(readFileSync(join(root, f), "utf8"), /appsStayLine\(state, b\)/, `${f} says it`);
  await R.deleteBot("max");
  await settle();
  const a = app("app_fromb4");
  assert.deepEqual([a.botId, a.chatId], ["boppy", botChatId("boppy")]);
  assert.equal(there("app_fromb4").botId, "boppy");
});

await check("A version holding a secret: Orgo refuses it, it stays on this Mac, and the log says so once, never the text", async () => {
  S.update((s) => s.bots.push({ id: "max", name: "Max", role: "Sales", color: "#5B8CFF", isMain: false, computerStatus: "none", computer: "shared" }));
  const key = ["sk", "live", "0123456789abcdefABCDEF01"].join("_");
  code.push(`// Pays\nconst k = "${key}";\nexport default function App() { return <p>pay</p>; }\n`);
  const pays = await build("Take payments.", undefined, "Pays");
  await settle();
  assert.equal(there(pays).versions.get(1).sha256, null, "the version is named, its code isn't there");
  assert.ok(existsSync(join(folder(pays), "v1.tsx")), "kept here");
  const said = logged.filter((l) => l.includes("looks like a secret"));
  assert.equal(said.length, 1);
  assert.ok(!logged.some((l) => l.includes(key)), "never the text");
  logged.splice(0, logged.length, ...logged.filter((l) => !l.includes("looks like a secret")));
  O.outboxForTests.writeAll();
  assert.equal(existsSync(join(S.userDir(), "outbox", "made-apps.json")), false, "not asked again");
  // Kept with the app on this Mac: no start sends it again (nor says so again) while its code is the same.
  assert.equal(app(pays).refused?.[1], sha(readFileSync(join(folder(pays), "v1.tsx"))));
  for (let round = 1; round <= 2; round++) {
    O.outboxForTests.restart();
    T.restart();
    orgo.calls = [];
    F.startMadeAppsSync();
    for (let i = 0; i < 100 && !orgo.calls.some((c) => c.method === "PUT" && c.path === `/api/projects/${PID}/bops/apps`); i++) await new Promise((r) => setTimeout(r, 20));
    await settle();
    assert.ok(orgo.calls.some((c) => c.method === "PUT" && c.path === `/api/projects/${PID}/bops/apps`), "the full copy went");
    assert.deepEqual(sent().filter((c) => c.endsWith(`/${pays}/versions/1`)), [], `start ${round}: not sent again`);
  }
  assert.deepEqual(logged.filter((l) => l.includes("looks like a secret")), [], "nor said again");
});

await check("A title or note cut at an emoji is cut before it, so Orgo takes the app; one kept from before with half an emoji or a NUL goes cleaned", async () => {
  code.push("export default function App() { return <p>party</p>; }\n");
  const party = await build(`${"y".repeat(119)}🎉 make it pop`, undefined, `${"P".repeat(59)}🎉 party`);
  await settle();
  const a = app(party);
  assert.equal(a.title, `${"P".repeat(59)}🎉`, "60 characters, the emoji whole");
  assert.equal(a.versions[0].note, `${"y".repeat(119)}🎉`, "the note from the change asked for, 120 characters");
  assert.equal(there(party)?.title, a.title, "Orgo took its record");
  assert.ok(there(party).versions.get(1).sha256, "and its code");
  // Kept from before this Bops: half an emoji and a NUL in its title and note. Sent without them.
  S.update((s) => {
    const x = s.madeApps.find((y) => y.id === party);
    x.title = "Half \uD83C";
    x.versions[0].note = "a\u0000b\uDF89";
    F.touched(x);
  });
  F.appSaved(app(party));
  await settle();
  assert.equal(there(party).title, "Half ");
  orgo.calls = [];
  assert.equal(await T.sendAll("ws_main"), true, "the full copy, every app, taken");
  assert.ok(!logged.some((l) => /invalid_app/.test(l)), "never refused");
});

await check("A workspace deleted: its apps go from this Mac, nothing sent (Orgo's went with its project)", async () => {
  S.update((s) => s.madeApps.push({ id: "app_intwo", title: "In two", botId: "tess", chatId: botChatId("tess"), ws: "ws_two", version: 0, versions: [], createdAt: 1, updatedAt: 1 }));
  orgo.calls = [];
  F.dropWorkspaceApps("ws_two");
  assert.equal(app("app_intwo"), undefined);
  await settle();
  assert.deepEqual(sent(), []);
});

await check("Plain words: nothing said has a long dash", () => {
  const words = [...S.getState().messages.map((m) => m.text), ...(S.getState().madeApps ?? []).map((a) => a.error ?? ""), ...logged];
  for (const w of words) assert.ok(!/[–—]/.test(w), w);
  for (const f of ["lib/server/made-apps-sync.ts"]) assert.ok(!/[–—]/.test(readFileSync(join(root, f), "utf8")), f);
  assert.deepEqual(logged.filter((l) => /^\[made-apps\]/.test(l)), [], "no stray warnings");
  assert.deepEqual(rejections, []);
});

T.reset();
console.log(`\nmade apps in Orgo: ${passed} passed, ${failed} failed`);
if (!failed) rmSync(scratch, { recursive: true, force: true });
else console.log(`The throwaway folder is kept for a look: ${scratch}`);
process.exit(failed ? 1 : 0);
