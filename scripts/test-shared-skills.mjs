// Tests for a shared workspace's skills on the viewer's own Bops (lib/server/shared-skills.ts, app/api/skills): an
// Admin there lists, reads, publishes, imports, updates from a folder, rolls back, deletes, gives a skill to its bots
// and approves scripts in orgo-web with their own Orgo key, with the owner's Mac off (no change act, no Bops Cloud);
// a request's `ws` is ignored and the viewer's own workspaces and folders are never touched; a Member without the
// power is refused before Orgo is asked; labels, Who has what and a bot's proposals stay the owner's; and orgo-web's
// refusals come out in plain words. Every word said is checked for dashes and for "Orbit".
//
// orgo-web is a fake (a local server with the skills routes), the shared workspace open is the test's (the real
// lib/server/shared.ts, with what Skills reads of it swapped for globalThis.__ss), the Keychain is never there, and the
// state and folders live in a throwaway folder: nothing reaches a real service. The keys are made up.
// Usage: node --conditions=react-server scripts/test-shared-skills.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
const UI = "ui-token-test-shared-skills";
process.env.BOPS_UI_TOKEN = UI;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-shared-skills-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
/** The viewer's own Orgo key (made up): their Bops sign in. */
const ORGO_KEY = "sk_orgo_test_shared_skills";
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
    // The shared workspace open: the real module, but what Skills reads of it is the test's while globalThis.__ss is set.
    if (url.endsWith("/lib/server/shared.ts") && !url.includes("?real")) {
      const real = JSON.stringify(`${url}?real`);
      return {
        format: "module",
        shortCircuit: true,
        source: `export * from ${real};\nimport * as real from ${real};\nexport const sharedOpen = () => (globalThis.__ss ? true : real.sharedOpen());\nexport const sharedSkillsOpen = () => (globalThis.__ss ? globalThis.__ss : real.sharedSkillsOpen());`,
      };
    }
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

/** Made up, in a shape the scanner knows. Nothing here is a real key. */
const FAKE_STRIPE = ["sk", "live", "0123456789abcdefABCDEF01"].join("_");

/* ---------------- A fake orgo-web's skills routes ---------------- */

const P = "11111111-2222-4333-8444-555555555555";
const AT = "2026-11-12T09:00:00.000Z";
const orgo = {
  pages: false,
  next: null,
  calls: [],
  skills: [],
  approvals: new Map(),
};
const reset = () => {
  orgo.pages = false;
  orgo.next = null;
  orgo.calls = [];
  orgo.approvals = new Map();
  orgo.skills = [
    // A draft a bot saved on its computer, for one bot.
    { id: "a0000000-0000-4000-8000-000000000001", slug: "weekly-report", name: "Weekly report", description: "Sums up the week.", type: "skill", status: "draft", bot_ids: ["max"], updated_at: AT, created_at: AT, versions: ["0.1.0"], current: "0.1.0", label: "Writing", body: "# Weekly report\n\n1. Read the chat.\n", files: [{ path: "scripts/sum.sh", sha256: "d".repeat(64), size_bytes: 20, executable: true, media_type: "text/x-shellscript", approved: false, content: "#!/bin/sh\necho 1\n" }] },
    // Published, under its label, for every bot with it.
    { id: "a0000000-0000-4000-8000-000000000002", slug: "triage", name: "Triage", description: "Sorts the inbox.", type: "skill", status: "published", bot_ids: [], updated_at: "2026-11-12T10:00:00.000Z", created_at: AT, versions: ["0.1.0", "0.1.1"], current: "0.1.1", label: "Email", body: "# Triage\n", files: [] },
    // Published, naming its bots.
    { id: "a0000000-0000-4000-8000-000000000003", slug: "invoices", name: "Invoices", description: "Sends invoices.", type: "skill", status: "published", bot_ids: ["max", "ivy"], updated_at: AT, created_at: AT, versions: ["1.0.0"], current: "1.0.0", body: "# Invoices\n", files: [] },
  ];
};
reset();
const send = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};
const view = (s) => ({ id: s.id, workspace_id: P, slug: s.slug, name: s.name, description: s.description, type: s.type, status: s.status, bot_ids: s.bot_ids, source: "bops", created_at: s.created_at, updated_at: s.updated_at, current_version: s.current ? { version: s.current, file_count: s.files.length + 1, size_bytes: 100, risk: null, created_at: AT, ...(s.label ? { label: s.label } : {}) } : null });
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  const url = new URL(req.url, "http://fake");
  const body = text ? JSON.parse(text) : undefined;
  orgo.calls.push({ method: req.method, path: url.pathname, query: url.search, body, auth: req.headers.authorization });
  if (req.headers.authorization !== `Bearer ${ORGO_KEY}`) return send(res, 401, { error: "Not authenticated" });
  if (orgo.pages) {
    res.writeHead(404, { "content-type": "text/html" });
    return res.end("<!doctype html><title>404</title>");
  }
  // A canned answer for the next call (of `method`, when it names one: the list read before a change goes on as usual).
  if (orgo.next && (!orgo.next.method || orgo.next.method === req.method)) {
    const n = orgo.next;
    orgo.next = null;
    return send(res, n.status, n.body);
  }
  const m = url.pathname.match(/^\/api\/projects\/([^/]+)\/skills(?:\/([^/]+))?(?:\/(versions|rollback|files)(?:\/(.+))?)?$/);
  if (!m || m[1] !== P) return send(res, 404, { error: "Workspace not found.", code: "not_found" });
  const [, , sid, sub, rest] = m;
  if (sid === "approvals") {
    const sha = url.searchParams.get("sha256");
    if (req.method === "POST") {
      orgo.approvals.set(body.sha256, { sha256: body.sha256, path_hint: body.path_hint ?? null, approved_by: "u_admin", approved_at: AT, approved_by_role: "admin" });
      return send(res, 201, { approval: orgo.approvals.get(body.sha256) });
    }
    if (req.method === "DELETE") return orgo.approvals.delete(sha) ? send(res, 200, { revoked: true, sha256: sha }) : send(res, 404, { error: "That hash is not approved.", code: "not_found" });
    return send(res, 200, { approvals: [...orgo.approvals.values()] });
  }
  if (!sid) {
    if (req.method === "GET") return send(res, 200, { skills: orgo.skills.map(view), deleted: [], full: true, at: AT });
    if (req.method === "POST") {
      const s = { id: `a0000000-0000-4000-8000-00000000010${orgo.skills.length}`, slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: body.name, description: body.description, type: body.type, status: body.status ?? "published", bot_ids: body.bot_ids ?? [], updated_at: AT, created_at: AT, versions: ["0.1.0"], current: "0.1.0", body: body.body, files: [] };
      orgo.skills.push(s);
      return send(res, 201, { skill: view(s), version: { version: "0.1.0" }, warnings: [] });
    }
  }
  const s = orgo.skills.find((x) => x.id === sid);
  if (!s) return send(res, 404, { error: "Skill not found.", code: "not_found" });
  if (!sub && req.method === "GET") {
    const v = url.searchParams.get("version") ?? s.current;
    if (!s.versions.includes(v)) return send(res, 404, { error: "That version does not exist.", code: "version_not_found" });
    return send(res, 200, { skill: { ...view(s), current_version: undefined }, version: { version: v, frontmatter: { name: s.slug, description: s.description }, body: s.body, files: s.files.map((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== "content"))) }, versions: s.versions });
  }
  if (sub === "files" && req.method === "GET") {
    const f = s.files.find((x) => x.path === decodeURIComponent(rest ?? ""));
    return f ? send(res, 200, { path: f.path, sha256: f.sha256, size_bytes: f.size_bytes, executable: f.executable, media_type: f.media_type, content: f.content }) : send(res, 404, { error: "File not found.", code: "not_found" });
  }
  if (!sub && req.method === "PATCH") {
    if (body.if_updated_at && body.if_updated_at !== s.updated_at) return send(res, 409, { error: "The skill changed since you read it.", code: "stale_skill", skill: view(s) });
    Object.assign(s, { ...(body.status ? { status: body.status } : {}), ...(body.bot_ids ? { bot_ids: body.bot_ids } : {}), updated_at: "2026-11-12T11:00:00.000Z" });
    return send(res, 200, { skill: view(s) });
  }
  if (!sub && req.method === "DELETE") {
    orgo.skills = orgo.skills.filter((x) => x !== s);
    return send(res, 200, { deleted: true, id: s.id });
  }
  if (sub === "rollback" && req.method === "POST") {
    s.current = body.version;
    return send(res, 200, { skill: view(s) });
  }
  if (sub === "versions" && req.method === "POST") {
    const v = `0.1.${s.versions.length}`;
    s.versions.push(v);
    Object.assign(s, { current: v, status: "published", body: body.body, updated_at: "2026-11-12T12:00:00.000Z" });
    return send(res, 201, { skill: view(s), version: { version: v } });
  }
  return send(res, 405, { error: "no" });
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
/** Everything a person could read, checked for dashes and Orbit at the end. */
const said = [];

const S = await import(`${root}/lib/server/store.ts`);
const W = await import(`${root}/lib/server/workspace-skills.ts`);
const SS = await import(`${root}/lib/server/shared-skills.ts`);
const Route = await import(`${root}/app/api/skills/route.ts`);
const route = async (body, method = "POST", { window = true } = {}) => {
  const res = await Route[method](
    new Request(`http://localhost:3210/api/skills${method === "GET" ? (body ?? "") : ""}`, { method, headers: { "content-type": "application/json", ...(window ? { "x-bops-window": UI } : {}) }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }),
  );
  const json = await res.json();
  said.push(JSON.stringify(json));
  return { status: res.status, body: json };
};
/** An Admin's shared workspace open (lib/server/shared.ts sharedSkillsOpen), or a Member's. */
const open = (role = "admin", can = []) => void (globalThis.__ss = { projectId: P, name: "Acme", role, can, botIds: ["max", "ivy"] });
const close = () => void (globalThis.__ss = undefined);
const calls = () => orgo.calls.map((c) => `${c.method} ${c.path}${c.query}`);

// The viewer's own Bops: their own workspace, with a skill of the same slug as the shared one's, in its folder.
S.update((s) => {
  s.owner = { name: "Sam" };
  s.account = { user: { id: "u_admin", email: "sam@example.com" }, signedInAt: 0 };
  s.workspaces = [{ id: "ws_main", name: "Mine", createdAt: 0 }];
  s.bots = [{ id: "max", name: "Max", role: "Sales", color: "#5B8CFF", isMain: true, computerStatus: "none" }];
});
const mine = W.createSkill("ws_main", { name: "Weekly report", description: "My own weekly report.", body: "# Mine\n" }).ref;
const mineMd = () => readFileSync(join(process.cwd(), ".data", "workspaces", "ws_main", "skills", mine.slug, "SKILL.md"), "utf8");
const mineBefore = mineMd();
const folder = (name, files) => {
  const dir = join(scratch, "folders", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
};

/* ---------------- An Admin, with the owner's Mac off ---------------- */

await check("an Admin's list is orgo-web's, with their own key, under its labels; the viewer's own workspace isn't read or sent", async () => {
  reset();
  open();
  try {
    const r = await route("?ws=ws_main", "GET");
    assert.equal(r.status, 200);
    assert.deepEqual(calls(), [`GET /api/projects/${P}/skills`]);
    assert.ok(orgo.calls.every((c) => c.auth === `Bearer ${ORGO_KEY}`), "the user's own Orgo key");
    assert.deepEqual(r.body.skills.map((x) => [x.slug, x.status, x.version, x.label, x.botIds]), [
      ["triage", "published", "0.1.1", "Email", []],
      ["weekly-report", "draft", undefined, "Writing", ["max"]],
      ["invoices", "published", "1.0.0", undefined, ["max", "ivy"]],
    ]);
    assert.deepEqual([r.body.orgo, r.body.shared, r.body.apps], [true, true, []]);
    assert.ok(!JSON.stringify(r.body).includes("My own weekly report"), "never the viewer's own skill of that slug");
  } finally {
    close();
  }
});

await check("detail and a file are orgo-web's: SKILL.md, its files (a script marked, not approved), its versions; no folder", async () => {
  reset();
  open();
  try {
    const d = await route({ action: "detail", ws: "ws_main", kind: "skill", slug: "weekly-report" });
    assert.equal(d.status, 200);
    assert.equal(d.body.body, "# Weekly report\n\n1. Read the chat.\n");
    assert.deepEqual(d.body.files, [{ path: "scripts/sum.sh", size: 20, sha256: "d".repeat(64), executable: true, script: true, approved: false, binary: false }]);
    assert.deepEqual(d.body.ref.versions.map((v) => v.version), ["0.1.0"]);
    assert.deepEqual([d.body.dir, d.body.missing, d.body.changed], [null, false, false]);
    const old = await route({ action: "detail", kind: "skill", slug: "triage", version: "0.1.0" });
    assert.equal(old.status, 200);
    assert.ok(orgo.calls.some((c) => c.path.endsWith("/a0000000-0000-4000-8000-000000000002") && c.query === "?version=0.1.0"));
    const f = await route({ action: "file", kind: "skill", slug: "weekly-report", path: "scripts/sum.sh" });
    assert.deepEqual(f.body, { path: "scripts/sum.sh", content: "#!/bin/sh\necho 1\n", sha256: "d".repeat(64) });
    assert.equal((await route({ action: "file", kind: "skill", slug: "weekly-report", path: "../x" })).status, 404);
    assert.equal((await route({ action: "detail", kind: "skill", slug: "nope" })).status, 404);
  } finally {
    close();
  }
});

await check("Publish sends PATCH status published (as read), only for a draft; the viewer's own skill of that slug stays as it was", async () => {
  reset();
  open();
  try {
    const r = await route({ action: "publish", ws: "ws_main", kind: "skill", slug: "weekly-report" });
    assert.equal(r.status, 200);
    assert.equal(r.body.ref.status, "published");
    const patch = orgo.calls.find((c) => c.method === "PATCH");
    assert.deepEqual([patch.path, patch.body], [`/api/projects/${P}/skills/a0000000-0000-4000-8000-000000000001`, { status: "published", if_updated_at: AT }]);
    assert.equal(orgo.skills[0].status, "published");
    const n = orgo.calls.length;
    const again = await route({ action: "publish", kind: "skill", slug: "triage" });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /published already/);
    assert.ok(!orgo.calls.slice(n).some((c) => c.method === "PATCH"), "nothing sent for one published");
    // Changed by someone else between Bops' read and its PATCH: orgo-web's 409 stale_skill, said in words.
    orgo.skills[0].status = "draft";
    orgo.next = { method: "PATCH", status: 409, body: { error: "The skill changed since you read it.", code: "stale_skill" } };
    const stale = await route({ action: "publish", kind: "skill", slug: "weekly-report" });
    assert.deepEqual([stale.status, stale.body.error], [409, "Someone changed it just now. Look at it again, then try again."]);
    // The viewer's own workspace: untouched.
    assert.equal(W.findRef("ws_main", "skill", mine.slug).status, "draft");
    assert.equal(mineMd(), mineBefore);
  } finally {
    close();
  }
});

await check("Roll back, Delete and a skill's own bots go to orgo-web; one that follows its label isn't switched here", async () => {
  reset();
  open();
  try {
    let r = await route({ action: "rollback", kind: "skill", slug: "triage", version: "0.1.0" });
    assert.equal(r.status, 200);
    assert.deepEqual(orgo.calls.at(-1).body, { version: "0.1.0" });
    assert.equal(r.body.ref.version, "0.1.0");
    r = await route({ action: "bot", kind: "skill", slug: "invoices", botId: "ivy", on: false });
    assert.equal(r.status, 200);
    assert.deepEqual(orgo.calls.at(-1).body, { bot_ids: ["max"], if_updated_at: AT });
    assert.deepEqual(r.body.ref.botIds, ["max"]);
    r = await route({ action: "bot", kind: "skill", slug: "invoices", botId: "max", on: false });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /At least one bot keeps it/);
    const n = orgo.calls.length;
    r = await route({ action: "bot", kind: "skill", slug: "triage", botId: "max", on: false });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, SS.BY_LABEL);
    r = await route({ action: "bot", kind: "skill", slug: "invoices", botId: "stranger", on: true });
    assert.equal(r.status, 404);
    assert.ok(!orgo.calls.slice(n).some((c) => c.method === "PATCH"));
    r = await route({ action: "delete", kind: "skill", slug: "invoices" });
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    assert.equal(orgo.calls.at(-1).method, "DELETE");
    assert.ok(!orgo.skills.some((x) => x.slug === "invoices"));
    assert.ok(W.findRef("ws_main", "skill", mine.slug), "the viewer's own skill is still there");
  } finally {
    close();
  }
});

await check("approving a script goes to orgo-web with the user's own sign in; taking it back too; a key orgo-web won't take, in words", async () => {
  reset();
  open();
  try {
    let r = await route({ action: "approve", kind: "skill", sha256: "d".repeat(64), path: "scripts/sum.sh", on: true });
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    const post = orgo.calls.at(-1);
    assert.deepEqual([post.method, post.path, post.body, post.auth], ["POST", `/api/projects/${P}/skills/approvals`, { sha256: "d".repeat(64), path_hint: "scripts/sum.sh" }, `Bearer ${ORGO_KEY}`]);
    r = await route({ action: "approve", kind: "skill", sha256: "d".repeat(64), on: false });
    assert.equal(r.status, 200);
    assert.equal(orgo.calls.at(-1).query, `?sha256=${"d".repeat(64)}`);
    // Not approved there (anymore): nothing to take back.
    assert.equal((await route({ action: "approve", sha256: "d".repeat(64), on: false })).status, 200);
    orgo.next = { method: "POST", status: 403, body: { error: "A person approves scripts.", code: "session_required" } };
    r = await route({ action: "approve", sha256: "d".repeat(64), on: true });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /^Orgo takes an approval only from you, signed in to Bops with Orgo\./);
    assert.equal((await route({ action: "approve", sha256: "nope", on: true })).status, 400);
    assert.deepEqual(W.workspaceById("ws_main").approvals ?? [], [], "nothing kept on this Mac");
  } finally {
    close();
  }
});

await check("Update from folder publishes the folder as its next version (POST versions); a new folder is a draft (POST skills); checked first", async () => {
  reset();
  open();
  try {
    const dir = folder("weekly-report", { "SKILL.md": "---\nname: weekly-report\ndescription: Sums up the week, better.\n---\n# Weekly report\n\n1. Read every chat.\n", "scripts/sum.sh": "#!/bin/sh\necho 2\n", "notes.log": "junk" });
    let r = await route({ action: "import", ws: "ws_main", kind: "skill", slug: "weekly-report", path: dir });
    assert.equal(r.status, 200);
    const sent = orgo.calls.at(-1);
    assert.deepEqual([sent.method, sent.path], ["POST", `/api/projects/${P}/skills/a0000000-0000-4000-8000-000000000001/versions`]);
    assert.match(sent.body.body, /^---\nname: weekly-report\ndescription: "?Sums up the week, better\."?\n---\n/);
    assert.deepEqual(sent.body.files.map((f) => f.path), ["scripts/sum.sh"], "junk left out");
    assert.equal(sent.body.version, undefined, "orgo-web picks the next number");
    assert.deepEqual([r.body.published, r.body.ref.status, r.body.ref.version], [true, "published", "0.1.1"]);
    assert.deepEqual(r.body.skipped.map((p) => p.path), ["notes.log"]);
    assert.equal(mineMd(), mineBefore, "the viewer's own folder of that slug untouched");
    // Another skill's folder: refused before Orgo is asked.
    const n = orgo.calls.length;
    r = await route({ action: "import", kind: "skill", slug: "weekly-report", path: folder("other", { "SKILL.md": "---\nname: other\ndescription: Something else.\n---\n# Other\n" }) });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /another skill/);
    // A secret in SKILL.md: refused too, never its text.
    r = await route({ action: "import", kind: "skill", path: folder("leaky", { "SKILL.md": `---\nname: leaky\ndescription: Leaks.\n---\nkey=${FAKE_STRIPE}\n` }) });
    assert.equal(r.status, 422);
    assert.ok(!JSON.stringify(r.body).includes(FAKE_STRIPE));
    assert.equal(orgo.calls.length, n + 1, "only the list was read");
    // A new folder: a draft in Orgo.
    r = await route({ action: "import", kind: "skill", path: folder("standup", { "SKILL.md": "---\nname: standup\ndescription: Runs the standup.\n---\n# Standup\n" }) });
    assert.equal(r.status, 200);
    const made = orgo.calls.at(-1);
    assert.deepEqual([made.method, made.path, made.body.status, made.body.type, made.body.name], ["POST", `/api/projects/${P}/skills`, "draft", "skill", "Standup"]);
    assert.equal(r.body.ref.status, "draft");
    assert.ok(!W.findRef("ws_main", "skill", "standup"), "not made in the viewer's own workspace");
  } finally {
    close();
  }
});

await check("labels, Who has what, a bot's proposals and a chat's Save as skill stay the owner's: refused, Orgo never asked", async () => {
  reset();
  open();
  try {
    for (const action of ["bot-label", "bot-labels", "label-rename", "label-about", "label-suggest", "proposal", "create", "update", "draft", "save-draft", "nonsense"]) {
      const r = await route({ action, ws: "ws_main", kind: "skill", slug: "triage", label: "Email", botId: "max", on: true });
      assert.deepEqual([action, r.status, r.body.error], [action, 403, SS.SHARED_OWNER_ONLY]);
    }
    assert.deepEqual(calls(), []);
    assert.equal(W.workspaceById("ws_main").skills.length, 1, "nothing made in the viewer's own workspace");
  } finally {
    close();
  }
});

await check("a Member (even with Memory and skills, until phase 2) is refused before Orgo is asked; and only from the Bops window", async () => {
  reset();
  for (const can of [[], ["memory"]]) {
    open("member", can);
    try {
      for (const r of [await route("", "GET"), await route({ action: "detail", kind: "skill", slug: "triage" }), await route({ action: "publish", kind: "skill", slug: "weekly-report" })]) {
        assert.deepEqual([r.status, r.body.error], [403, SS.SHARED_SKILLS_WHO]);
      }
    } finally {
      close();
    }
  }
  open();
  try {
    const r = await route({ action: "publish", kind: "skill", slug: "weekly-report" }, "POST", { window: false });
    assert.equal(r.status, 403);
    assert.equal((await route("", "GET", { window: false })).status, 403);
  } finally {
    close();
  }
  assert.deepEqual(calls(), []);
});

await check("orgo-web's refusals in plain words: view only, no skills routes (a page), signed out, a gone workspace", async () => {
  reset();
  open();
  try {
    orgo.next = { method: "PATCH", status: 403, body: { error: "This workspace is view only. Ask the owner for edit access.", code: "workspace_read_only" } };
    let r = await route({ action: "publish", kind: "skill", slug: "weekly-report" });
    // (The list read first: the refusal is the PATCH's.)
    assert.deepEqual([r.status, r.body.error], [403, SS.SHARED_SKILLS_WHO]);
    assert.equal(orgo.calls.at(-1).method, "PATCH");
    orgo.next = null;
    orgo.skills[0].status = "draft";
    orgo.calls = [];
    orgo.pages = true;
    r = await route("", "GET");
    assert.deepEqual([r.status, r.body.error], [503, SS.SKILLS_NOT_ON_ORGO]);
    orgo.pages = false;
    orgo.next = { status: 404, body: { error: "Workspace not found.", code: "not_found" } };
    r = await route("", "GET");
    assert.deepEqual([r.status, r.body.error], [404, "This workspace isn't shared with you anymore."]);
    orgo.next = { status: 403, body: { error: "This workspace is view only. Ask the owner for edit access.", code: "workspace_read_only" } };
    r = await route("", "GET");
    assert.deepEqual([r.status, r.body.error], [403, SS.SHARED_SKILLS_WHO]);
    globalThis.bopsOrgoKey = "sk_orgo_someone_else";
    r = await route("", "GET");
    assert.equal(r.status, 401);
    assert.match(r.body.error, /^Sign in to Orgo/);
  } finally {
    globalThis.bopsOrgoKey = ORGO_KEY;
    close();
  }
});

await check("with no shared workspace open, Skills is the viewer's own, as before", async () => {
  reset();
  const r = await route("?ws=ws_main", "GET");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.skills.map((x) => x.slug), [mine.slug]);
  assert.deepEqual(calls(), []);
});

await check("nothing said has a dash or says Orbit, and no body or key was logged", async () => {
  const words = [...said, SS.SHARED_OWNER_ONLY, SS.SHARED_SKILLS_WHO, SS.SKILLS_NOT_ON_ORGO, SS.BY_LABEL];
  for (const w of words) {
    const errors = [...w.matchAll(/"error":"([^"]*)"/g)].map((m) => m[1]);
    for (const e of errors.length ? errors : [w]) {
      assert.ok(!/[‒–—―]| - /.test(e), `a dash in: ${e}`);
      assert.ok(!/orbit/i.test(e), `Orbit in: ${e}`);
    }
  }
  const log = logged.join("\n");
  for (const secret of [ORGO_KEY, FAKE_STRIPE, "Read every chat"]) assert.ok(!log.includes(secret), `logged: ${secret}`);
});

server.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
