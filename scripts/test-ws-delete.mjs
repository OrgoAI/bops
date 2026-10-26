// Tests for what deleting a workspace takes with it beyond Orgo's project (lib/server/remove.ts
// deleteWorkspace, lib/server/memory-deletes.ts, the confirm's list in lib/server/workspaces.ts
// deletePreview, and the window's lib/workspace-local.ts), from the prod E2E of 10-20: the confirm names its
// routines and Orbit issues (orgo-web's delete takes them) and says when its memory goes; its memory goes from
// Honcho (its own bank whole, deleted session by session first when Honcho refuses a bank with sessions; in a
// bank another workspace uses only its issues' sessions; never the user's own bank; Honcho away keeps it in an
// outbox on disk, sent later; a bank taken up again since is never deleted); and nothing of it stays on this
// Mac (its skills' folder, its issues' cache, its Orbit index and the ones kept for banks it used before, its
// memory review, and the window's localStorage keys for it), while another workspace's stay whole. orgo-web
// and Honcho are fakes answering what Bops calls, OpenAI a fake that answers nothing, the Keychain a stand-in
// that's never there, and the state and files live in a throwaway folder: nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-ws-delete.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.TZ = "America/New_York";
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-ws-delete";
process.env.HONCHO_API_KEY = "hc-test-ws-delete";
process.env.BOPS_ORGO_ORIGIN = "http://orgo.test";
const ORGO_KEY = "sk_orgo_test_ws_delete";
globalThis.bopsOrgoKey = ORGO_KEY;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-ws-delete-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

// Modules that start processes when loaded do nothing (sessions.ts too: no bot here has a computer).
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

/**
 * `down`: every call answers 503. `refuseWithSessions`: a bank with sessions can't be deleted (409), as a
 * Honcho that wants them gone first. `refuseDeletes`: a bank's delete answers this status.
 */
const honcho = { banks: new Map(), calls: [], unknown: [], down: false, refuseWithSessions: false, refuseDeletes: 0, seq: 0 };
function hbank(id) {
  let b = honcho.banks.get(id);
  if (!b) honcho.banks.set(id, (b = { peers: new Map(), facts: [], sessions: new Map() }));
  return b;
}
async function honchoAnswer(req, url) {
  const text = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
  const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: text ? JSON.parse(text) : undefined };
  honcho.calls.push(call);
  if (honcho.down) return json({ detail: "Service Unavailable" }, 503);
  const p = url.pathname.split("/").slice(1);
  const created_at = iso(0);
  if (p[0] !== "v3" || p[1] !== "workspaces") return unknownCall(call);
  if (p.length === 2 && req.method === "POST") {
    hbank(call.body.id);
    return json({ id: call.body.id, metadata: {}, configuration: {}, created_at });
  }
  // A bank deleted with everything in it.
  if (p.length === 3 && req.method === "DELETE") {
    const had = honcho.banks.get(p[2]);
    if (!had) return json({ detail: "Workspace not found" }, 404);
    if (honcho.refuseDeletes) return json({ detail: "No" }, honcho.refuseDeletes);
    if (honcho.refuseWithSessions && had.sessions.size) return json({ detail: "Workspace has active sessions" }, 409);
    honcho.banks.delete(p[2]);
    return new Response(null, { status: 202 });
  }
  if (!honcho.banks.has(p[2])) return json({ detail: "Workspace not found" }, 404);
  const b = hbank(p[2]);
  const rest = p.slice(3).join("/");
  if (rest === "peers" && req.method === "POST") {
    b.peers.set(call.body.id, call.body);
    return json({ id: call.body.id, workspace_id: p[2], metadata: call.body.metadata ?? {}, configuration: call.body.configuration ?? {}, created_at });
  }
  if (/^peers\/[^/]+\/card$/.test(rest) && req.method === "GET") return json({ peer_card: null });
  if (rest === "conclusions/list" && req.method === "POST") {
    const want = call.body?.filters?.id?.in;
    const items = b.facts.filter((f) => !want || want.includes(f.id));
    return json({ items, total: items.length, page: 1, size: 100, pages: 1 });
  }
  const fact = rest.match(/^conclusions\/([^/]+)$/);
  if (fact && req.method === "DELETE") {
    b.facts = b.facts.filter((f) => f.id !== fact[1]);
    return new Response(null, { status: 204 });
  }
  const asSession = (x) => ({ id: x.id, workspace_id: p[2], is_active: true, metadata: x.metadata, configuration: x.configuration, created_at });
  if (rest === "sessions" && req.method === "POST") {
    let x = b.sessions.get(call.body.id);
    if (!x) b.sessions.set(call.body.id, (x = { id: call.body.id, metadata: call.body.metadata ?? {}, configuration: call.body.configuration ?? {}, peers: { ...(call.body.peers ?? {}) }, messages: [] }));
    return json(asSession(x));
  }
  if (rest === "sessions/list" && req.method === "POST") {
    const f = call.body?.filters ?? {};
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
      const made = call.body.messages.map((m) => ({ id: `m${++honcho.seq}`, content: m.content, peer_id: m.peer_id, session_id: x.id, workspace_id: p[2], metadata: m.metadata ?? {}, created_at: iso(Date.now() + honcho.seq), token_count: 1 }));
      x.messages.push(...made);
      return json(made);
    }
    if (sess[2] === "messages/list" && req.method === "POST") return json({ items: x.messages, total: x.messages.length, page: 1, size: 100, pages: 1 });
  }
  return unknownCall(call);
}
const unknownCall = (call) => (honcho.unknown.push(`${call.method} ${call.path}`), json({ detail: "Not Found" }, 404));
const sessionsIn = (bank) => [...(honcho.banks.get(bank)?.sessions.keys() ?? [])];
const bankDeletes = () => honcho.calls.filter((c) => c.method === "DELETE" && c.path.split("/").length === 4).map((c) => c.path.split("/")[3]);

/* ---------------- orgo-web: the routes a workspace's delete uses ---------------- */

/** Projects as GET /api/workspaces lists them (per workspace projects on); Orbit, skills and the rest answer 404 (no routes). */
/** `extra`: what an orgo-web that lists them adds to a project's delete-preview (routines, orbitIssues). */
const orgo = { projects: [], calls: [], extra: {} };
async function orgoAnswer(req, url) {
  const text = req.method === "GET" ? "" : await req.text();
  const call = { method: req.method, path: url.pathname, body: text ? JSON.parse(text) : undefined };
  orgo.calls.push(call);
  if (req.headers.get("authorization") !== `Bearer ${ORGO_KEY}`) return json({ error: "Not authenticated" }, 401);
  const p = url.pathname.replace(/^\/api\/projects(?=\/|$)/, "/api/workspaces");
  if (p === "/api/workspaces" && req.method === "GET") return json({ workspaces: orgo.projects.map((x) => ({ ...x, role: "owner", desktops: [] })) });
  const preview = p.match(/^\/api\/workspaces\/([^/]+)\/delete-preview$/);
  if (preview) {
    const x = orgo.projects.find((y) => y.id === preview[1]);
    return x ? json({ id: x.id, name: x.name, product: "bops", bops_ws_id: x.bops_ws_id, deletable: true, computers: [], keys: [], skills: [], apps: [], ...orgo.extra[x.id] }) : json({ error: "Project not found" }, 404);
  }
  const del = p.match(/^\/api\/workspaces\/([^/]+)\/delete$/);
  if (del && req.method === "POST") {
    if (!orgo.projects.some((y) => y.id === del[1])) return json({ error: "Project not found" }, 404);
    orgo.projects = orgo.projects.filter((y) => y.id !== del[1]);
    return json({ success: true });
  }
  if (p === "/api/secrets" && req.method === "GET") return json({ secrets: [] });
  return json({ error: `fake orgo-web has no ${req.method} ${p}` }, 404);
}

/* ---------------- OpenAI: answers nothing ---------------- */

const response = (text) => ({ id: "resp_x", object: "response", model: "gpt-test", status: "completed", output: [{ id: "msg_x", type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });

globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin === "https://api.honcho.dev") return honchoAnswer(req, url);
  if (url.origin === "http://orgo.test") return orgoAnswer(req, url);
  if (url.origin === "https://api.openai.com") return json(response('{"facts":[]}'));
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(String(e?.stack ?? e)));

const S = await import(`${root}/lib/server/store.ts`);
const Mem = await import(`${root}/lib/server/memory.ts`);
const MD = await import(`${root}/lib/server/memory-deletes.ts`);
const I = await import(`${root}/lib/server/orbit-issues.ts`);
const Sk = await import(`${root}/lib/server/workspace-skills.ts`);
const Rm = await import(`${root}/lib/server/remove.ts`);
const Route = await import(`${root}/app/api/workspaces/route.ts`);
const { forgetWorkspaceHere } = await import(`${root}/lib/workspace-local.ts`);
const { botChatId } = await import(`${root}/lib/types.ts`);
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
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 6).join("\n  ") ?? e.message}`);
  }
}
const DASHES = /[‒–—―]/;
const until = async (ok, what, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const ws = (id) => S.getState().workspaces.find((w) => w.id === id);
const preview = async (id) => {
  const res = await Route.GET(new Request(`http://localhost:3210/api/workspaces?preview=${id}`));
  return { status: res.status, body: await res.json() };
};
const userDir = () => S.userDir();
const issuesFile = (id) => join(userDir(), "orbit-issues", `ws-${id}.json`);
const catsDir = () => join(userDir(), "memory-categories");
const catsFiles = (id) => (existsSync(catsDir()) ? readdirSync(catsDir()).filter((n) => n.startsWith(`ws-${id}.`) || n.startsWith(`ws-${id}@`)) : []);
const skillsDir = (id) => join(userDir(), "workspaces", id);
const reviewsFile = () => join(userDir(), "memory-reviews.json");
/** An index as memory-categories.ts keeps it, with something still to delete from memory (`purge`). */
const index = (wsId, bank, purge) => ({ v: 1, ws: wsId, bank, peer: "user", cats: "", facts: {}, items: {}, tomb: { items: {}, facts: {} }, ...(purge ? { purge: { facts: purge.facts ?? [], cards: [], sessions: purge.sessions ?? [], need: {}, tries: 0, at: 0 } } : {}) });

/**
 * The state: Tiger, signed in to Orgo, with the default workspace and four more, each with its Orgo project:
 * Acme (its own bank), Shop (its own bank, which Side shares), Side, and Solo (its own bank).
 */
const PROJECTS = { ws_main: "p_main", ws_acme: "p_acme", ws_shop: "p_shop", ws_side: "p_side", ws_solo: "p_solo" };
S.update((s) => {
  s.owner = { name: "Tiger", timeZone: "America/New_York" };
  s.account = { user: { id: "u_tiger", email: "tiger@example.com" }, signedInAt: 0 };
  s.workspaces = [
    { id: "ws_main", name: "bops", createdAt: 0, orgoProjectId: "p_main", orgoName: "bops" },
    { id: "ws_acme", name: "Acme", createdAt: 1, orgoProjectId: "p_acme", orgoName: "Acme" },
    { id: "ws_shop", name: "Shop", createdAt: 2, orgoProjectId: "p_shop", orgoName: "Shop" },
    { id: "ws_side", name: "Side", createdAt: 3, orgoProjectId: "p_side", orgoName: "Side" },
    { id: "ws_solo", name: "Solo", createdAt: 4, orgoProjectId: "p_solo", orgoName: "Solo" },
  ];
  s.workspace = "ws_main";
  const main = (id, name, wsId) => ({ id, name, role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", ...(wsId ? { workspaceId: wsId } : {}) });
  s.bots = [main("boppy", "Boppy"), main("ada", "Ada", "ws_acme"), { ...main("ash", "Ash", "ws_acme"), isMain: false, role: "Sales" }, main("sam", "Sam", "ws_shop"), main("sid", "Sid", "ws_side"), main("sol", "Sol", "ws_solo")];
  s.chats = s.bots.map((b) => ({ id: botChatId(b.id), kind: "bot", botIds: [b.id], createdAt: 0, typing: [], ...(b.workspaceId ? { workspaceId: b.workspaceId } : {}) }));
  s.routines = [
    { id: "rtn_acme", botId: "ash", title: "Morning leads", goal: "Read new leads.", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, run: "chat" },
    { id: "rtn_main", botId: "boppy", title: "Inbox sweep", goal: "Read the inbox.", schedule: { kind: "daily", times: ["08:00"] }, enabled: true, run: "chat" },
  ];
});
orgo.projects = Object.entries(PROJECTS).map(([wsId, id]) => ({ id, name: ws(wsId).name, product: "bops", bops_ws_id: wsId, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }));
Mem.shareMemory("ws_side", "ws_shop");
assert.equal(Mem.bankOf("ws_side"), "bops-ws_shop");

// Each workspace's issues (sessions in its bank), skills, Orbit index and a memory review; the default's too.
const opened = {};
for (const w of ["ws_main", "ws_acme", "ws_shop", "ws_side", "ws_solo"]) {
  const r = await I.openIssue(w, { title: `${ws(w).name} printer is down`, summary: "It jams.", priority: "high" });
  opened[w] = r.issue.id;
  Sk.createSkill(w, { name: `${ws(w).name} weekly report`, description: "Each Monday", body: "# Weekly report\n" });
}
mkdirSync(catsDir(), { recursive: true });
for (const w of ["ws_main", "ws_acme", "ws_shop", "ws_side", "ws_solo"]) writeFileSync(join(catsDir(), `ws-${w}.json`), JSON.stringify(index(w, Mem.bankOf(w))));
// Acme forgot a fact in the default's bank before it moved to its own: still to delete there.
hbank("bops").facts.push({ id: "f_acme_old", content: "Acme's old fact", observer_id: "user", observed_id: "user", session_id: null, created_at: iso(0), level: "explicit" });
writeFileSync(join(catsDir(), "ws-ws_acme@bops.json"), JSON.stringify(index("ws_acme", "bops", { facts: ["f_acme_old"] })));
writeFileSync(reviewsFile(), JSON.stringify({ "bops-ws_acme": { at: 1, checked: 3, flagged: [{ id: "f1", text: "Acme's flagged words", group: "agent_rules", sure: 0.9 }], kept: [] }, bops: { at: 1, checked: 1, flagged: [], kept: [] } }));
// Read from the file again, as at a start.
globalThis.bopsReviews = undefined;
await new Promise((r) => setTimeout(r, 50));

/* ---------------- The confirm ---------------- */

await check("the confirm names its routines and Orbit issues, and says its memory goes when its bank does", async () => {
  const acme = await preview("ws_acme");
  assert.equal(acme.status, 200);
  assert.deepEqual(acme.body.routines, ["Morning leads"]);
  assert.deepEqual(acme.body.issues, ["Acme printer is down"]);
  assert.equal(acme.body.memory, true, "its own bank, used by no other workspace");
  assert.deepEqual(acme.body.bots, ["Ada", "Ash"]);
  // Shop's bank is Side's too, and Side's is Shop's: neither takes it.
  assert.equal((await preview("ws_shop")).body.memory, false);
  const side = await preview("ws_side");
  assert.deepEqual([side.body.memory, side.body.issues, side.body.routines], [false, ["Side printer is down"], []]);
  assert.ok(!DASHES.test(JSON.stringify([acme.body, side.body])));
  // An orgo-web that lists them too: Orgo's are named with Bops' own, each once.
  orgo.extra.p_solo = { routines: [{ id: "r1", title: "Made on orgo.ai" }], orbitIssues: [{ id: "i1", title: "Solo printer is down" }, { id: "i2", title: "Only on Orgo" }] };
  const solo = await preview("ws_solo");
  assert.deepEqual([solo.body.routines, solo.body.issues], [["Made on orgo.ai"], ["Solo printer is down", "Only on Orgo"]]);
  delete orgo.extra.p_solo;
  assert.deepEqual(bankDeletes(), [], "a preview deletes nothing");
});

await check("the confirm names the apps its bots made only for an account apps are open to (lib/apps-access.ts): Tiger's kept from before aren't said", async () => {
  S.update((s) => (s.madeApps = [{ id: "app_tip", title: "Tip calculator", botId: "ash", chatId: botChatId("ash"), ws: "ws_acme", version: 1, versions: [{ n: 1, note: "", at: 1 }], createdAt: 1, updatedAt: 1 }]));
  orgo.extra.p_acme = { madeApps: [{ title: "Made on Orgo" }] };
  try {
    const outside = await preview("ws_acme");
    assert.equal(outside.status, 200);
    assert.deepEqual(outside.body.madeApps, [], "tiger@example.com: none named, this Mac's or Orgo's");
    assert.ok(!JSON.stringify(outside.body).includes("Tip calculator") && !JSON.stringify(outside.body).includes("Made on Orgo"));
    S.update((s) => (s.account = { ...s.account, user: { ...s.account.user, email: "ava@orgo.ai" } }));
    assert.deepEqual((await preview("ws_acme")).body.madeApps, ["Tip calculator", "Made on Orgo"], "an @orgo.ai account: both");
  } finally {
    S.update((s) => {
      s.account = { ...s.account, user: { ...s.account.user, email: "tiger@example.com" } };
      delete s.madeApps;
    });
    delete orgo.extra.p_acme;
  }
});

/* ---------------- Its own bank ---------------- */

await check("Delete: its own bank goes from Honcho, with what was still to forget in a bank it used before; nothing of it stays on this Mac", async () => {
  assert.ok(existsSync(skillsDir("p_acme")) && existsSync(issuesFile("ws_acme")) && catsFiles("ws_acme").length === 2);
  const del = await Route.DELETE(new Request("http://localhost:3210/api/workspaces", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "ws_acme" }) }));
  assert.equal(del.status, 200);
  assert.equal(ws("ws_acme"), undefined);
  assert.ok(!orgo.projects.some((p) => p.id === "p_acme"), "its Orgo project went first");
  await until(() => !honcho.banks.has("bops-ws_acme") && MD.memoryDeletesForTests.waiting().length === 0, "its bank to go");
  assert.deepEqual(bankDeletes(), ["bops-ws_acme"]);
  await until(() => !honcho.banks.get("bops").facts.some((f) => f.id === "f_acme_old"), "the fact it forgot in the default's bank");
  // On this Mac: its skills' folder, its issues' cache, its Orbit index and the one for the bank it used before, its review.
  assert.equal(existsSync(skillsDir("p_acme")), false);
  assert.equal(existsSync(issuesFile("ws_acme")), false);
  assert.deepEqual(catsFiles("ws_acme"), []);
  const reviews = JSON.parse(readFileSync(reviewsFile(), "utf8"));
  assert.deepEqual(Object.keys(reviews), ["bops"], "its review went, the default's stayed");
  // Every other workspace's stay whole.
  for (const [w, p] of [["ws_main", "p_main"], ["ws_shop", "p_shop"], ["ws_side", "p_side"], ["ws_solo", "p_solo"]]) {
    assert.ok(existsSync(skillsDir(p)), `${w}'s skills`);
    assert.ok(existsSync(issuesFile(w)), `${w}'s issues`);
    assert.equal(catsFiles(w).length, 1, `${w}'s index`);
  }
  assert.deepEqual(sessionsIn("bops"), [opened.ws_main], "the default's bank keeps its issue");
  assert.equal(MD.memoryDeletesForTests.waiting().length, 0, "nothing left waiting");
  // What waited to go: nothing was sent to Orgo for its skills after it went.
  await new Promise((r) => setTimeout(r, 1700));
  assert.ok(!orgo.calls.some((c) => c.path.includes("p_acme/skills")), "no skills sync for a workspace that's gone");
  assert.ok(!existsSync(skillsDir("p_acme")) && !existsSync(issuesFile("ws_acme")), "nor anything written back");
});

/* ---------------- A bank another workspace uses ---------------- */

await check("Delete: a bank another workspace uses stays, and only the deleted one's issues go from it; once nobody else uses it, the next delete takes it whole", async () => {
  assert.deepEqual(sessionsIn("bops-ws_shop").sort(), [opened.ws_shop, opened.ws_side].sort());
  await Rm.deleteWorkspace("ws_shop");
  await until(() => !sessionsIn("bops-ws_shop").includes(opened.ws_shop), "Shop's issue to go");
  assert.ok(honcho.banks.has("bops-ws_shop"), "Side still uses the bank");
  assert.deepEqual(sessionsIn("bops-ws_shop"), [opened.ws_side], "Side's issue stays");
  assert.ok(!bankDeletes().includes("bops-ws_shop"));
  // Side still reads its issues from the bank.
  const left = await I.listIssues("ws_side", { fresh: true });
  assert.deepEqual(left.issues.map((i) => i.id), [opened.ws_side]);
  // Side now has the bank to itself: its delete takes it.
  assert.equal((await preview("ws_side")).body.memory, true);
  await Rm.deleteWorkspace("ws_side");
  await until(() => !honcho.banks.has("bops-ws_shop"), "the bank to go with the last workspace using it");
  assert.deepEqual(catsFiles("ws_shop"), []);
  assert.deepEqual(catsFiles("ws_side"), []);
});

await check("Delete: the user's own bank never goes, even shared by the workspace deleted", async () => {
  S.update((s) => s.workspaces.push({ id: "ws_guest", name: "Guest", createdAt: 9 }));
  S.update((s) => s.bots.push({ id: "gus", name: "Gus", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", workspaceId: "ws_guest" }));
  Mem.shareMemory("ws_guest", "ws_main");
  const r = await I.openIssue("ws_guest", { title: "Guest wifi", summary: "Slow." });
  assert.equal((await preview("ws_guest")).body.memory, false);
  await Rm.deleteWorkspace("ws_guest");
  await until(() => !sessionsIn("bops").includes(r.issue.id), "its issue to go from the shared bank");
  assert.ok(honcho.banks.has("bops"), "the user's bank stays");
  assert.ok(sessionsIn("bops").includes(opened.ws_main), "with the default's issue");
  assert.ok(!bankDeletes().includes("bops"));
});

/* ---------------- Honcho away, or refusing ---------------- */

await check("Delete: Honcho away keeps the bank's delete in an outbox on disk, sent once it answers; a bank taken up again since is never deleted", async () => {
  honcho.down = true;
  await Rm.deleteWorkspace("ws_solo");
  assert.equal(ws("ws_solo"), undefined, "the workspace went anyway");
  await until(() => MD.memoryDeletesForTests.retrying(), "a retry to be set");
  const waiting = MD.memoryDeletesForTests.waiting();
  assert.deepEqual(waiting.map((e) => [e.wsId, e.item.bank, e.item.sessions]), [["ws_solo", "bops-ws_solo", undefined]]);
  await until(() => existsSync(join(userDir(), "outbox", "memory-deletes.json")), "the outbox on disk");
  assert.match(readFileSync(join(userDir(), "outbox", "memory-deletes.json"), "utf8"), /bops-ws_solo/);
  // Still away: kept.
  assert.equal(await MD.flushMemoryDeletes(), false);
  honcho.down = false;
  assert.equal(await MD.flushMemoryDeletes(), true);
  assert.ok(!honcho.banks.has("bops-ws_solo"));
  await until(() => !existsSync(join(userDir(), "outbox", "memory-deletes.json")), "the outbox emptied on disk");
  MD.memoryDeletesForTests.reset();
  // A bank a workspace listed now uses (taken up again since the delete was queued) stays.
  hbank("bops-ws_back").sessions.set("bops-chat-x", { id: "bops-chat-x", metadata: {}, configuration: {}, peers: {}, messages: [] });
  await MD.deleteWorkspaceMemory("ws_gone", { bank: "bops-ws_back", peer: "user" }).catch(() => {});
  assert.ok(!honcho.banks.has("bops-ws_back"), "with nobody on it, it goes");
  hbank("bops-ws_back");
  S.update((s) => s.workspaces.push({ id: "ws_back", name: "Back", createdAt: 10 }));
  assert.equal(await MD.deleteWorkspaceMemory("ws_gone2", { bank: "bops-ws_back", peer: "user" }), true);
  assert.ok(honcho.banks.has("bops-ws_back"), "a workspace uses it now: never deleted");
  S.update((s) => (s.workspaces = s.workspaces.filter((w) => w.id !== "ws_back")));
});

await check("Delete: a Honcho that refuses a bank with sessions gets them deleted first, then the bank; one that never takes it (403) is given up on, said in the log", async () => {
  honcho.refuseWithSessions = true;
  const b = hbank("bops-ws_full");
  for (let i = 0; i < 3; i++) b.sessions.set(`bops-chat-${i}`, { id: `bops-chat-${i}`, metadata: {}, configuration: {}, peers: {}, messages: [] });
  assert.equal(await MD.deleteWorkspaceMemory("ws_full", { bank: "bops-ws_full", peer: "user" }), true);
  assert.ok(!honcho.banks.has("bops-ws_full"));
  assert.equal(honcho.calls.filter((c) => c.method === "DELETE" && /\/v3\/workspaces\/bops-ws_full\/sessions\//.test(c.path)).length, 3, "each session, by id");
  honcho.refuseWithSessions = false;
  honcho.refuseDeletes = 403;
  hbank("bops-ws_locked");
  const n = warned.length;
  assert.equal(await MD.deleteWorkspaceMemory("ws_locked", { bank: "bops-ws_locked", peer: "user" }), true, "not kept waiting");
  assert.deepEqual(MD.memoryDeletesForTests.waiting(), []);
  assert.match(warned.slice(n).join("\n"), /memory answered 403 to deleting ws_locked's memory; not asked again/);
  warned.splice(n);
  honcho.refuseDeletes = 0;
  honcho.banks.delete("bops-ws_locked");
});

/* ---------------- The window's localStorage ---------------- */

await check("the window forgets what it kept for a deleted workspace, and only that", async () => {
  const kept = new Map(
    Object.entries({
      "bops.knowledge.seen.u_tiger.ws_acme": "17",
      "bops.knowledge.seen.u_tiger.ws_main": "18",
      "bops.knowledge.seen.u_tiger.ws_acme2": "19",
      "bops.crm.view.ws_acme.leads.csv": "{}",
      "bops.side.open.u_tiger.ws_acme.routines": "1",
      "bops.side.group.u_tiger.ws_acme": "0",
      "bops.sidebar": "1",
      "other.ws_acme": "x",
    }),
  );
  const store = { get length() { return kept.size; }, key: (i) => [...kept.keys()][i] ?? null, removeItem: (k) => kept.delete(k) };
  assert.equal(forgetWorkspaceHere("ws_acme", store), 4);
  assert.deepEqual([...kept.keys()].sort(), ["bops.knowledge.seen.u_tiger.ws_acme2", "bops.knowledge.seen.u_tiger.ws_main", "bops.sidebar", "other.ws_acme"]);
  assert.equal(forgetWorkspaceHere("ws_main", store), 0, "never the default's");
  assert.equal(forgetWorkspaceHere("ws_acme", null), 0, "no localStorage: nothing, no throw");
  const broken = { get length() { throw new Error("blocked"); }, key: () => null, removeItem: () => {} };
  assert.equal(forgetWorkspaceHere("ws_acme", broken), 0);
});

await check("nothing unexpected: no rejections, no unknown Honcho calls, no stray warnings", async () => {
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(rejections, []);
  assert.deepEqual(honcho.unknown, []);
  assert.deepEqual(warned.filter((w) => /\[(memory|issues|categories)\]/.test(w)), []);
});

MD.memoryDeletesForTests.reset();
console.log(`\nworkspace delete: ${passed} passed, ${failures} failed`);
if (!failures) rmSync(scratch, { recursive: true, force: true });
else console.log(`The throwaway folder is kept for a look: ${scratch}`);
process.exit(failures ? 1 : 0);
