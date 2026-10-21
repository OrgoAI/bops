// Tests for Bops workspaces as Orgo workspaces (lib/server/workspaces.ts, lib/server/orgo.ts, the keys'
// scope in lib/server/keys.ts; .ops-kit/bops-workspaces/DECISIONS.md, the owner's rules): against an
// orgo-web as it is in production today (no `product` on projects) nothing is made, renamed or deleted, and
// every workspace's computers keep going to the one "bops" project; against an orgo-web with per workspace
// projects, the move on sign-in ties the default workspace to the "bops" project and makes an EMPTY marked
// project for every other workspace at once (the free computer's too; a name the user's Orgo already has gets
// " (Bops)"), and moves nothing; the default's project takes the user's name for it only once every Bops app on
// the account is new (both ways of the gate), and meanwhile that name is held: it stays the default's here (put
// back over a "bops" another Mac's copy or an older Bops brings back, never dropped for it), survives a restart,
// is tried again at each start, sign-in and names sync, and gives way only to a rename on orgo.ai made after it;
// a default renamed while Orgo doesn't answer is held too; run again it changes nothing; stopped after any call it resumes to
// the same end; a rollback deletes only the empty projects it made, and a refused delete leaves it whole. New
// workspace, Rename (orgo.ai's renames come here too) and Delete (a preview of what goes, then orgo-web's POST
// .../delete; a refusal keeps the workspace whole; the default can't be) follow it; keys are this workspace's or
// all workspaces'. orgo-web is a fake (a local server) with the real routes, the Keychain is never there, and the
// state lives in a throwaway folder: nothing reaches a real service.
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

// sessions.ts is the real one: Delete deletes computers through its resetComputer, against the fake.
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
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
 * `product` and `bops_ws_id`, and the new routes answer. `failAt`: the nth call that changes something does
 * its work and then answers 500 (a crash after Orgo did it, before the app heard). `apps`: what
 * GET /api/bops/apps answers (null: no such route, as today). `refuseDelete`: project ids POST .../delete
 * refuses (409, before deleting anything, as orgo-web does). `noPreview`: delete-preview fails.
 * `previewCounts`: delete-preview counts skills and apps (orgo-web's first build, 563ed1cf6) instead of
 * naming them as orgo-web does now. `skillsOf`: per project, its public.skills rows ({ name, slug, type }).
 * `down`: the list of projects and the apps on record answer 503 (Orgo not answering what Rename asks).
 */
const orgo = { modern: false, columnOnly: false, projects: [], computers: new Map(), secrets: [], calls: [], changes: 0, failAt: 0, seq: 0, clock: 0, apps: null, refuseDelete: new Set(), noPreview: false, previewCounts: false, skillsOf: {}, down: false };
// `columnOnly`: the migration is applied (GET answers every column, so `product` shows) but the routes are still today's.
const stamp = () => new Date(Date.UTC(2026, 9, 15) + ++orgo.clock * 1000).toISOString();
const project = (p) => ({ id: p.id, name: p.name, role: "owner", created_at: p.created_at, updated_at: p.updated_at, member_count: 1, desktops: [...orgo.computers.values()].filter((c) => c.project === p.id).map((c) => ({ id: c.id, name: c.name })), ...(orgo.modern || orgo.columnOnly ? { product: p.product, bops_ws_id: p.bops_ws_id ?? null } : {}) });
function world({ modern, columnOnly = false }) {
  orgo.modern = modern;
  orgo.columnOnly = columnOnly;
  orgo.calls = [];
  orgo.changes = 0;
  orgo.failAt = 0;
  orgo.apps = null;
  orgo.refuseDelete = new Set();
  orgo.noPreview = false;
  orgo.previewCounts = false;
  orgo.skillsOf = {};
  orgo.down = false;
  orgo.projects = [
    { id: "p_bops", name: "bops", product: "bops", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    // An older Bops one by name (another case): the free computer decides which is the default's.
    { id: "p_bops_old", name: "Bops", product: "bops", created_at: "2025-06-01T00:00:00Z", updated_at: "2025-06-01T00:00:00Z" },
    // The user's own Orgo workspace named "orgo".
    { id: "p_orgo", name: "orgo", product: "orgo", created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z" },
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
const TAKEN = { error: "A project with this name already exists", code: "WORKSPACE_NAME_TAKEN" };
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
  if (orgo.down && /^\/api\/(workspaces|projects|bops\/apps)$/.test(url.pathname)) return send(res, 503, { error: "Service unavailable" });
  // A change, done; the one asked to fail answers 500 after doing it.
  const changed = (status, obj) => {
    orgo.changes++;
    if (orgo.failAt && orgo.changes === orgo.failAt) return send(res, 500, { error: "boom" });
    return send(res, status, obj);
  };
  // /api/workspaces is orgo-web's alias of /api/projects (next.config rewrites).
  const p = url.pathname.replace(/^\/api\/projects(?=\/|$)/, "/api/workspaces");
  if (p === "/api/workspaces" && req.method === "GET") return send(res, 200, { workspaces: orgo.projects.map(project) });
  if (p === "/api/workspaces" && req.method === "POST") {
    const name = String(body?.name ?? "").trim();
    if (orgo.modern && body?.bops_ws_id) {
      const had = orgo.projects.find((x) => x.bops_ws_id === body.bops_ws_id);
      if (had) return changed(200, { id: had.id, name: had.name, product: had.product, bops_ws_id: had.bops_ws_id, updated_at: had.updated_at });
    }
    if (orgo.projects.some((x) => x.name.toLowerCase() === name.toLowerCase())) return send(res, 400, TAKEN);
    // "bops" is only the default's (bops_ws_id ws_main) or an old app's own {name: 'bops'} (no product).
    if (orgo.modern && name.toLowerCase() === "bops" && body?.product !== undefined && body?.bops_ws_id !== "ws_main") return send(res, 400, TAKEN);
    const id = `p_new${++orgo.seq}`;
    const at = stamp();
    const made = { id, name, created_at: at, updated_at: at, ...(orgo.modern ? { product: body?.product ?? (name.toLowerCase() === "bops" ? "bops" : "orgo"), bops_ws_id: body?.bops_ws_id ?? null } : { product: name.toLowerCase() === "bops" ? "bops" : "orgo" }) };
    orgo.projects.push(made);
    return changed(201, { id, name, updated_at: at, ...(orgo.modern ? { product: made.product, bops_ws_id: made.bops_ws_id } : {}) });
  }
  if (p === "/api/bops/apps" && req.method === "GET") return orgo.apps === null ? html404(res) : send(res, 200, { apps: orgo.apps });
  const one = p.match(/^\/api\/workspaces\/([^/]+)$/);
  if (one) {
    const x = orgo.projects.find((y) => y.id === one[1]);
    // orgo-web deletes a project with POST .../delete only: DELETE is 405 with no body, as Next answers it.
    if (req.method === "DELETE") {
      res.writeHead(405);
      return res.end();
    }
    if (!x) return send(res, 404, { error: "Not found" });
    if (req.method === "GET") return send(res, 200, { id: x.id, name: x.name, updated_at: x.updated_at, desktops: [...orgo.computers.values()].filter((c) => c.project === x.id).map((c) => ({ id: c.id, name: c.name })) });
    if (req.method === "PATCH") {
      // Today's route takes name, icon_url, status and private_screens only.
      if (!orgo.modern && body?.bops_ws_id !== undefined) return send(res, 400, { error: "Unsupported field" });
      if (orgo.modern && body?.bops_ws_id !== undefined && x.bops_ws_id && x.bops_ws_id !== body.bops_ws_id) return send(res, 409, { error: "This workspace or that Bops workspace is already bound", code: "BOPS_WS_ID_TAKEN" });
      if (body?.name !== undefined) {
        const to = String(body.name).trim().toLowerCase();
        if (orgo.projects.some((y) => y.id !== x.id && y.name.toLowerCase() === to)) return send(res, 400, TAKEN);
        if (orgo.modern && to === "bops" && x.name.toLowerCase() !== "bops" && (body.bops_ws_id ?? x.bops_ws_id) !== "ws_main") return send(res, 400, TAKEN);
        x.name = body.name;
        x.updated_at = stamp();
      }
      if (orgo.modern && body?.bops_ws_id !== undefined && !x.bops_ws_id) x.bops_ws_id = body.bops_ws_id;
      return changed(200, { id: x.id, name: x.name, updated_at: x.updated_at, ...(orgo.modern && body?.bops_ws_id !== undefined ? { product: "bops", bops_ws_id: body.bops_ws_id } : {}) });
    }
  }
  const del = p.match(/^\/api\/workspaces\/([^/]+)\/delete$/);
  if (del && req.method === "POST") {
    const x = orgo.projects.find((y) => y.id === del[1]);
    if (!x) return send(res, 404, { error: "Project not found" });
    if (orgo.refuseDelete.has(x.id)) return send(res, 409, { error: "A computer's memory is moving to storage. Try again in a minute.", code: "workspace_transfer_in_progress" });
    orgo.projects = orgo.projects.filter((y) => y.id !== x.id);
    for (const c of [...orgo.computers.values()]) if (c.project === x.id) orgo.computers.delete(c.id);
    orgo.secrets = orgo.secrets.filter((s) => s.workspace_id !== x.id);
    return changed(200, { success: true, message: "Project deleted successfully" });
  }
  const preview = p.match(/^\/api\/workspaces\/([^/]+)\/delete-preview$/);
  if (preview && req.method === "GET") {
    if (orgo.noPreview) return send(res, 500, { error: "boom" });
    const x = orgo.projects.find((y) => y.id === preview[1]);
    if (!x) return send(res, 404, { error: "Project not found" });
    // orgo-web's answer (app/api/projects/[id]/delete-preview/route.ts), field for field.
    const rows = orgo.skillsOf[x.id] ?? [];
    const skills = rows.filter((r) => r.type !== "app").map(({ name, slug }) => ({ name, slug }));
    const apps = rows.filter((r) => r.type === "app").map(({ name, slug }) => ({ name, slug }));
    return send(res, 200, {
      id: x.id,
      name: x.name,
      product: x.product ?? "orgo",
      bops_ws_id: x.bops_ws_id ?? null,
      deletable: x.bops_ws_id !== "ws_main",
      computers: [...orgo.computers.values()].filter((c) => c.project === x.id).map((c) => ({ id: c.id, name: c.name })),
      keys: orgo.secrets.filter((s) => s.workspace_id === x.id).map((s) => s.name),
      skills: orgo.previewCounts ? skills.length : skills,
      apps: orgo.previewCounts ? apps.length : apps,
    });
  }
  // The first build's routes: gone. Nothing may call them.
  if (/\/members\/copy$|\/move$/.test(p)) return html404(res);
  const comp = p.match(/^\/api\/computers\/([^/]+)$/);
  if (comp && req.method === "GET") {
    const c = orgo.computers.get(comp[1]);
    return c ? send(res, 200, { id: c.id, name: c.name, project_id: c.project, workspace_id: c.project }) : send(res, 404, { error: "Computer not found" });
  }
  if (comp && req.method === "DELETE") {
    if (!orgo.computers.has(comp[1])) return send(res, 404, { error: "Computer not found" });
    orgo.computers.delete(comp[1]);
    return changed(200, { success: true });
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
  const sdel = p.match(/^\/api\/secrets\/([A-Z0-9_]+)$/);
  if (sdel && req.method === "DELETE") {
    const ws = url.searchParams.get("workspace_id");
    orgo.secrets = orgo.secrets.filter((x) => !(x.name === sdel[1] && x.workspace_id === ws));
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
const Merge = await import(`${root}/lib/server/state-merge.ts`);
const KeysRoute = await import(`${root}/app/api/keys/route.ts`);

/**
 * A clean state: four workspaces besides the default, each team with its computers as the dry run has them:
 * one whose main bot has its own computer (named like the user's Orgo "orgo"), one with no computer, one
 * with a computer, and one whose main bot shares the free computer.
 */
function seed({ mainName = "Main" } = {}) {
  const g = globalThis;
  g.bopsOrgoWorkspace = undefined;
  g.bopsOrgoPerWorkspace = undefined;
  g.bopsOrgoPlan = undefined;
  g.bopsKeys = undefined;
  g.bopsWsRenamedAt?.clear();
  S.update((s) => {
    s.owner = { name: "Tiger" };
    s.workspaces = [
      { id: "ws_main", name: mainName, createdAt: 0 },
      { id: "ws_orgo", name: "orgo", createdAt: 10 },
      { id: "ws_quiet", name: "Quiet", createdAt: 20 },
      { id: "ws_busy", name: "Acme", createdAt: 30 },
      { id: "ws_free", name: "Free time", createdAt: 40 },
    ];
    s.workspace = "ws_main";
    s.bots = [
      // The free Bops computer: it never moves.
      { id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "ready", computerId: "c_free", freeComputer: true },
      { id: "max", name: "Max", role: "Sales", color: "#5B8CFF", isMain: false, computerStatus: "ready", computerId: "c_max", computer: "own" },
      { id: "oscar", name: "Oscar", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "ready", computerId: "c_orgo", workspaceId: "ws_orgo" },
      { id: "quinn", name: "Quinn", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", workspaceId: "ws_quiet" },
      { id: "bea", name: "Bea", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "ready", computerId: "c_busy", workspaceId: "ws_busy" },
      // Its only computer is the free one (the dry run's 6a8fe9ff): it gets its project too.
      { id: "fay", name: "Fay", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "ready", computerId: "c_free", freeComputer: true, workspaceId: "ws_free" },
    ];
    s.chats = [{ id: "bot:bea", kind: "bot", botIds: ["bea"], createdAt: 1, typing: [], workspaceId: "ws_busy" }, { id: "bot:quinn", kind: "bot", botIds: ["quinn"], createdAt: 1, typing: [], workspaceId: "ws_quiet" }];
    delete s.orgoMigration;
    delete s.orgoMigrationRevertedAt;
  });
}
const ws = (id) => S.getState().workspaces.find((w) => w.id === id);
const changes = () => orgo.calls.filter((c) => c.method !== "GET");
const where = (id) => orgo.computers.get(id)?.project;
const named = (name) => orgo.projects.find((p) => p.name === name);
const byId = (id) => orgo.projects.find((p) => p.id === id);
const post = (body) => new Request("http://localhost:3210/api/workspaces", { method: "POST", headers: { "content-type": "application/json", "x-bops-window": UI }, body: JSON.stringify(body) });
const req = (method, body) => new Request("http://localhost:3210/api/workspaces", { method, headers: { "content-type": "application/json", "x-bops-window": UI }, body: JSON.stringify(body) });
const preview = (id) => Route.GET(new Request(`http://localhost:3210/api/workspaces?preview=${id}`, { headers: { "x-bops-window": UI } }));
const ALL_COMPUTERS = [
  ["c_free", "p_bops"],
  ["c_max", "p_bops"],
  ["c_orgo", "p_bops"],
  ["c_busy", "p_bops"],
  ["c_mine", "p_orgo"],
];
const NEW = (v) => ({ app_version: v, caller: "app", seen_at: "2026-10-15T00:00:00Z" });

/* ---------------- Today's orgo-web: exactly as before ---------------- */

await check("Today's orgo-web (no per workspace projects): the move does nothing and sends nothing", async () => {
  world({ modern: false });
  seed();
  const before = JSON.stringify(S.getState().workspaces);
  const r = await Wk.migrateWorkspacesToOrgo();
  assert.deepEqual(r, { status: "legacy" });
  assert.deepEqual(changes(), [], "nothing made, renamed or deleted");
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
  assert.equal(ws(created.id), undefined);
  assert.deepEqual(changes().slice(n).map((c) => `${c.method} ${c.path}`), [], "nothing on Orgo for any of it");
  // The names from orgo.ai: nothing to take here.
  assert.deepEqual(await (await Route.PATCH(req("PATCH", { syncNames: true }))).json(), { ok: true, renamed: [] });
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
await check("The move: default tied to bops; every other workspace gets an EMPTY project now (the free computer's one too, a taken name gets (Bops)); nothing moves", async () => {
  world({ modern: true });
  seed();
  // A skill made before the move, in its workspace's folder by its Bops id.
  Sk.createSkill("ws_orgo", { name: "Orgo report", description: "When asked", body: "# Orgo report\n" });
  assert.ok(existsSync(join(process.cwd(), ".data", "workspaces", "ws_orgo", "skills", "orgo-report", "SKILL.md")));
  const r = await Wk.migrateWorkspacesToOrgo();
  assert.equal(r.status, "done", JSON.stringify(r));
  // 1. The default: the bops project holding the free computer (not the older "Bops"), tied to it.
  assert.equal(ws("ws_main").orgoProjectId, "p_bops");
  assert.equal(byId("p_bops").bops_ws_id, "ws_main");
  assert.equal(byId("p_bops_old").bops_ws_id ?? null, null, "the other Bops one stays unbound");
  // 2. Every other workspace: its own project, marked and tied, made now, empty.
  const o = named("orgo (Bops)");
  assert.ok(o, orgo.projects.map((p) => p.name).join(", "));
  const expect = { ws_orgo: "orgo (Bops)", ws_quiet: "Quiet", ws_busy: "Acme", ws_free: "Free time" };
  for (const [id, name] of Object.entries(expect)) {
    const p = named(name);
    assert.ok(p, `${id}'s project ${name}`);
    assert.deepEqual([p.product, p.bops_ws_id, ws(id).orgoProjectId, ws(id).orgoName], ["bops", id, p.id, name]);
    assert.equal([...orgo.computers.values()].filter((c) => c.project === p.id).length, 0, `${name} is empty`);
  }
  assert.equal(r.created, 4);
  assert.deepEqual(r.renamed, [{ wsId: "ws_orgo", from: "orgo", to: "orgo (Bops)" }]);
  assert.equal(ws("ws_orgo").name, "orgo", "its name here stays");
  assert.deepEqual(Wk.migrationNotice(), { renamed: [{ wsId: "ws_orgo", from: "orgo", to: "orgo (Bops)" }], defaultWaits: null });
  // 3. Nothing moves: every computer is where it was, and the first build's routes are never called.
  assert.deepEqual([...orgo.computers.values()].map((c) => [c.id, c.project]), ALL_COMPUTERS);
  assert.ok(!orgo.calls.some((c) => /\/move$|\/members\/copy$/.test(c.path)), "no move and no people copy");
  assert.deepEqual(changes().filter((c) => !c.path.includes("/skills")).map((c) => `${c.method} ${c.path}`).sort(), ["PATCH /api/workspaces/p_bops", ...Array(4).fill("POST /api/workspaces")].sort(), "the tie and the four creates, nothing else");
  // 4. "Main" left as it was is "bops" now; its project kept the name.
  assert.equal(ws("ws_main").name, "bops");
  assert.equal(byId("p_bops").name, "bops");
  assert.deepEqual(r.defaultName, { local: "bops", project: "bops", renamed: false, reason: "same" });
  // 5. The skills folder went to the project's id.
  assert.ok(!existsSync(join(process.cwd(), ".data", "workspaces", "ws_orgo")));
  assert.ok(existsSync(join(process.cwd(), ".data", "workspaces", o.id, "skills", "orgo-report", "SKILL.md")));
  assert.equal(Sk.skillDetail("ws_orgo", "skill", "orgo-report").missing, false, "still found where it's looked for");
  // Only Bops' own projects were changed: the user's "orgo" wasn't renamed or tied.
  assert.deepEqual(byId("p_orgo"), { id: "p_orgo", name: "orgo", product: "orgo", created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z" });
  const mine = await O.orgo.bopsComputers();
  assert.deepEqual(mine.map((c) => c.id).sort(), ["c_busy", "c_free", "c_max", "c_orgo"], "this app merges every Bops project's, the user's own Orgo one's not");
  // Each workspace's people are its own project's (empty for a new one, never the default's).
  assert.equal((await O.findBopsWorkspace(ORGO_KEY, { fresh: true, wsId: "ws_quiet" })).id, ws("ws_quiet").orgoProjectId);
  assert.equal((await O.findBopsWorkspace(ORGO_KEY, { fresh: true, wsId: "ws_main" })).id, "p_bops");
  clean = { names: S.getState().workspaces.map((w) => [w.id, w.name, byId(w.orgoProjectId)?.name ?? null]), where: [...orgo.computers.values()].map((c) => [c.id, byId(c.project)?.name]) };
});

await check("Run again: nothing is changed on Orgo at all (only the list is read, for orgo.ai's renames)", async () => {
  const n = changes().length;
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  assert.equal(changes().length, n, "no further changes once it's done");
  assert.ok(orgo.calls.slice(-1).every((c) => c.method === "GET" && c.path === "/api/workspaces"));
});

await check("New workspace: its Orgo workspace is made too, marked and tied; a name the user's Orgo has is asked about", async () => {
  // The user's own Orgo workspace "Clients": a Bops one by that name is asked about, and nothing is made.
  orgo.projects.push({ id: "p_clients", name: "Clients", product: "orgo", created_at: "2026-03-01T00:00:00Z", updated_at: "2026-03-01T00:00:00Z" });
  const before = S.getState().workspaces.length;
  const n = orgo.projects.length;
  const taken = await Route.POST(post({ name: "Clients" }));
  assert.equal(taken.status, 409);
  assert.deepEqual(await taken.json(), { error: "You already have an Orgo workspace named Clients. Try Clients (Bops) or another name.", code: "name_taken", suggestion: "Clients (Bops)" });
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
  assert.equal(named("Clients (Bops)"), undefined, "deleted with its workspace");
  const fine = await Route.POST(post({ name: "Ventures" }));
  assert.equal(fine.status, 200);
  const made = await fine.json();
  assert.equal(S.getState().workspaces.length, before + 1);
  assert.equal(S.getState().workspace, made.id, "the new one is the current one");
  const p = byId(made.orgoProjectId);
  assert.deepEqual([p.name, p.product, p.bops_ws_id, ws(made.id).orgoName], ["Ventures", "bops", made.id, "Ventures"]);
  // Rename: Orgo first; one the user's Orgo has is refused, and nothing changes.
  const clash = await Route.PATCH(req("PATCH", { id: made.id, name: "orgo" }));
  assert.equal(clash.status, 409);
  assert.equal((await clash.json()).code, "name_taken");
  assert.equal(ws(made.id).name, "Ventures");
  assert.deepEqual(await (await Route.PATCH(req("PATCH", { id: made.id, name: "Ventures Two" }))).json(), { ok: true });
  assert.equal(p.name, "Ventures Two");
  assert.deepEqual([ws(made.id).name, ws(made.id).orgoName], ["Ventures Two", "Ventures Two"]);
  // A computer for its bot goes into its own project.
  const c = await O.orgo.create("V", { wsId: made.id, ram: 8 });
  assert.equal(where(c.id), p.id);
  // The quiet workspace's project was made by the move: its first computer goes there.
  const q = await O.orgo.create("Quinn", { wsId: "ws_quiet", ram: 8 });
  assert.equal(where(q.id), ws("ws_quiet").orgoProjectId);
  orgo.computers.delete(q.id);
  // Delete: its Orgo workspace goes with what's in it, by orgo-web's POST .../delete.
  await Rm.deleteWorkspace(made.id);
  assert.equal(byId(p.id), undefined, "the project went");
  assert.equal(where(c.id), undefined, "and its computer with it");
  assert.ok(orgo.calls.some((x) => x.method === "POST" && x.path === `/api/projects/${p.id}/delete`));
  assert.ok(!orgo.calls.some((x) => x.method === "DELETE" && x.path.startsWith("/api/workspaces")), "never a DELETE, which orgo-web answers 405");
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

await check("The switcher's note about names Orgo had goes once dismissed", async () => {
  assert.equal(Wk.migrationNotice().renamed.length, 1);
  assert.equal((await Route.PATCH(req("PATCH", { noticeSeen: true }))).status, 200);
  assert.deepEqual(Wk.migrationNotice().renamed, []);
});

await check("Stopped after any call it makes, it resumes to the same end", async () => {
  let runs = 0;
  for (let at = 1; at <= 7; at++) {
    world({ modern: true });
    seed();
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
    const end = { names: S.getState().workspaces.map((w) => [w.id, w.name, byId(w.orgoProjectId)?.name ?? null]), where: [...orgo.computers.values()].map((c) => [c.id, byId(c.project)?.name]) };
    assert.deepEqual(end, clean, `stopped at change ${at}: ${JSON.stringify(end)}`);
    for (const id of ["ws_orgo", "ws_quiet", "ws_busy", "ws_free"]) assert.equal(orgo.projects.filter((p) => p.bops_ws_id === id).length, 1, "never two projects for one workspace");
    assert.deepEqual(S.getState().orgoMigration.renamed, [{ wsId: "ws_orgo", from: "orgo", to: "orgo (Bops)" }], `the notice, also after a stop at ${at}`);
  }
  assert.ok(runs >= 7);
});

await check("Roll back: only the empty projects it made go, the default's project is bops again", async () => {
  world({ modern: true });
  seed();
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  const acme = ws("ws_busy").orgoProjectId;
  const orgoBops = ws("ws_orgo").orgoProjectId;
  // Someone put a computer in Acme's project since: it isn't empty, so it stays.
  orgo.computers.set("c_later", { id: "c_later", name: "later", project: acme });
  // Renamed on orgo.ai since: it goes back to "bops", the name older apps find it by.
  byId("p_bops").name = "Renamed";
  byId("p_bops_old").name = "Bops old";
  const r = await Wk.revertWorkspaceMigration();
  assert.equal(byId("p_bops").name, "bops");
  assert.deepEqual(r, { deleted: 3, kept: 1 });
  assert.equal(byId(orgoBops), undefined, "orgo (Bops) was empty, and went");
  assert.ok(byId(acme), "Acme's has a computer, and stays");
  assert.ok(byId("p_bops") && byId("p_orgo"), "nothing else deleted");
  assert.deepEqual([...orgo.computers.values()].filter((c) => c.id !== "c_later").map((c) => [c.id, c.project]), ALL_COMPUTERS, "no computer moved, either way");
  assert.ok(S.getState().workspaces.every((w) => !w.orgoProjectId && !w.orgoName));
  assert.equal(S.getState().orgoMigration, undefined);
  assert.equal(ws("ws_main").name, "Main");
});

await check("After a roll back the move never runs again by itself, and every computer goes to the bops project", async () => {
  assert.ok(S.getState().orgoMigrationRevertedAt);
  const n = changes().length;
  assert.deepEqual(await Wk.migrateWorkspacesToOrgo(), { status: "legacy" });
  assert.equal(await O.perWorkspaceProjects({ fresh: true }), false);
  assert.equal(await O.orgoProjectFor("ws_orgo"), "p_bops");
  assert.deepEqual(changes().slice(n), [], "nothing on Orgo");
});

await check("A roll back Orgo refuses a delete in throws before anything changes here; again, it finishes", async () => {
  world({ modern: true });
  seed();
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  const quiet = ws("ws_quiet").orgoProjectId;
  orgo.refuseDelete.add(quiet);
  await assert.rejects(Wk.revertWorkspaceMigration(), /moving to storage/);
  assert.ok(byId(quiet), "Quiet's is still on Orgo");
  assert.equal(named("orgo (Bops)"), undefined, "the one before it went");
  assert.equal(S.getState().orgoMigrationRevertedAt, undefined, "not marked undone");
  assert.equal(S.getState().orgoMigration.created.length, 3, "the deleted one is off the list");
  assert.ok(S.getState().workspaces.filter((w) => w.id !== "ws_orgo").every((w) => w.orgoProjectId), "every workspace still tied");
  orgo.refuseDelete.clear();
  assert.deepEqual(await Wk.revertWorkspaceMigration(), { deleted: 3, kept: 0 });
  assert.ok(S.getState().orgoMigrationRevertedAt);
  assert.ok(S.getState().workspaces.every((w) => !w.orgoProjectId));
});

await check("The column without orgo-web's code for it: stays as before, nothing tied or made, a refused tie isn't kept", async () => {
  world({ modern: false, columnOnly: true });
  seed();
  assert.deepEqual(await Wk.migrateWorkspacesToOrgo(), { status: "legacy" });
  assert.equal(S.getState().orgoMigration, undefined);
  assert.ok(S.getState().workspaces.every((w) => !w.orgoProjectId), "nothing tied here");
  assert.deepEqual(changes().map((c) => `${c.method} ${c.path}`), ["PATCH /api/workspaces/p_bops"], "only the tie that finds out, which today's route refuses");
  assert.notEqual(await O.perWorkspaceProjects(), true);
  assert.equal(await O.orgoProjectFor("ws_orgo"), "p_bops", "another workspace's computer: the bops project");
  const made = await (await Route.POST(post({ name: "Plain" }))).json();
  assert.equal(made.orgoProjectId, undefined);
  assert.equal(named("Plain"), undefined, "no plain Orgo project made");
});

/* ---------------- The default's name: the gate ---------------- */

await check("Rename gate, closed: a default the user renamed keeps its project named bops while any app is old, silent or unknown", async () => {
  world({ modern: true });
  seed({ mainName: "Acme Main" });
  // orgo-web without the route (today's): no signal, so it keeps "bops".
  const r = await Wk.migrateWorkspacesToOrgo();
  assert.equal(r.status, "done");
  assert.deepEqual(r.defaultName, { local: "Acme Main", project: "bops", renamed: false, reason: "no_signal" });
  assert.equal(byId("p_bops").name, "bops");
  assert.equal(ws("ws_main").name, "Acme Main", "Bops shows the user's name");
  assert.equal(S.getState().orgoMigration.defaultRename.reason, "no_signal");
  assert.ok(!changes().some((c) => c.path === "/api/workspaces/p_bops" && c.body?.name !== undefined), "no rename sent");
  // Each sign-in asks again; each closed answer keeps "bops", and says why.
  for (const [apps, reason] of [
    [[NEW("0.0.29"), NEW("0.0.27")], "old_app"],
    [[NEW("0.0.30"), { app_version: null, caller: "unknown" }], "silent_app"],
    [[], "no_record"],
    [[{ app_version: "0.0.30", caller: "cloud" }], "no_record"],
  ]) {
    orgo.apps = apps;
    const again = await Wk.migrateWorkspacesToOrgo();
    assert.equal(again.defaultName.reason, reason, JSON.stringify(apps));
    assert.equal(byId("p_bops").name, "bops");
    assert.equal(S.getState().orgoMigration.defaultRename.reason, reason);
  }
  // A rename of the default here meanwhile: the name changes here only, and the result says why.
  orgo.apps = [NEW("0.0.28")];
  assert.deepEqual(await (await Route.PATCH(req("PATCH", { id: "ws_main", name: "Studio" }))).json(), { ok: true, waiting: "old_app" });
  assert.equal(ws("ws_main").name, "Studio");
  assert.equal(byId("p_bops").name, "bops");
  assert.equal(S.getState().orgoMigration.defaultRename.to, "Studio");
  // The names from orgo.ai don't take it back to "bops": the project's name didn't change there.
  await Wk.syncWorkspaceNames();
  assert.equal(ws("ws_main").name, "Studio");
});

await check("Rename gate, open: once every app on the account is new, the default's project takes the user's name", async () => {
  // Bops Cloud's own calls (an old version) don't count; every app on a Mac is new.
  orgo.apps = [NEW("0.0.29"), NEW("0.2.1"), { app_version: "0.0.12", caller: "cloud" }];
  const r = await Wk.migrateWorkspacesToOrgo();
  assert.deepEqual(r.defaultName, { local: "Studio", project: "Studio", renamed: true, reason: "all_new" });
  assert.equal(byId("p_bops").name, "Studio");
  assert.equal(byId("p_bops").bops_ws_id, "ws_main", "found by the marker from now on, not the name");
  assert.equal(S.getState().orgoMigration.defaultRename, undefined);
  assert.equal(ws("ws_main").orgoName, "Studio");
  // From then on a rename of the default goes straight to its project (no older app looks for "bops" any more).
  orgo.apps = null;
  assert.deepEqual(await (await Route.PATCH(req("PATCH", { id: "ws_main", name: "HQ" }))).json(), { ok: true });
  assert.equal(byId("p_bops").name, "HQ");
  // Nothing more to do at a sign-in.
  const n = changes().length;
  await Wk.migrateWorkspacesToOrgo();
  assert.equal(changes().length, n);
});

await check("Rename gate, open, with a name the user's Orgo already has: the default's project is <name> (Bops), and the switcher says so", async () => {
  world({ modern: true });
  seed({ mainName: "orgo" });
  orgo.apps = [NEW("0.0.29")];
  const r = await Wk.migrateWorkspacesToOrgo();
  assert.equal(byId("p_bops").name, "orgo (Bops 2)", "orgo (Bops) is the orgo workspace's");
  assert.deepEqual(r.defaultName, { local: "orgo", project: "orgo (Bops 2)", renamed: true, reason: "all_new" });
  assert.ok(Wk.migrationNotice().renamed.some((x) => x.wsId === "ws_main" && x.to === "orgo (Bops 2)"));
});

/* ---------------- Renames on orgo.ai ---------------- */

await check("A rename on orgo.ai reaches Bops: at sign-in and when the sidebar asks; never a stale list, never on first sight", async () => {
  world({ modern: true });
  seed();
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  // Renamed on orgo.ai.
  const acme = byId(ws("ws_busy").orgoProjectId);
  acme.name = "Acme Corp";
  acme.updated_at = stamp();
  const j = await (await Route.PATCH(req("PATCH", { syncNames: true }))).json();
  assert.deepEqual(j, { ok: true, renamed: [{ wsId: "ws_busy", from: "Acme", to: "Acme Corp" }] });
  assert.deepEqual([ws("ws_busy").name, ws("ws_busy").orgoName], ["Acme Corp", "Acme Corp"]);
  // The default's project renamed there: shown here, and a name waiting for the apps is dropped for it.
  S.update((s) => (s.orgoMigration.defaultRename = { to: "Old wish", reason: "old_app", checkedAt: "2026-10-15T00:00:00Z" }));
  byId("p_bops").name = "Headquarters";
  byId("p_bops").updated_at = stamp();
  // At the next sign-in (the move is done: it only reads the list).
  orgo.apps = [NEW("0.0.20")];
  await Wk.migrateWorkspacesToOrgo();
  assert.equal(ws("ws_main").name, "Headquarters");
  assert.equal(S.getState().orgoMigration.defaultRename, undefined);
  assert.equal(byId("p_bops").name, "Headquarters", "never renamed back");
  // A rename here then shows as no change on orgo.ai.
  assert.equal((await Route.PATCH(req("PATCH", { id: "ws_busy", name: "Acme Two" }))).status, 200);
  assert.deepEqual((await Wk.syncWorkspaceNames()).renamed, []);
  assert.equal(ws("ws_busy").name, "Acme Two");
  // A list older than what was seen (updated_at before it) doesn't take a workspace back.
  const stale = byId(ws("ws_busy").orgoProjectId);
  stale.name = "Acme";
  stale.updated_at = "2026-01-01T00:00:00Z";
  assert.deepEqual((await Wk.syncWorkspaceNames()).renamed, []);
  assert.equal(ws("ws_busy").name, "Acme Two");
  // Tied before names were kept (the first build): learnt on first sight, never taken for a rename.
  S.update((s) => delete s.workspaces.find((w) => w.id === "ws_orgo").orgoName);
  assert.deepEqual((await Wk.syncWorkspaceNames()).renamed, []);
  assert.deepEqual([ws("ws_orgo").name, ws("ws_orgo").orgoName], ["orgo", "orgo (Bops)"]);
  // A name another workspace here has gets a number here (Orgo keeps its own).
  const q = byId(ws("ws_quiet").orgoProjectId);
  q.name = "orgo";
  q.updated_at = stamp();
  assert.deepEqual((await Wk.syncWorkspaceNames()).renamed, [{ wsId: "ws_quiet", from: "Quiet", to: "orgo 2" }]);
  assert.ok(!changes().some((c) => c.path === `/api/workspaces/${q.id}` && c.method === "PATCH"), "nothing sent back to Orgo for it");
});

/* ---------------- The default's name, held for the apps ---------------- */

const OLD = () => [NEW("0.0.28")];
const appsAsked = () => orgo.calls.filter((c) => c.path === "/api/bops/apps").length;
const held = () => S.getState().orgoMigration?.defaultRename;
const sync = async () => (await Route.PATCH(req("PATCH", { syncNames: true }))).json();
/** The owner's account as prod had it on 10-20: the default tied to its "bops" project, the move done, the one app on record 0.0.28. */
async function heldWorld() {
  world({ modern: true });
  orgo.projects = orgo.projects.filter((p) => p.id !== "p_bops_old");
  seed();
  orgo.apps = OLD();
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  assert.deepEqual([ws("ws_main").name, ws("ws_main").orgoName, held()], ["bops", "bops", undefined]);
  Wk.heldRenameForTests?.reset();
}
/** The owner's rename in the switcher. */
const renameMain = async (name) => (await Route.PATCH(req("PATCH", { id: "ws_main", name }))).json();

await check("Held default name: renamed to bops- with an app on 0.0.28 it stays bops- here and bops on Orgo, each names sync asks again, and once every app is 0.0.29 the project takes it", async () => {
  await heldWorld();
  assert.deepEqual(await renameMain("bops-"), { ok: true, waiting: "old_app" });
  assert.equal(ws("ws_main").name, "bops-");
  assert.equal(byId("p_bops").name, "bops", "the project keeps bops for the old app");
  assert.equal(held().to, "bops-");
  assert.ok(Number.isFinite(Date.parse(held().at)), "when the owner gave it");
  assert.ok(!changes().some((c) => c.path === "/api/workspaces/p_bops" && c.body?.name !== undefined), "no rename sent");
  // The sidebar's names sync (every 10 minutes): the name stays, and the gate is asked again.
  const asked = appsAsked();
  assert.deepEqual(await sync(), { ok: true, renamed: [] });
  assert.equal(appsAsked(), asked + 1, "the names sync tried the held name again");
  assert.deepEqual([ws("ws_main").name, byId("p_bops").name, held().reason], ["bops-", "bops", "old_app"]);
  assert.deepEqual(Wk.migrationNotice().defaultWaits?.to, "bops-", "Settings and the switcher see it waiting");
  // This Mac's app is 0.0.29 now: the next names sync gives the project the name.
  orgo.apps = [NEW("0.0.29")];
  assert.deepEqual(await sync(), { ok: true, renamed: [] });
  assert.equal(byId("p_bops").name, "bops-");
  assert.deepEqual([ws("ws_main").name, ws("ws_main").orgoName, held()], ["bops-", "bops-", undefined]);
  // And nothing more goes at the next sync or sign-in.
  const n = changes().length;
  await sync();
  await Wk.migrateWorkspacesToOrgo();
  assert.equal(changes().length, n);
});

await check("Held default name, never reverted: a project changed on Orgo without a rename, another Mac's names sync merged in, and bops brought back by an older Bops's copy all leave it bops- (the 10-20 revert)", async () => {
  await heldWorld();
  const before = structuredClone({ workspaces: S.getState().workspaces, orgoMigration: S.getState().orgoMigration });
  assert.deepEqual(await renameMain("bops-"), { ok: true, waiting: "old_app" });
  // Orgo changed the project without renaming it (prod's row moved to 00:20:48 with its name still bops).
  byId("p_bops").updated_at = stamp();
  await sync();
  assert.deepEqual([ws("ws_main").name, ws("ws_main").orgoUpdatedAt, held()?.to], ["bops-", byId("p_bops").updated_at, "bops-"]);
  // Another Bops with this state (another Mac, or this Mac's app under its other device id) saw the same
  // change in its names sync before it heard of the rename: its copy of the default has the new
  // orgoUpdatedAt and the old name. Its save merges this Mac's over the last synced (state-merge.ts):
  // the default changed on both sides goes field by field, so its orgoUpdatedAt and the rename both stay.
  // (Merged whole, as before, its copy brought bops back.)
  const mine = structuredClone({ workspaces: S.getState().workspaces, orgoMigration: S.getState().orgoMigration });
  const theirs = structuredClone(before);
  theirs.workspaces.find((w) => w.id === "ws_main").orgoUpdatedAt = "2026-10-21T00:20:48.660Z";
  for (const merged of [Merge.merge3(before, theirs, mine), Merge.merge3(before, mine, theirs)]) {
    const main = merged.workspaces.find((w) => w.id === "ws_main");
    assert.deepEqual([main.name, main.orgoName, merged.orgoMigration.defaultRename?.to], ["bops-", "bops", "bops-"], "the rename stays, whichever Mac merges");
  }
  // A field both changed is the merging Mac's, the rest come from where they changed.
  const here = structuredClone(before);
  here.workspaces.find((w) => w.id === "ws_main").name = "bops-";
  const other = structuredClone(before);
  other.workspaces.find((w) => w.id === "ws_main").name = "Elsewhere";
  other.workspaces.find((w) => w.id === "ws_main").orgoUpdatedAt = "2026-10-21T00:20:48.660Z";
  const both = Merge.merge3(before, here, other).workspaces.find((w) => w.id === "ws_main");
  assert.deepEqual([both.name, both.orgoUpdatedAt], ["bops-", "2026-10-21T00:20:48.660Z"]);
  // An older Bops's copy merged whole (0.0.28 and before) brings bops back over the rename here:
  // before the fix the next sign-in took that bops for "the user didn't name it" and dropped the wish
  // (renameDefault settled), leaving bops with nothing waiting, as the owner's app was. Now the names
  // sync puts the held name back, and so does a sign-in.
  S.update((s) => (s.workspaces.find((w) => w.id === "ws_main").name = "bops"));
  assert.deepEqual(await sync(), { ok: true, renamed: [] });
  assert.deepEqual([ws("ws_main").name, held()?.to], ["bops-", "bops-"]);
  S.update((s) => (s.workspaces.find((w) => w.id === "ws_main").name = "bops"));
  const r = await Wk.migrateWorkspacesToOrgo();
  assert.deepEqual(r.defaultName, { local: "bops-", project: "bops", renamed: false, reason: "old_app" });
  assert.deepEqual([ws("ws_main").name, held()?.to, byId("p_bops").name], ["bops-", "bops-", "bops"]);
  // Renamed back to bops by the owner: that's the name, sent as it is, and nothing waits.
  assert.deepEqual(await renameMain("bops"), { ok: true });
  assert.deepEqual([ws("ws_main").name, held(), byId("p_bops").name], ["bops", undefined, "bops"]);
});

await check("Held default name survives a restart: saved with the state, put back from it, tried at the start, given to the project at a start once the apps are new", async () => {
  await heldWorld();
  assert.deepEqual(await renameMain("bops-"), { ok: true, waiting: "old_app" });
  const at = held().at;
  // Quit and start again: the state is saved, read back from its file, and what lived in memory is gone.
  assert.equal(await S.flushState(5000), true);
  const epoch = S.stateEpoch();
  await S.bindSignIn("u_restart");
  await S.releaseSignOut();
  assert.notEqual(S.stateEpoch(), epoch, "read back from the file");
  globalThis.bopsWsRenamedAt.clear();
  globalThis.bopsOrgoPerWorkspace = undefined;
  globalThis.bopsOrgoWorkspace = undefined;
  Wk.heldRenameForTests.reset();
  assert.deepEqual([ws("ws_main").name, held()?.to, held()?.at], ["bops-", "bops-", at]);
  // The start: the window's first state poll tries it once; the app is still 0.0.28.
  const asked = appsAsked();
  Wk.retryHeldRenameOnStart();
  await globalThis.bopsWsHeldRetry;
  assert.equal(appsAsked(), asked + 1);
  Wk.retryHeldRenameOnStart();
  assert.equal(globalThis.bopsWsHeldRetry, undefined, "once a start");
  assert.deepEqual([ws("ws_main").name, byId("p_bops").name, held()?.at], ["bops-", "bops", at], "kept with when it was given");
  // The names sync after a restart (renamedAt forgotten) doesn't take bops back either.
  await sync();
  assert.equal(ws("ws_main").name, "bops-");
  // Updated meanwhile, and started again: the start gives the project the name.
  orgo.apps = [NEW("0.0.29")];
  Wk.heldRenameForTests.reset();
  Wk.retryHeldRenameOnStart();
  await globalThis.bopsWsHeldRetry;
  assert.deepEqual([ws("ws_main").name, byId("p_bops").name, held()], ["bops-", "bops-", undefined]);
});

await check("Held default name and orgo.ai: a rename there after the owner's wins (here too, nothing waits); one from before it gives way to the owner's, which goes with no gate", async () => {
  await heldWorld();
  assert.deepEqual(await renameMain("bops-"), { ok: true, waiting: "old_app" });
  const newer = byId("p_bops");
  newer.name = "Headquarters";
  newer.updated_at = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(await sync(), { ok: true, renamed: [{ wsId: "ws_main", from: "bops-", to: "Headquarters" }] });
  assert.deepEqual([ws("ws_main").name, ws("ws_main").orgoName, held(), byId("p_bops").name], ["Headquarters", "Headquarters", undefined, "Headquarters"]);
  // The same at a sign-in (the move's retry sees it first).
  await heldWorld();
  assert.deepEqual(await renameMain("bops-"), { ok: true, waiting: "old_app" });
  byId("p_bops").name = "Head office";
  byId("p_bops").updated_at = new Date(Date.now() + 60_000).toISOString();
  await Wk.migrateWorkspacesToOrgo();
  assert.deepEqual([ws("ws_main").name, held(), byId("p_bops").name], ["Head office", undefined, "Head office"]);
  // Renamed on orgo.ai before the owner's rename here (its updated_at is older than the wish): the owner's
  // stands, and as no app finds the project by bops any more, it goes now, with the app still 0.0.28.
  await heldWorld();
  assert.deepEqual(await renameMain("bops-"), { ok: true, waiting: "old_app" });
  const older = byId("p_bops");
  older.name = "HQ";
  older.updated_at = stamp();
  assert.ok(Date.parse(older.updated_at) < Date.parse(held().at));
  assert.deepEqual(await sync(), { ok: true, renamed: [] });
  assert.deepEqual([ws("ws_main").name, held(), byId("p_bops").name, ws("ws_main").orgoName], ["bops-", undefined, "bops-", "bops-"]);
});

await check("Held default name while Orgo doesn't answer: kept as unreachable, never renamed here alone and forgotten; asked for once Orgo answers", async () => {
  await heldWorld();
  orgo.down = true;
  globalThis.bopsOrgoPerWorkspace = undefined;
  assert.deepEqual(await renameMain("bops-"), { ok: true, waiting: "unreachable" });
  assert.deepEqual([ws("ws_main").name, held()?.reason], ["bops-", "unreachable"]);
  assert.deepEqual(await sync(), { ok: true, renamed: [] });
  assert.equal(held()?.reason, "unreachable", "still waiting");
  orgo.down = false;
  await sync();
  assert.deepEqual([ws("ws_main").name, held()?.reason, byId("p_bops").name], ["bops-", "old_app", "bops"]);
  orgo.apps = [NEW("0.0.30")];
  await sync();
  assert.deepEqual([held(), byId("p_bops").name], [undefined, "bops-"]);
});

/* ---------------- Delete ---------------- */

await check("Delete: a preview lists computers, keys, skills and apps (Bops' and Orgo's), then orgo-web's POST .../delete takes it all", async () => {
  world({ modern: true });
  seed();
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  const acme = ws("ws_busy").orgoProjectId;
  Sk.createSkill("ws_busy", { name: "Weekly report", description: "Each Monday", body: "# Weekly report\n" });
  Sk.createSkill("ws_busy", { kind: "app", name: "Deployer", description: "Ships it", body: "# Deployer\n" });
  // Made on orgo.ai in Acme's project, and a key for This workspace, and a skill only Orgo has.
  orgo.computers.set("c_extra", { id: "c_extra", name: "Made on orgo.ai", project: acme });
  orgo.secrets.push({ name: "STRIPE_SECRET_KEY", workspace_id: acme, value: "sk_test_fake_acme" });
  orgo.skillsOf[acme] = [{ slug: "invoices", name: "Invoices" }];
  const res = await preview("ws_busy");
  assert.equal(res.status, 200);
  const p = await res.json();
  assert.deepEqual(p.computers, [{ id: "c_busy", name: "Bea's computer" }, { id: "c_extra", name: "Made on orgo.ai" }], "Bea's (in the bops project, since nothing moved) and the one in its project");
  assert.deepEqual(p.keys, ["STRIPE_SECRET_KEY"]);
  assert.deepEqual(p.skills, ["Weekly report", "Invoices"]);
  assert.deepEqual(p.apps, ["Deployer"]);
  assert.deepEqual([p.name, p.orgo, p.bots], ["Acme", true, ["Bea"]]);
  assert.ok(!changes().some((c) => /delete/.test(c.path)), "a preview deletes nothing");
  const del = await Route.DELETE(req("DELETE", { id: "ws_busy" }));
  assert.equal(del.status, 200);
  assert.ok(orgo.calls.some((c) => c.method === "POST" && c.path === `/api/projects/${acme}/delete`));
  assert.equal(byId(acme), undefined);
  assert.equal(where("c_extra"), undefined, "its computers went with it");
  assert.equal(ws("ws_busy"), undefined);
  assert.equal(S.bot("bea"), undefined);
  assert.ok(!S.getState().chats.some((c) => c.workspaceId === "ws_busy"));
});

await check("Delete: the default workspace can't be; a refused delete leaves the workspace whole with Orgo's words; no preview, no delete", async () => {
  const n = changes().length;
  const main = await preview("ws_main");
  assert.equal(main.status, 400);
  assert.equal((await main.json()).error, "The default workspace can't be deleted.");
  const mainDel = await Route.DELETE(req("DELETE", { id: "ws_main" }));
  assert.equal(mainDel.status, 400);
  assert.ok(ws("ws_main") && byId("p_bops"));
  assert.deepEqual(changes().slice(n), [], "nothing sent for it");
  // Orgo refuses (a computer's memory is moving): the workspace stays, its bot and chat too.
  const quiet = ws("ws_quiet").orgoProjectId;
  orgo.refuseDelete.add(quiet);
  const refused = await Route.DELETE(req("DELETE", { id: "ws_quiet" }));
  assert.equal(refused.status, 502);
  assert.match((await refused.json()).error, /^Orgo didn't delete Quiet, so it's still here: A computer's memory is moving/);
  assert.ok(ws("ws_quiet") && byId(quiet));
  assert.equal(ws("ws_quiet").orgoProjectId, quiet);
  assert.ok(S.bot("quinn"), "its bot is still there");
  assert.ok(S.getState().chats.some((c) => c.id === "bot:quinn"), "and its chat");
  // Again, once Orgo can: it goes.
  orgo.refuseDelete.clear();
  assert.equal((await Route.DELETE(req("DELETE", { id: "ws_quiet" }))).status, 200);
  assert.equal(ws("ws_quiet"), undefined);
  assert.equal(byId(quiet), undefined);
  // Orgo can't say what's in one: no list, so no delete.
  orgo.noPreview = true;
  const blind = await preview("ws_free");
  assert.equal(blind.status, 502);
  assert.match((await blind.json()).error, /nothing was deleted/);
  assert.ok(ws("ws_free") && byId(ws("ws_free").orgoProjectId));
});

await check("Delete: an orgo-web that only counts skills and apps (its first build) still has them said, never Nothing else", async () => {
  world({ modern: true });
  seed();
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  const quiet = ws("ws_quiet").orgoProjectId;
  orgo.previewCounts = true;
  orgo.skillsOf[quiet] = [{ name: "A", slug: "a" }, { name: "B", slug: "b" }, { name: "Ship", slug: "ship", type: "app" }];
  const p = await (await preview("ws_quiet")).json();
  assert.deepEqual([p.skills, p.apps], [["2 skills on Orgo"], ["1 app on Orgo"]]);
  // Named here too: the count says only how many more Orgo has than are named.
  Sk.createSkill("ws_quiet", { name: "Weekly report", description: "Each Monday", body: "# Weekly report\n" });
  assert.deepEqual((await (await preview("ws_quiet")).json()).skills, ["Weekly report", "2 skills on Orgo"]);
  // orgo-web as it is now names them.
  orgo.previewCounts = false;
  const named2 = await (await preview("ws_quiet")).json();
  assert.deepEqual([named2.skills, named2.apps], [["Weekly report", "A", "B"], ["Ship"]]);
});

await check("Delete: orgo-web refusing the workspace leaves every computer of its team; Delete again deletes them after it", async () => {
  // Oscar's computer is in the default's bops project (nothing moved), outside orgo's project.
  const proj = ws("ws_orgo").orgoProjectId;
  orgo.refuseDelete.add(proj);
  const n = orgo.calls.length;
  const refused = await Route.DELETE(req("DELETE", { id: "ws_orgo" }));
  assert.equal(refused.status, 502);
  assert.ok(!orgo.calls.slice(n).some((c) => c.method === "DELETE" && c.path.startsWith("/api/computers/")), "no computer delete was sent");
  assert.equal(where("c_orgo"), "p_bops");
  assert.equal(S.bot("oscar").computerId, "c_orgo");
  assert.ok(ws("ws_orgo") && byId(proj));
  orgo.refuseDelete.clear();
  const m = orgo.calls.length;
  assert.equal((await Route.DELETE(req("DELETE", { id: "ws_orgo" }))).status, 200);
  const sent = orgo.calls.slice(m).filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(sent, [`POST /api/projects/${proj}/delete`, "DELETE /api/computers/c_orgo"], "the workspace first, then the computer outside it");
  assert.equal(where("c_orgo"), undefined);
  assert.equal(ws("ws_orgo"), undefined);
  assert.equal(where("c_free"), "p_bops", "the free computer is not Oscar's");
});

await check("Delete: the free Bops computer stays when another workspace's main bot has it or works on it, and passes to that one", async () => {
  // Boppy has it on record too (the dry run's 6a8fe9ff): Fay's workspace goes, the free computer stays.
  world({ modern: true });
  seed();
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  const p = await (await preview("ws_free")).json();
  assert.deepEqual(p.computers, [], "not Fay's to delete");
  assert.equal((await Route.DELETE(req("DELETE", { id: "ws_free" }))).status, 200);
  assert.equal(where("c_free"), "p_bops");
  assert.ok(!changes().some((c) => c.method === "DELETE" && c.path === "/api/computers/c_free"));
  assert.deepEqual([S.bot("boppy").computerId, S.bot("boppy").freeComputer], ["c_free", true]);
  assert.equal(S.bot("fay"), undefined);

  // Boppy works on it (shareFree) while Fay holds it: Boppy takes it up.
  world({ modern: true });
  seed();
  S.update(() => Object.assign(S.bot("boppy"), { computer: "shared", computerId: undefined, freeComputer: undefined, computerStatus: "none" }));
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  assert.deepEqual((await (await preview("ws_free")).json()).computers, []);
  assert.equal((await Route.DELETE(req("DELETE", { id: "ws_free" }))).status, 200);
  assert.equal(where("c_free"), "p_bops", "still on Orgo");
  assert.ok(!changes().some((c) => c.method === "DELETE" && c.path === "/api/computers/c_free"));
  const b = S.bot("boppy");
  assert.deepEqual([b.computerId, b.freeComputer, b.computer, b.computerStatus], ["c_free", true, undefined, "ready"]);
});

await check("Delete: the free Bops computer nobody else uses goes, and the confirm says so by name", async () => {
  world({ modern: true });
  seed();
  orgo.computers.set("c_boppy", { id: "c_boppy", name: "c_boppy", project: "p_bops" });
  S.update(() => Object.assign(S.bot("boppy"), { computerId: "c_boppy", freeComputer: undefined }));
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  const p = await (await preview("ws_free")).json();
  assert.deepEqual(p.computers, [{ id: "c_free", name: "Your free Bops computer" }]);
  assert.equal((await Route.DELETE(req("DELETE", { id: "ws_free" }))).status, 200);
  assert.equal(where("c_free"), undefined);
  assert.equal(where("c_boppy"), "p_bops");

  // Made in the workspace's own project (after the move): it goes with the project, even when Boppy works on it.
  world({ modern: true });
  seed();
  S.update(() => Object.assign(S.bot("boppy"), { computer: "shared", computerId: undefined, freeComputer: undefined, computerStatus: "none" }));
  assert.equal((await Wk.migrateWorkspacesToOrgo()).status, "done");
  orgo.computers.get("c_free").project = ws("ws_free").orgoProjectId;
  assert.deepEqual((await (await preview("ws_free")).json()).computers, [{ id: "c_free", name: "Your free Bops computer" }]);
  assert.equal((await Route.DELETE(req("DELETE", { id: "ws_free" }))).status, 200);
  assert.equal(where("c_free"), undefined);
  assert.deepEqual([S.bot("boppy").computerId, S.bot("boppy").computer], [undefined, "shared"], "nothing gone handed on");
});

await check("The name bops stays the default's: once its project took the user's name, no other workspace gets bops", async () => {
  world({ modern: true });
  // Only the default's project is Bops' by name here (no older "Bops" one), so the name is free on Orgo.
  orgo.projects = orgo.projects.filter((p) => p.id !== "p_bops_old");
  seed({ mainName: "Studio" });
  orgo.apps = [NEW("0.0.29")];
  assert.equal((await Wk.migrateWorkspacesToOrgo()).defaultName.project, "Studio");
  assert.ok(!orgo.projects.some((p) => p.name.toLowerCase() === "bops"));
  // New workspace "bops": asked for another, nothing made.
  const n = orgo.projects.length;
  const taken = await Route.POST(post({ name: "bops" }));
  assert.equal(taken.status, 409);
  assert.deepEqual(await taken.json(), { error: "You already have an Orgo workspace named bops. Try bops (Bops) or another name.", code: "name_taken", suggestion: "bops (Bops)" });
  assert.equal(orgo.projects.length, n);
  // Rename to it: refused, nothing changes.
  const clash = await Route.PATCH(req("PATCH", { id: "ws_busy", name: "Bops" }));
  assert.equal(clash.status, 409);
  assert.equal((await clash.json()).code, "name_taken");
  assert.equal(ws("ws_busy").name, "Acme");
  // A workspace named bops here gets its project without being asked: "bops (Bops)", never "bops".
  S.update((st) => st.workspaces.push({ id: "ws_b", name: "bops", createdAt: 50 }));
  const before = orgo.calls.length;
  assert.equal((await O.ensureProject("ws_b")).name, "bops (Bops)");
  assert.ok(!orgo.calls.slice(before).some((c) => c.method === "POST" && c.body?.name === "bops"), "bops isn't even tried");
  assert.ok(!orgo.projects.some((p) => p.name.toLowerCase() === "bops"));
  // The default may take bops back.
  assert.deepEqual(await (await Route.PATCH(req("PATCH", { id: "ws_main", name: "bops" }))).json(), { ok: true });
  assert.equal(byId("p_bops").name, "bops");
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
