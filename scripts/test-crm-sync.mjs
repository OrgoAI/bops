// Tests for the CRM's files recorded in Orgo (lib/server/crm-sync.ts, with crm.ts): a file made, changed,
// renamed or deleted here goes to Orgo in order (its CSV as the Mac wrote it, If-Match the contents the two
// last agreed on, the sample marked as one); Orgo away, the changes wait in an outbox on disk and go after a
// restart; what Orgo has comes here when the CRM's list is opened (a file made on another Mac written here,
// one changed there taken, one renamed there renamed here, one deleted there into .trash), a file changed on
// both sides takes the later change with the losing copy kept in .trash, a file from before Orgo kept them
// goes at the first read, and a workspace set up on another Mac doesn't get the sample again; a workspace
// deleted takes its CRM folder off this Mac.
//
// orgo-web (lib/bops-crm, its routes field for field) and its bucket's presigned GETs are fakes on made-up
// origins, and the state lives in a throwaway folder: nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-crm-sync.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
const ORGO_KEY = "sk_orgo_test_crm_sync";
globalThis.bopsOrgoKey = ORGO_KEY;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-crm-sync-"));
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

const PID = "22222222-2222-4333-8444-555555555555";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/* ---------------- A fake orgo-web: /api/projects/{id}/crm, as lib/bops-crm answers ---------------- */

const orgo = { files: [], blobs: new Map(), calls: [], down: false, clock: Date.now(), seq: 0 };
const now = () => new Date((orgo.clock = Math.max(Date.now(), orgo.clock + 1))).toISOString();
const fold = (n) => n.normalize("NFC").toLowerCase();
const live = (name) => orgo.files.find((f) => !f.deletedAt && fold(f.name) === fold(name));
const view = (f) => ({ id: f.id, name: f.name, columns: f.columns, rows: f.rows, bytes: f.bytes, sha256: f.sha256, sample: f.sample, createdAt: f.createdAt, updatedAt: f.updatedAt, deletedAt: f.deletedAt });
/** Another Mac (or orgo.ai) at work on Orgo's copy. */
const elsewhere = {
  put(name, csv) {
    const bytes = Buffer.from(csv);
    orgo.blobs.set(sha(bytes), bytes);
    const f = live(name);
    const shape = { columns: csv.split(/\r?\n/)[0].split(","), rows: csv.trim().split(/\r?\n/).length - 1, bytes: bytes.length, sha256: sha(bytes), updatedAt: now() };
    if (f) return Object.assign(f, shape);
    const made = { id: `crm_${++orgo.seq}`, name, sample: false, createdAt: now(), deletedAt: null, ...shape };
    orgo.files.push(made);
    return made;
  },
  rename(from, to) {
    Object.assign(live(from), { name: to, updatedAt: now() });
  },
  del(name) {
    const f = live(name);
    f.deletedAt = now();
    f.updatedAt = f.deletedAt;
  },
};

async function fakeOrgo(req, url) {
  const body = req.method === "GET" || req.method === "DELETE" ? undefined : Buffer.from(await req.arrayBuffer());
  orgo.calls.push({ method: req.method, path: decodeURIComponent(url.pathname), query: url.search, body, ifMatch: req.headers.get("if-match"), type: req.headers.get("content-type"), auth: req.headers.get("authorization") });
  if (req.headers.get("authorization") !== `Bearer ${ORGO_KEY}`) return json({ error: "Unauthorized" }, 401);
  if (orgo.down) return json({ error: "Bops is not available right now. Try again.", code: "bops_map_unavailable" }, 503);
  const m = url.pathname.match(/^\/api\/projects\/([^/]+)\/crm(?:\/([^/]+))?$/);
  if (!m) return new Response("<!doctype html><title>404</title>", { status: 404, headers: { "content-type": "text/html" } });
  const [, pid, rawName] = m;
  if (pid !== PID) return json({ error: "Workspace not found.", code: "not_found" }, 404);
  if (!rawName) {
    const since = url.searchParams.get("since");
    const at = now();
    if (!since) return json({ files: orgo.files.filter((f) => !f.deletedAt).map(view), at, full: true });
    const after = (Number(since) || Date.parse(since)) - 120_000;
    return json({ files: orgo.files.filter((f) => Date.parse(f.updatedAt) > after).map(view), at, full: false });
  }
  const name = decodeURIComponent(rawName);
  const f = live(name);
  if (req.method === "GET") return f ? json({ file: view(f), url: `https://blobs.test/${f.sha256}` }) : json({ error: "No such file.", code: "file_not_found" }, 404);
  if (req.method === "PUT") {
    const match = req.headers.get("if-match");
    const s = sha(body);
    if (match === null ? f && f.sha256 !== s : match === "*" ? !f : f?.sha256 !== match) return json({ error: "This CRM file changed since you read it.", code: "file_changed", sha256: f?.sha256 ?? null }, 412);
    if (f && f.sha256 === s) return json({ file: view(f) });
    if (!f && orgo.files.filter((x) => !x.deletedAt).length >= 50) return json({ error: "A workspace keeps 50 CRM files at most.", code: "file_limit", limit: 50 }, 409);
    const made = elsewhere.put(f?.name ?? name, body.toString());
    if (!f) made.sample = url.searchParams.get("sample") === "1";
    return json({ file: view(made) }, f ? 200 : 201);
  }
  if (req.method === "PATCH") {
    if (!f) return json({ error: "No such file.", code: "file_not_found" }, 404);
    const to = JSON.parse(body.toString()).name;
    if (live(to) && live(to) !== f) return json({ error: "Another CRM file has that name.", code: "name_taken" }, 409);
    Object.assign(f, { name: to, updatedAt: now() });
    return json({ file: view(f) });
  }
  if (req.method === "DELETE") {
    if (!f) return json({ error: "No such file.", code: "file_not_found" }, 404);
    elsewhere.del(name);
    return json({ deleted: true, deletedAt: f.deletedAt });
  }
  return json({ error: "no" }, 405);
}

globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin === "https://orgo.test") return fakeOrgo(req, url);
  if (url.origin === "https://blobs.test") {
    orgo.calls.push({ method: "GET", path: url.pathname, blob: true, auth: req.headers.get("authorization") });
    const bytes = orgo.blobs.get(url.pathname.slice(1));
    return bytes ? new Response(bytes) : new Response("NoSuchKey", { status: 404 });
  }
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};

/* ---------------- Bops ---------------- */

const S = await import(`${root}/lib/server/store.ts`);
const K = await import(`${root}/lib/server/crm.ts`);
const C = await import(`${root}/lib/server/crm-sync.ts`);
const O = await import(`${root}/lib/server/sync-outbox.ts`);
const { SAMPLE_NAME } = await import(`${root}/lib/crm-csv.ts`);
const T = C.crmSyncForTests;
S.update((s) => {
  s.owner = { name: "Maya" };
  s.account = { user: { id: "u_crm", email: "maya@orgo.ai" }, signedInAt: 0 };
  s.workspaces = [
    { id: "ws_main", name: "Main", createdAt: 0, orgoProjectId: PID },
    { id: "ws_two", name: "Two", createdAt: 1 },
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
const dir = () => join(S.userDir(), "crm", "ws_main");
const local = (name) => (existsSync(join(dir(), `${name}.csv`)) ? readFileSync(join(dir(), `${name}.csv`)) : null);
const there = (name) => live(name);
const thereBytes = (name) => orgo.blobs.get(there(name)?.sha256);
const settle = async () => {
  for (let i = 0; i < 4; i++) await T.flush();
};
const sent = () => orgo.calls.filter((c) => !c.blob && !(c.method === "GET" && c.path.endsWith("/crm"))).map((c) => `${c.method} ${c.path.replace(`/api/projects/${PID}/crm`, "…")}`);
const trashed = () => (existsSync(join(dir(), ".trash")) ? readdirSync(join(dir(), ".trash")) : []);
/** The list as the app opens it, with Orgo's copy read first (no 30 second wait between). */
const openList = async () => {
  T.reset();
  return K.listFiles("ws_main", { seed: true });
};

await check("The first open: the sample is written once, and goes to Orgo marked as the sample", async () => {
  orgo.calls = [];
  const list = await openList();
  assert.deepEqual(list.map((f) => f.name), [SAMPLE_NAME]);
  await settle();
  assert.ok(there(SAMPLE_NAME), sent().join(", "));
  assert.equal(there(SAMPLE_NAME).sample, true);
  assert.equal(thereBytes(SAMPLE_NAME).toString(), local(SAMPLE_NAME).toString(), "the CSV as this Mac wrote it");
  const put = orgo.calls.find((c) => c.method === "PUT");
  assert.match(put.type, /^text\/csv/);
  assert.equal(put.ifMatch, null, "a new file: none");
});

await check("Made, changed, renamed and deleted here: each goes to Orgo, in order, If-Match what the two last agreed on", async () => {
  orgo.calls = [];
  await K.createFile("ws_main", "Leads", { template: "pipeline" });
  await settle();
  const first = sha(local("Leads"));
  assert.equal(there("Leads").sha256, first);
  await K.applyFileOps("ws_main", "Leads", [{ op: "add", values: ["Jo", "Acme", "jo@acme.test", "Lead", "$1", "Maya", "", ""] }]);
  await settle();
  await K.renameFile("ws_main", "Leads", "Prospects");
  await settle();
  await K.createFile("ws_main", "Scratch", { template: "pipeline" });
  await settle();
  await K.deleteFile("ws_main", "Scratch");
  await settle();
  assert.deepEqual(sent(), ["PUT …/Leads", "PUT …/Leads", "PATCH …/Leads", "PUT …/Scratch", "DELETE …/Scratch"]);
  const puts = orgo.calls.filter((c) => c.method === "PUT");
  assert.deepEqual([puts[0].ifMatch, puts[1].ifMatch], [null, first], "a new file: none; a change: the contents Orgo had");
  assert.equal(there("Leads"), undefined);
  assert.equal(thereBytes("Prospects").toString(), local("Prospects").toString(), "its rows, under its new name");
  assert.equal(there("Scratch"), undefined);
  assert.ok(orgo.files.find((f) => f.name === "Scratch").deletedAt, "in Orgo's trash");
  // Made and renamed before it went: sent once, under its new name.
  orgo.calls = [];
  await K.createFile("ws_main", "Draft", { template: "pipeline" });
  await K.renameFile("ws_main", "Draft", "Final");
  await settle();
  assert.deepEqual(sent(), ["PATCH …/Draft", "PUT …/Final"]);
  assert.equal(thereBytes("Final").toString(), local("Final").toString());
  await K.deleteFile("ws_main", "Final");
  await settle();
});

await check("Orgo away: the changes wait in the outbox on disk, in order, and go after a restart", async () => {
  orgo.down = true;
  await K.createFile("ws_main", "Partners", { text: "Name,Email\nAl,al@x.test\n" });
  await K.applyFileOps("ws_main", "Prospects", [{ op: "add", values: ["Lu", "Cy", "lu@cy.test", "Lead", "$3", "Maya", "", ""] }]);
  await K.deleteFile("ws_main", "Prospects");
  await settle();
  O.outboxForTests.writeAll();
  const box = JSON.parse(readFileSync(join(S.userDir(), "outbox", "crm.json"), "utf8")).entries.map((e) => `${e.item.op} ${e.item.name}`);
  assert.deepEqual(box, ["put Partners", "put Prospects", "delete Prospects"]);
  O.outboxForTests.restart();
  T.reset();
  orgo.down = false;
  orgo.calls = [];
  C.startCrmSync();
  for (let i = 0; i < 100 && !there("Partners"); i++) await new Promise((r) => setTimeout(r, 20));
  await settle();
  assert.equal(thereBytes("Partners").toString(), local("Partners").toString());
  assert.equal(there("Prospects"), undefined, "deleted after its last change went");
  O.outboxForTests.writeAll();
  assert.equal(existsSync(join(S.userDir(), "outbox", "crm.json")), false, "nothing left to send");
});

await check("Made, changed, renamed and deleted on another Mac: here when the CRM's list is opened (deleted into .trash)", async () => {
  elsewhere.put("Vendors", "Name,Email\nZed,zed@v.test\n");
  let list = await openList();
  assert.ok(list.some((f) => f.name === "Vendors"), "made there: listed here");
  assert.equal(local("Vendors").toString(), "Name,Email\nZed,zed@v.test\n");
  elsewhere.put("Vendors", "Name,Email\nZed,zed@v.test\nYo,yo@v.test\n");
  list = await openList();
  assert.equal(list.find((f) => f.name === "Vendors").rows, 2, "changed there: taken here");
  elsewhere.rename("Vendors", "Suppliers");
  list = await openList();
  assert.deepEqual([list.some((f) => f.name === "Vendors"), list.some((f) => f.name === "Suppliers")], [false, true], "renamed there: renamed here");
  elsewhere.del("Suppliers");
  orgo.calls = [];
  list = await openList();
  assert.ok(!list.some((f) => f.name === "Suppliers"), "deleted there: gone here");
  assert.ok(trashed().some((f) => f.startsWith("Suppliers__")), "into .trash");
  assert.deepEqual(sent(), [], "nothing of it sent back");
});

await check("Changed on both sides since they agreed: the later change stands, the copy that lost kept in .trash", async () => {
  // Here first, there later: Orgo's stands.
  await K.applyFileOps("ws_main", "Partners", [{ op: "add", values: ["Here", "h@x.test"] }]);
  await new Promise((r) => setTimeout(r, 5));
  elsewhere.put("Partners", "Name,Email\nThere,t@x.test\n");
  const before = trashed().length;
  await settle();
  assert.equal(local("Partners").toString(), "Name,Email\nThere,t@x.test\n");
  assert.equal(trashed().length, before + 1, "this Mac's copy kept in .trash");
  // There first, here later: this Mac's goes over it.
  elsewhere.put("Partners", "Name,Email\nThere again,t2@x.test\n");
  await new Promise((r) => setTimeout(r, 5));
  await K.applyFileOps("ws_main", "Partners", [{ op: "add", values: ["Here later", "h2@x.test"] }]);
  await settle();
  assert.equal(thereBytes("Partners").toString(), local("Partners").toString());
  assert.match(local("Partners").toString(), /Here later/);
});

await check("A file from before Orgo kept them goes at the first read; one Orgo had from here that it no longer lists (its trash emptied) goes here too", async () => {
  // Written to the folder before this version of Bops: Orgo never had it.
  writeFileSync(join(dir(), "Old list.csv"), "Name\nOld\n", { mode: 0o600 });
  const side = join(dir(), ".orgo.json");
  const kept = JSON.parse(readFileSync(side, "utf8"));
  // No read kept yet: Orgo's whole list.
  writeFileSync(side, JSON.stringify({ ...kept, since: undefined }));
  orgo.files = orgo.files.filter((f) => f.name !== "Partners");
  orgo.calls = [];
  await openList();
  await settle();
  assert.equal(orgo.calls.find((c) => c.method === "GET" && c.path.endsWith("/crm")).query, "", "the whole list");
  assert.equal(thereBytes("Old list").toString(), "Name\nOld\n", "sent");
  assert.equal(local("Partners"), null, "gone here");
  assert.ok(trashed().some((f) => f.startsWith("Partners__")));
});

await check("A workspace set up on another Mac doesn't get the sample again here", async () => {
  // The sample deleted on the other Mac; this Mac opens the workspace's CRM for the first time.
  elsewhere.del(SAMPLE_NAME);
  rmSync(dir(), { recursive: true, force: true });
  orgo.calls = [];
  const list = await openList();
  assert.ok(!list.some((f) => f.name === SAMPLE_NAME), "not written here");
  assert.deepEqual(list.map((f) => f.name).sort(), orgo.files.filter((f) => !f.deletedAt).map((f) => f.name).sort(), "the same files as Orgo");
  assert.ok(existsSync(join(dir(), ".seeded")));
  await settle();
  assert.deepEqual(sent().filter((c) => !c.startsWith("GET")), [], "nothing sent back, only Orgo's files read");
  assert.equal(there(SAMPLE_NAME), undefined, "nor made again in Orgo");
});

await check("A workspace with no Orgo project stays on this Mac; a deleted workspace's CRM folder goes", async () => {
  orgo.calls = [];
  await K.createFile("ws_two", "Local only", { template: "pipeline" });
  await settle();
  assert.deepEqual(sent(), []);
  assert.deepEqual(await C.crmNames("ws_two"), ["Local only"], "named in the delete's question");
  C.dropWorkspaceCrm("ws_two");
  assert.equal(existsSync(join(S.userDir(), "crm", "ws_two")), false);
});

await check("Plain words: nothing said has a long dash, and no stray warnings", () => {
  for (const w of logged) assert.ok(!/[–—]/.test(w), w);
  assert.ok(!/[–—]/.test(readFileSync(join(root, "lib/server/crm-sync.ts"), "utf8")));
  assert.deepEqual(logged.filter((l) => /^\[crm\]/.test(l)), []);
  assert.deepEqual(rejections, []);
});

T.reset();
console.log(`\nCRM in Orgo: ${passed} passed, ${failed} failed`);
if (!failed) rmSync(scratch, { recursive: true, force: true });
else console.log(`The throwaway folder is kept for a look: ${scratch}`);
process.exit(failed ? 1 : 0);
