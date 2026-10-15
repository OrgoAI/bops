// Tests for Bops workspaces as Orgo workspaces (lib/server/workspaces.ts, lib/server/orgo.ts, the keys'
// scope in lib/server/keys.ts; .ops-kit/bops-workspaces/DESIGN.md): against an orgo-web as it is in
// production today (no `product` on projects, no new routes) nothing is made, moved, renamed or deleted,
// and every workspace's computers keep going to the one "bops" project; against an orgo-web with per
// workspace projects, the move on sign-in binds the default workspace to the "bops" project, makes a
// marked project for each workspace with a computer (a name the user's Orgo already has gets " (Bops)"),
// copies the people, moves each own computer (one Orgo won't move yet waits, and moves on a later run),
// renames the default and moves the skills folders; run again it calls nothing; stopped after any call it
// resumes to the same end; a rollback puts every computer back and deletes only the empty projects it made.
// New workspace, Rename and Delete follow it (a name taken is asked about); keys are this workspace's or
// all workspaces'. orgo-web is a fake (a local server), the Keychain is never there, and the state lives in a
// throwaway folder: nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-ws-migration.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.BOPS_APP_VERSION = "9.9.9";
const UI = "ui-token-test-ws";
process.env.BOPS_UI_TOKEN = UI;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-ws-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const ORGO_KEY = "sk_orgo_test_ws";
globalThis.bopsOrgoKey = ORGO_KEY;
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
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(String(e?.stack ?? e)));

/* ---------------- A fake orgo-web: today's, or one with per workspace projects ---------------- */

/**
 * The fake's world: projects (each with its computers), computers by id, secrets. `modern`: projects carry
 * `product` and `bops_ws_id`, and the new routes answer (members copy, the legacy list for old apps).
 * `blocked`: computers the move route answers 409 for. `failAt`: the nth call that changes something does
 * its work and then answers 500 (a crash after Orgo did it, before the app heard).
 */
const orgo = { modern: false, projects: [], computers: new Map(), secrets: [], blocked: new Set(), calls: [], changes: 0, failAt: 0, seq: 0, members: [] };
const project = (p) => ({ id: p.id, name: p.name, role: "owner", created_at: p.created_at, member_count: 1, desktops: [...orgo.computers.values()].filter((c) => c.project === p.id).map((c) => ({ id: c.id, name: c.name })), ...(orgo.modern ? { product: p.product, bops_ws_id: p.bops_ws_id ?? null } : {}) });
function world({ modern }) {
  orgo.modern = modern;
  orgo.calls = [];
  orgo.changes = 0;
  orgo.failAt = 0;
  orgo.blocked = new Set();
  orgo.members = [];
  orgo.projects = [
    { id: "p_bops", name: "bops", product: "bops", created_at: "2026-01-01T00:00:00Z" },
    // An older Bops one by name (another case): the free computer decides which is the default's.
    { id: "p_bops_old", name: "Bops", product: "bops", created_at: "2025-06-01T00:00:00Z" },
    // The user's own Orgo workspace named "orgo".
    { id: "p_orgo", name: "orgo", product: "orgo", created_at: "2026-02-01T00:00:00Z" },
  ];
  orgo.computers = new Map(
    [
      ["c_free", "p_bops"],
      ["c_max", "p_bops"],
      ["c_orgo", "p_bops"],
      ["c_busy", "p_bops"],
      ["c_mine", "p_orgo"],
    ].map(([id, p]) => [id, { id, name: id, project: p }]),
  );
  orgo.secrets = [
    { name: "STRIPE_SECRET_KEY", workspace_id: null, value: "sk_test_fake_account" },
    { name: "GITHUB_TOKEN", workspace_id: "p_orgo", value: "fake_not_bops" },
  ];
}
const send = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};
const html404 = (res) => {
  res.writeHead(404, { "content-type": "text/html" });
  res.end("<!doctype html><title>404</title>");
};
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  const url = new URL(req.url, "http://fake");
  const body = text ? JSON.parse(text) : undefined;
  const call = { method: req.method, path: url.pathname, search: url.search, body, app: req.headers["x-bops-app"] };
  orgo.calls.push(call);
  if (req.headers.authorization !== `Bearer ${ORGO_KEY}`) return send(res, 401, { error: "Not authenticated" });
  // A change, done; the one asked to fail answers 500 after doing it.
  const changed = (status, obj) => {
    orgo.changes++;
    if (orgo.failAt && orgo.changes === orgo.failAt) return send(res, 500, { error: "boom" });
    return send(res, status, obj);
  };
  const p = url.pathname;
  if (p === "/api/workspaces" && req.method === "GET") return send(res, 200, { workspaces: orgo.projects.map(project) });
  if (p === "/api/workspaces" && req.method === "POST") {
    const name = String(body?.name ?? "").trim();
    if (orgo.modern && body?.bops_ws_id) {
      const had = orgo.projects.find((x) => x.bops_ws_id === body.bops_ws_id);
      if (had) return changed(200, { id: had.id, name: had.name });
    }
    if (orgo.projects.some((x) => x.name.toLowerCase() === name.toLowerCase())) return send(res, 400, { error: "A project with this name already exists" });
    const id = `p_new${++orgo.seq}`;
    orgo.projects.push({ id, name, created_at: new Date().toISOString(), ...(orgo.modern ? { product: body?.product ?? (name.toLowerCase() === "bops" ? "bops" : "orgo"), bops_ws_id: body?.bops_ws_id ?? null } : { product: name.toLowerCase() === "bops" ? "bops" : "orgo" }) });
    return changed(201, { id, name });
  }
  const one = p.match(/^\/api\/workspaces\/([^/]+)$/);
  if (one) {
    const x = orgo.projects.find((y) => y.id === one[1]);
    if (!x) return send(res, 404, { error: "Not found" });
    if (req.method === "GET") {
      // The list an old app (no x-bops-app) reads its "bops" project by: every Bops project's computers there.
      const legacy = orgo.modern && !req.headers["x-bops-app"] && x.bops_ws_id === "ws_main";
      const desktops = [...orgo.computers.values()].filter((c) => (legacy ? orgo.projects.some((y) => y.id === c.project && y.product === "bops") : c.project === x.id)).map((c) => ({ id: c.id, name: c.name }));
      return send(res, 200, { id: x.id, name: x.name, desktops });
    }
    if (req.method === "PATCH") {
      if (body?.name !== undefined) {
        if (orgo.projects.some((y) => y.id !== x.id && y.name.toLowerCase() === String(body.name).toLowerCase())) return send(res, 400, { error: "A project with this name already exists" });
        x.name = body.name;
      }
      if (orgo.modern && body?.bops_ws_id !== undefined && !x.bops_ws_id) x.bops_ws_id = body.bops_ws_id;
      return changed(200, { id: x.id, name: x.name });
    }
    if (req.method === "DELETE") {
      orgo.projects = orgo.projects.filter((y) => y.id !== x.id);
      return changed(200, { ok: true });
    }
  }
  const copy = p.match(/^\/api\/workspaces\/([^/]+)\/members\/copy$/);
  if (copy && req.method === "POST") {
    if (!orgo.modern) return html404(res);
    orgo.members.push({ to: copy[1], from: body?.from });
    return changed(200, { copied: 2 });
  }
  const comp = p.match(/^\/api\/computers\/([^/]+)$/);
  if (comp && req.method === "GET") {
    const c = orgo.computers.get(comp[1]);
    return c ? send(res, 200, { id: c.id, name: c.name, project_id: c.project, workspace_id: c.project }) : send(res, 404, { error: "Computer not found" });
  }
  const move = p.match(/^\/api\/computers\/([^/]+)\/move$/);
  if (move && req.method === "POST") {
    if (!orgo.modern) return html404(res);
    const c = orgo.computers.get(move[1]);
    if (!c) return send(res, 404, { error: "Computer not found" });
    if (c.project === body.workspace_id) return send(res, 400, { error: "Already in this workspace" });
    if (orgo.blocked.has(c.id)) return send(res, 409, { error: "It's busy right now", code: "computer_busy" });
    c.project = body.workspace_id;
    return changed(200, { ok: true });
  }
  if (p === "/api/computers" && req.method === "POST") {
    const id = `c_made${++orgo.seq}`;
    orgo.computers.set(id, { id, name: body.name, project: body.workspace_id });
    return changed(201, { id, name: body.name, status: "running" });
  }
  if (p === "/api/user/subscription") return send(res, 200, { tier: "hacker" });
  if (p === "/api/billing/compute-limits") return send(res, 200, { max_computers: 10, computers_used: 4, bops_free_computer_id: "c_free" });
  if (p === "/api/secrets" && req.method === "GET") return send(res, 200, { secrets: orgo.secrets.map(({ name, workspace_id }) => ({ name, workspace_id, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" })) });
  if (p === "/api/secrets" && req.method === "POST") {
    orgo.secrets = orgo.secrets.filter((x) => !(x.name === body.name && x.workspace_id === (body.workspace_id ?? null)));
    orgo.secrets.push({ name: body.name, workspace_id: body.workspace_id ?? null, value: body.value });
    return send(res, 200, { ok: true });
  }
  const del = p.match(/^\/api\/secrets\/([A-Z0-9_]+)$/);
  if (del && req.method === "DELETE") {
    const ws = url.searchParams.get("workspace_id");
    orgo.secrets = orgo.secrets.filter((x) => !(x.name === del[1] && x.workspace_id === ws));
    return send(res, 200, { ok: true });
  }
  if (p === "/api/secrets/call") {
    const scoped = orgo.secrets.find((x) => x.name === body.name && x.workspace_id === (body.workspace_id ?? "none"));
    const used = scoped ?? orgo.secrets.find((x) => x.name === body.name && !x.workspace_id);
    return send(res, 200, { status: 200, contentType: "application/json", body: { used: used ? (used.workspace_id ? "workspace" : "account") : "none" }, truncated: false, headers: {} });
  }
  if (p.includes("/skills")) return html404(res);
  return send(res, 404, { error: `fake orgo-web has no ${req.method} ${p}` });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.BOPS_ORGO_ORIGIN = `http://127.0.0.1:${server.address().port}`;

/* ---------------- Helpers ---------------- */

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

const S = await import(`${root}/lib/server/store.ts`);
const O = await import(`${root}/lib/server/orgo.ts`);
const Wk = await import(`${root}/lib/server/workspaces.ts`);
const Sk = await import(`${root}/lib/server/workspace-skills.ts`);
const K = await import(`${root}/lib/server/keys.ts`);
const Rm = await import(`${root}/lib/server/remove.ts`);
const Route = await import(`${root}/app/api/workspaces/route.ts`);
const KeysRoute = await import(`${root}/app/api/keys/route.ts`);

/** A clean state: three workspaces besides the default, each team with its computers as the design's census has them. */
function seed() {
  const g = globalThis;
  g.bopsOrgoWorkspace = undefined;
  g.bopsOrgoPerWorkspace = undefined;
  g.bopsOrgoPlan = undefined;
  g.bopsKeys = undefined;
  S.update((s) => {
    s.owner = { name: "Tiger" };
    s.workspaces = [
      { id: "ws_main", name: "Main", createdAt: 0 },
      { id: "ws_orgo", name: "orgo", createdAt: 10 },
      { id: "ws_quiet", name: "Quiet", createdAt: 20 },
      { id: "ws_busy", name: "Acme", createdAt: 30 },
    ];
    s.workspace = "ws_main";
    s.bots = [
      // The free Bops computer: it never moves.
      { id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "ready", computerId: "c_free", freeComputer: true },
      { id: "max", name: "Max", role: "Sales", color: "#5B8CFF", isMain: false, computerStatus: "ready", computerId: "c_max", computer: "own" },
      { id: "oscar", name: "Oscar", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "ready", computerId: "c_orgo", workspaceId: "ws_orgo" },
      { id: "quinn", name: "Quinn", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", workspaceId: "ws_quiet" },
      { id: "bea", name: "Bea", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "ready", computerId: "c_busy", workspaceId: "ws_busy" },
    ];
    delete s.orgoMigration;
  });
}
const ws = (id) => S.getState().workspaces.find((w) => w.id === id);
const changes = () => orgo.calls.filter((c) => c.method !== "GET");
const where = (id) => orgo.computers.get(id)?.project;
const named = (name) => orgo.projects.find((p) => p.name === name);
const post = (body) => new Request("http://localhost:3210/api/workspaces", { method: "POST", headers: { "content-type": "application/json", "x-bops-window": UI }, body: JSON.stringify(body) });
const req = (method, body) => new Request("http://localhost:3210/api/workspaces", { method, headers: { "content-type": "application/json", "x-bops-window": UI }, body: JSON.stringify(body) });

/* ---------------- Today's orgo-web: exactly as before ---------------- */

await check("Today's orgo-web (no per workspace projects): the move does nothing and sends nothing", async () => {
  world({ modern: false });
  seed();
  const before = JSON.stringify(S.getState().workspaces);
  const r = await Wk.migrateWorkspacesToOrgo();
  assert.deepEqual(r, { status: "legacy" });
  assert.deepEqual(changes(), [], "nothing made, moved, renamed or deleted");
  assert.equal(S.getState().orgoMigration, undefined, "no partial move recorded");
  assert.equal(JSON.stringify(S.getState().workspaces), before, "every workspace as it was");
  assert.equal(await O.perWorkspaceProjects(), false);
});

await check("Today's orgo-web: every workspace's computers go to the one bops project; New workspace, Rename and Delete stay on this Mac", async () => {
  world({ modern: false });
  seed();
  assert.equal(await O.orgoProjectFor("ws_orgo"), "p_bops", "another workspace's computer: the bops project, as before");
  assert.equal(await O.orgoProjectFor("ws_main"), "p_bops");
  const made = await O.orgo.create("Oscar 2", { wsId: "ws_orgo", ram: 8 });
  assert.equal(where(made.id), "p_bops");
  assert.deepEqual((await O.orgo.bopsComputers()).map((c) => c.id).sort(), ["c_busy", "c_free", "c_max", "c_orgo", made.id].sort());
  const n = changes().length;
  const res = await Route.POST(post({ name: "orgo" }));
  assert.equal(res.status, 200);
  const created = await res.json();
  assert.match(created.id, /^ws_/);
  assert.equal(created.orgoProjectId, undefined);
  assert.equal(ws(created.id).name, "orgo 2", "a second local orgo gets a number");
  assert.equal((await Route.PATCH(req("PATCH", { id: created.id, name: "Renamed" }))).status, 200);
  assert.equal(ws(created.id).name, "Renamed");
  await Rm.deleteWorkspace(created.id);
  assert.deepEqual(changes().slice(n).map((c) => `${c.method} ${c.path}`), [], "nothing on Orgo for any of it");
  // Every call says which app it is (the new header too, which today's orgo-web ignores).
  assert.ok(orgo.calls.every((c) => c.app === "9.9.9"), "x-bops-app on every call");
});

await check("Today's orgo-web: keys are all for all workspaces, and This workspace isn't offered", async () => {
  world({ modern: false });
  seed();
  const res = await KeysRoute.GET(new Request("http://localhost:3210/api/keys?fresh=1", { headers: { "x-bops-window": UI } }));
  const j = await res.json();
  assert.equal(j.workspaceKeys, false);
  assert.deepEqual(j.keys.map((k) => [k.name, k.scope]), [["STRIPE_SECRET_KEY", "all"]], "a secret scoped to a workspace that isn't Bops' isn't one of Bops' keys");
  await assert.rejects(K.saveKey("GITHUB_TOKEN", "fake", [], "workspace"), /no Orgo workspace of its own yet/);
});

/* ---------------- An orgo-web with per workspace projects ---------------- */

let clean;
await check("The move: default bound, a project for each workspace with a computer, a taken name gets (Bops), people copied, computers moved", async () => {
  world({ modern: true });
  seed();
  // A skill made before the move, in its workspace's folder by its Bops id.
  Sk.createSkill("ws_orgo", { name: "Orgo report", description: "When asked", body: "# Orgo report\n" });
  assert.ok(existsSync(join(process.cwd(), ".data", "workspaces", "ws_orgo", "skills", "orgo-report", "SKILL.md")));
  orgo.blocked.add("c_busy");
  const r = await Wk.migrateWorkspacesToOrgo();
  assert.equal(r.status, "done", JSON.stringify(r));
  // 1. The default: the bops project holding the free computer (not the older "Bops"), tied to it.
  assert.equal(ws("ws_main").orgoProjectId, "p_bops");
  assert.equal(orgo.projects.find((p) => p.id === "p_bops").bops_ws_id, "ws_main");
  assert.equal(orgo.projects.find((p) => p.id === "p_bops_old").bops_ws_id ?? null, null, "the other Bops one stays unbound");
  // 2. "orgo": the user's Orgo already has one, so "orgo (Bops)", marked and tied; the notice says so.
  const o = named("orgo (Bops)");
  assert.ok(o, orgo.projects.map((p) => p.name).join(", "));
  assert.deepEqual([o.product, o.bops_ws_id], ["bops", "ws_orgo"]);
  assert.equal(ws("ws_orgo").orgoProjectId, o.id);
  assert.deepEqual(r.renamed, [{ wsId: "ws_orgo", from: "orgo", to: "orgo (Bops)" }]);
  assert.deepEqual(Wk.migrationNotice(), { pending: 1, renamed: [{ wsId: "ws_orgo", from: "orgo", to: "orgo (Bops)" }] });
  const a = named("Acme");
  assert.equal(ws("ws_busy").orgoProjectId, a.id);
  // A workspace with no computer gets its project with its first one.
  assert.equal(ws("ws_quiet").orgoProjectId, undefined);
  assert.equal(orgo.projects.some((p) => p.bops_ws_id === "ws_quiet"), false);
  // 3. People copied to each new one, from the bops project.
  assert.deepEqual(orgo.members.map((m) => [m.to, m.from]).sort(), [[a.id, "p_bops"], [o.id, "p_bops"]].sort());
  // 4. Computers: Oscar's to orgo (Bops); Max's stays; the free one never moves; the busy one waits.
  assert.equal(where("c_orgo"), o.id);
  assert.equal(where("c_max"), "p_bops");
  assert.equal(where("c_free"), "p_bops");
  assert.equal(where("c_busy"), "p_bops");
  assert.equal(where("c_mine"), "p_orgo", "the user's own Orgo computer is never touched");
  assert.deepEqual(S.getState().orgoMigration.moves, [{ computerId: "c_orgo", from: "p_bops", to: o.id }]);
  assert.deepEqual(S.getState().orgoMigration.pending, ["c_busy"]);
  // 5. "Main" left as it was is "bops" now; its project kept the name.
  assert.equal(ws("ws_main").name, "bops");
  assert.equal(orgo.projects.find((p) => p.id === "p_bops").name, "bops");
  // 6. The skills folder went to the project's id.
  assert.ok(!existsSync(join(process.cwd(), ".data", "workspaces", "ws_orgo")));
  assert.ok(existsSync(join(process.cwd(), ".data", "workspaces", o.id, "skills", "orgo-report", "SKILL.md")));
  assert.equal(Sk.skillDetail("ws_orgo", "skill", "orgo-report").missing, false, "still found where it's looked for");
  // Only Bops' own projects were changed: the user's "orgo" wasn't renamed, moved into or tied.
  assert.deepEqual(orgo.projects.find((p) => p.id === "p_orgo"), { id: "p_orgo", name: "orgo", product: "orgo", created_at: "2026-02-01T00:00:00Z" });
  // An old app reading its "bops" project (no x-bops-app) still sees Oscar's moved computer, so it never makes another.
  const old = await fetch(`${process.env.BOPS_ORGO_ORIGIN}/api/workspaces/p_bops`, { headers: { Authorization: `Bearer ${ORGO_KEY}` } }).then((x) => x.json());
  assert.ok(old.desktops.some((d) => d.id === "c_orgo"), "the legacy list has the moved computer");
  const mine = await O.orgo.bopsComputers();
  assert.deepEqual(mine.map((c) => c.id).sort(), ["c_busy", "c_free", "c_max", "c_orgo"], "this app merges every Bops project's, the user's own Orgo one's not");
  clean = { names: S.getState().workspaces.map((w) => [w.id, w.name, orgo.projects.find((p) => p.id === w.orgoProjectId)?.name ?? null]), where: [...orgo.computers.values()].map((c) => [c.id, orgo.projects.find((p) => p.id === c.project)?.name]) };
});

await check("Run again: the waiting computer moves once Orgo lets it; then nothing is called at all", async () => {
  orgo.blocked.delete("c_busy");
  const r = await Wk.migrateWorkspacesToOrgo();
  assert.equal(r.status, "done");
  assert.equal(where("c_busy"), ws("ws_busy").orgoProjectId);
  assert.deepEqual(S.getState().orgoMigration.pending, []);
  assert.equal(S.getState().orgoMigration.moves.length, 2);
  const n = orgo.calls.length;
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  assert.equal(orgo.calls.length, n, "no further calls once it's done");
});

await check("New workspace: its Orgo workspace is made too, marked and tied; a name the user's Orgo has is asked about", async () => {
  // The user's own Orgo workspace "Clients": a Bops one by that name is asked about, and nothing is made.
  orgo.projects.push({ id: "p_clients", name: "Clients", product: "orgo", created_at: "2026-03-01T00:00:00Z" });
  const before = S.getState().workspaces.length;
  const n = orgo.projects.length;
  const taken = await Route.POST(post({ name: "Clients" }));
  assert.equal(taken.status, 409);
  assert.deepEqual(await taken.json(), { error: "You already have an Orgo workspace named Clients. Name this one", code: "name_taken", suggestion: "Clients (Bops)" });
  assert.equal(S.getState().workspaces.length, before, "nothing made here");
  assert.equal(orgo.projects.length, n, "nor on Orgo");
  // The name it suggests works.
  const asked = await (await Route.POST(post({ name: "Clients (Bops)" }))).json();
  assert.deepEqual([named("Clients (Bops)").product, named("Clients (Bops)").bops_ws_id], ["bops", asked.id]);
  // Two here with one name: the later gets a number (and its own project by that name).
  const twin = await (await Route.POST(post({ name: "Clients (Bops)" }))).json();
  assert.equal(ws(twin.id).name, "Clients (Bops) 2");
  assert.equal(named("Clients (Bops) 2").bops_ws_id, twin.id);
  await Rm.deleteWorkspace(asked.id);
  await Rm.deleteWorkspace(twin.id);
  const fine = await Route.POST(post({ name: "Ventures" }));
  assert.equal(fine.status, 200);
  const made = await fine.json();
  assert.equal(S.getState().workspaces.length, before + 1);
  assert.equal(S.getState().workspace, made.id, "the new one is the current one");
  const p = orgo.projects.find((x) => x.id === made.orgoProjectId);
  assert.deepEqual([p.name, p.product, p.bops_ws_id], ["Ventures", "bops", made.id]);
  // Rename: Orgo first; one the user's Orgo has is refused, and nothing changes.
  const clash = await Route.PATCH(req("PATCH", { id: made.id, name: "orgo" }));
  assert.equal(clash.status, 409);
  assert.equal((await clash.json()).code, "name_taken");
  assert.equal(ws(made.id).name, "Ventures");
  assert.equal((await Route.PATCH(req("PATCH", { id: made.id, name: "Ventures Two" }))).status, 200);
  assert.equal(p.name, "Ventures Two");
  assert.equal(ws(made.id).name, "Ventures Two");
  // A computer for its bot goes into its own project.
  const c = await O.orgo.create("V", { wsId: made.id, ram: 8 });
  assert.equal(where(c.id), p.id);
  // Delete: its Orgo workspace goes once it's empty; with a computer Orgo couldn't delete, it stays.
  orgo.computers.delete(c.id);
  await Rm.deleteWorkspace(made.id);
  assert.equal(orgo.projects.some((x) => x.id === p.id), false, "the empty project went");
  // The quiet workspace's first computer makes its project then.
  const q = await O.orgo.create("Quinn", { wsId: "ws_quiet", ram: 8 });
  const qp = orgo.projects.find((x) => x.bops_ws_id === "ws_quiet");
  assert.deepEqual([qp.name, qp.product, where(q.id)], ["Quiet", "bops", qp.id]);
  assert.equal(ws("ws_quiet").orgoProjectId, qp.id);
});

await check("Keys: a workspace's own key shows only in it; an account key in every workspace; calls go with the workspace", async () => {
  orgo.secrets.push({ name: "GITHUB_TOKEN", workspace_id: ws("ws_orgo").orgoProjectId, value: "fake_orgo_ws" });
  const list = async (current) => {
    S.update((s) => (s.workspace = current));
    const j = await (await KeysRoute.GET(new Request("http://localhost:3210/api/keys?fresh=1", { headers: { "x-bops-window": UI } }))).json();
    return { offered: j.workspaceKeys, keys: j.keys.map((k) => `${k.name}:${k.scope}`).sort() };
  };
  assert.deepEqual(await list("ws_main"), { offered: true, keys: ["STRIPE_SECRET_KEY:all"] }, "not orgo's, and not the user's own Orgo workspace's");
  assert.deepEqual(await list("ws_orgo"), { offered: true, keys: ["GITHUB_TOKEN:workspace", "STRIPE_SECRET_KEY:all"] });
  // Saved for This workspace: the vault's workspace_id is the workspace's project.
  S.update((s) => (s.workspace = "ws_busy"));
  await K.saveKey("STRIPE_SECRET_KEY", "sk_test_fake_busy", ["bea"], "workspace");
  const saved = orgo.calls.findLast((c) => c.method === "POST" && c.path === "/api/secrets");
  assert.equal(saved.body.workspace_id, ws("ws_busy").orgoProjectId);
  assert.deepEqual(await list("ws_busy"), { offered: true, keys: ["STRIPE_SECRET_KEY:all", "STRIPE_SECRET_KEY:workspace"] });
  // A bot calls with its workspace: Orgo picks that workspace's key over the account's.
  K.grantKey("GITHUB_TOKEN", "oscar", true);
  K.grantKey("GITHUB_TOKEN", "max", true);
  assert.deepEqual((await K.usableKeys(S.bot("oscar"))).map((k) => k.name), ["GITHUB_TOKEN"]);
  assert.deepEqual((await K.usableKeys(S.bot("max"))).map((k) => k.name), [], "not in Max's workspace");
  const out = await K.callApi("oscar", { key: "GITHUB_TOKEN", method: "GET", path: "/user", query: null, body: null }, {});
  assert.match(out.text, /"used":"workspace"/);
  assert.equal(orgo.calls.findLast((c) => c.path === "/api/secrets/call").body.workspace_id, ws("ws_orgo").orgoProjectId);
  // Removed from This workspace only: the account's stays, and Bea keeps using that one.
  K.grantKey("STRIPE_SECRET_KEY", "bea", true);
  S.update((s) => (s.workspace = "ws_busy"));
  await K.removeKey("STRIPE_SECRET_KEY", "workspace");
  assert.equal(orgo.calls.findLast((c) => c.method === "DELETE").search, `?workspace_id=${ws("ws_busy").orgoProjectId}`);
  assert.deepEqual(await list("ws_busy"), { offered: true, keys: ["STRIPE_SECRET_KEY:all"] });
  assert.ok(S.bot("bea").keys.includes("STRIPE_SECRET_KEY"), "the account key by that name is still hers");
  S.update((s) => (s.workspace = "ws_main"));
});

await check("Stopped after any call it makes, it resumes to the same end", async () => {
  let runs = 0;
  for (let at = 1; at <= 12; at++) {
    world({ modern: true });
    seed();
    orgo.blocked.add("c_busy");
    orgo.failAt = at;
    let r = await Wk.migrateWorkspacesToOrgo();
    runs++;
    // Started again (the next sign-in), until done.
    for (let i = 0; i < 4 && r.status !== "done"; i++) {
      orgo.failAt = 0;
      r = await Wk.migrateWorkspacesToOrgo();
      runs++;
    }
    assert.equal(r.status, "done", `stopped at change ${at}`);
    const end = { names: S.getState().workspaces.map((w) => [w.id, w.name, orgo.projects.find((p) => p.id === w.orgoProjectId)?.name ?? null]), where: [...orgo.computers.values()].map((c) => [c.id, orgo.projects.find((p) => p.id === c.project)?.name]) };
    assert.deepEqual(end, clean, `stopped at change ${at}: ${JSON.stringify(end)}`);
    assert.equal(orgo.projects.filter((p) => p.bops_ws_id === "ws_orgo").length, 1, "never two projects for one workspace");
    assert.deepEqual(S.getState().orgoMigration.pending, ["c_busy"]);
  }
  assert.ok(runs >= 12);
});

await check("Roll back: every computer goes back where it was; only the empty projects it made go", async () => {
  world({ modern: true });
  seed();
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  const acme = ws("ws_busy").orgoProjectId;
  const orgoBops = ws("ws_orgo").orgoProjectId;
  assert.equal(where("c_orgo"), orgoBops);
  assert.equal(where("c_busy"), acme);
  // Someone put another computer in Acme's project since: it isn't empty, so it stays.
  orgo.computers.set("c_later", { id: "c_later", name: "later", project: acme });
  const r = await Wk.revertWorkspaceMigration();
  assert.deepEqual(r, { movedBack: 2, deleted: 1, kept: 1 });
  assert.equal(where("c_orgo"), "p_bops");
  assert.equal(where("c_busy"), "p_bops");
  assert.equal(orgo.projects.some((p) => p.id === orgoBops), false, "orgo (Bops) was empty, and went");
  assert.ok(orgo.projects.some((p) => p.id === acme), "Acme's has a computer, and stays");
  assert.ok(orgo.projects.some((p) => p.id === "p_bops") && orgo.projects.some((p) => p.id === "p_orgo"), "nothing else deleted");
  assert.ok(S.getState().workspaces.every((w) => !w.orgoProjectId));
  assert.equal(S.getState().orgoMigration, undefined);
  assert.equal(ws("ws_main").name, "Main");
});

await check("Nothing unexpected: no stray warnings or rejections", async () => {
  assert.deepEqual(warned.filter((w) => !/^\[workspaces\] moving onto Orgo workspaces/.test(w)), []);
  assert.deepEqual(rejections, []);
});

server.close();
console.log(`\nws migration: ${passed} passed, ${failed} failed`);
if (!failed) rmSync(scratch, { recursive: true, force: true });
else console.log(`The throwaway folder is kept for a look: ${scratch}`);
process.exit(failed ? 1 : 0);
