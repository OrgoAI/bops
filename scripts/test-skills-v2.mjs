// Tests for skills v2 (lib/server/skill-bundle.ts, lib/server/workspace-skills.ts, lib/skill-labels.ts,
// lib/server/skill-proposals.ts, lib/skill-proposals.ts, lib/server/bops-sync.ts, app/api/skills): SKILL.md in the
// Agent Skills spec's form (Bops' own fields as strings in metadata) written, and the form from before still read
// (a stored version never refused for it, one from Orgo made fit whatever its metadata says, a metadata.version that
// isn't one only a warning, as orgo-web); the spec's name rules on an import (the folder's own name, no double
// hyphen), an existing skill with another name still working; which bot has which skill (a skill's own bot list,
// else the bot's labels, every combination) in every list, read, count and copy to a computer; Who has what (the
// first untick of an every label bot, back to every label), a label renamed (its skills, its bots and its about
// line move) and its about line in the prompts; the label sent to orgo-web only where it keeps one (its skill JSON
// says "label", else as before), Orgo's label column taken unless it's the one last agreed (a move here kept, and
// sent once a PATCH's answer or the whole list says Orgo keeps the column, after a restart too), skill_labels in the bots map only where
// orgo-web's bot_fields list it, and the label info cached from orgo-web's skill-labels route (kept on this Mac
// without it); proposals (propose_skill_change in every turn: the owner's, a routine's run, someone else's, one that
// read the web; a secret refused; the change as its card shows it; Accept only from the window, never on a runner,
// once; a stale base shown on what the skill is now and applied only once seen; only its message's own, and one
// without this Mac's mark shown on what the skill is now first; Reject; a runner's in its bot's chat); and Update from folder (the next version, its label, bots and history kept, published when asked).
// OpenAI and orgo-web are fakes (fetch answered here), the Keychain is never there, and the state and folders live
// in a throwaway folder: nothing reaches a real service. The keys in it are made up.
// Usage: node --conditions=react-server scripts/test-skills-v2.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-skills-v2";
const UI = "ui-token-test-skills-v2";
process.env.BOPS_UI_TOKEN = UI;
process.env.BOPS_ORGO_ORIGIN = "http://orgo.test";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-skills-v2-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const ORGO_KEY = "sk_orgo_test_skills_v2";
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
const logged = [];
for (const k of ["info", "warn", "error"]) console[k] = (...a) => logged.push(a.map(String).join(" "));

/** Made up, in the shape the scanner knows. Nothing here is a real key. */
const FAKE_STRIPE = ["sk", "live", "0123456789abcdefABCDEF01"].join("_");

/* ---------------- Fakes: OpenAI and orgo-web ---------------- */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const asked = [];
const answers = [];
let n = 0;
const response = (output) => ({ id: `resp_${++n}`, object: "response", model: "gpt-test", status: "completed", output, usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
const said = (text) => ({ id: `msg_${++n}`, type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
const toolCall = (name, args) => ({ id: `fc_${++n}`, type: "function_call", call_id: `call_${n}`, name, arguments: JSON.stringify(args) });
const toolNames = (body) => body.tools.map((t) => t.name ?? t.type);

/**
 * orgo-web: the skills routes (a project's skills, with the label column only when `column`, and only what changed
 * since `?since=` with the time to ask from next when `since`), the skill-labels route (only when `labelsRoute`),
 * and the bots map (its GET answering `botFields` when set). Every call is kept.
 */
const orgo = { calls: [], skills: [], seq: 0, column: false, since: false, labelsRoute: true, labels: [], botFields: undefined, maps: [] };
const now = () => new Date(Date.now() + ++orgo.seq).toISOString();
const view = (s) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description, type: s.type, status: s.status, bot_ids: s.bot_ids, updated_at: s.updated_at, current_version: s.version ? { version: s.version } : null, ...(orgo.column ? { label: s.label ?? null } : {}) });
const labelIn = (md) => /\nmetadata: \{[^}]*label: ([^,}]+)/.exec(md ?? "")?.[1]?.trim();
async function fakeOrgo(req, url) {
  const body = req.method === "GET" || req.method === "DELETE" ? undefined : JSON.parse((await req.text()) || "null");
  orgo.calls.push({ method: req.method, path: url.pathname, search: url.search, body });
  if (req.headers.get("authorization") !== `Bearer ${ORGO_KEY}`) return json({ error: "Not authenticated" }, 401);
  const map = url.pathname.match(/^\/api\/projects\/([^/]+)\/bops$/);
  if (map) {
    const fields = orgo.botFields ? { bot_fields: orgo.botFields } : {};
    if (req.method === "GET") return json({ kinds: [], ...fields });
    orgo.maps.push({ pid: map[1], body });
    return json({ ok: true, kinds: [], ...fields });
  }
  const labels = url.pathname.match(/^\/api\/projects\/([^/]+)\/skill-labels$/);
  if (labels) {
    if (!orgo.labelsRoute) return new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } });
    if (req.method === "PUT") orgo.labels = body.labels;
    return json({ labels: orgo.labels });
  }
  const m = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/skills(?:\/([^/]+))?(?:\/(versions|export))?$/);
  if (!m) return new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } });
  const [, , sid, sub] = m;
  if (sid === "approvals") return json({ approvals: [] });
  if (!sid && req.method === "GET") {
    if (!orgo.since) return json({ skills: orgo.skills.map(view) });
    const since = url.searchParams.get("since");
    const at = new Date(Math.max(Date.now(), ...orgo.skills.map((x) => Date.parse(x.updated_at)))).toISOString();
    return since ? json({ skills: orgo.skills.filter((x) => x.updated_at > since).map(view), deleted: [], full: false, at }) : json({ skills: orgo.skills.map(view), at });
  }
  if (!sid && req.method === "POST") {
    const s = { id: `sk_${++orgo.seq}`, slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: body.name, description: body.description, type: body.type, status: body.status, bot_ids: body.bot_ids, version: body.version, body: body.body, files: body.files, label: labelIn(body.body) ?? null, updated_at: now() };
    orgo.skills.push(s);
    return json({ skill: view(s) }, 201);
  }
  const s = orgo.skills.find((x) => x.id === sid);
  if (!s) return json({ error: "Not found" }, 404);
  if (sub === "export") return json({ slug: s.slug, name: s.name, version: s.version, files: { "SKILL.md": { content: s.body } } });
  if (sub === "versions") {
    Object.assign(s, { body: body.body, files: body.files, version: body.version, updated_at: now() });
    // orgo-web sets its label from the saved version's metadata.label.
    if (labelIn(body.body)) s.label = labelIn(body.body);
    return json({ skill: view(s) }, 201);
  }
  if (req.method === "PATCH") {
    Object.assign(s, { ...(body.name ? { name: body.name } : {}), ...(body.bot_ids ? { bot_ids: body.bot_ids } : {}), ...(body.status ? { status: body.status } : {}), updated_at: now() });
    // An older orgo-web refuses a field it doesn't know; one with the column takes it (null: Unsorted).
    if ("label" in body) {
      if (!orgo.column) return json({ error: "Unknown field: label" }, 400);
      s.label = body.label;
    }
    return json({ skill: view(s) });
  }
  return json({ error: "no" }, 405);
}
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin === "http://orgo.test") return fakeOrgo(req, url);
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/responses") {
    const b = JSON.parse(await req.text());
    asked.push(b);
    const next = answers.shift();
    return json(next ? next(b) : response([said("Done.")]));
  }
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};

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
/** Everything a person or a bot could read, checked for dashes and for the made up secret at the end. */
const heard = [];
const hear = (x) => (heard.push(typeof x === "string" ? x : JSON.stringify(x)), x);

const S = await import(`${root}/lib/server/store.ts`);
const W = await import(`${root}/lib/server/workspace-skills.ts`);
const B = await import(`${root}/lib/server/skill-bundle.ts`);
const L = await import(`${root}/lib/skill-labels.ts`);
const PL = await import(`${root}/lib/skill-proposals.ts`);
const P = await import(`${root}/lib/server/skill-proposals.ts`);
const Chat = await import(`${root}/lib/server/chat.ts`);
const Routines = await import(`${root}/lib/server/routines.ts`);
const Sync = await import(`${root}/lib/server/bops-sync.ts`);
const CS = await import(`${root}/cloud/computer-scope.ts`);
const Route = await import(`${root}/app/api/skills/route.ts`);
clearInterval(globalThis.__bopsRoutines);
const { botChatId } = await import(`${root}/lib/types.ts`);
const route = async (body, { window = true } = {}) => {
  const res = await Route.POST(new Request("http://localhost:3210/api/skills", { method: "POST", headers: { "content-type": "application/json", ...(window ? { "x-bops-window": UI } : {}) }, body: JSON.stringify(body) }));
  return { status: res.status, body: hear(await res.json()) };
};

S.update((s) => {
  s.owner = { name: "Alex" };
  s.account = { user: { id: "u_alex", email: "alex@example.com", name: "Alex" }, signedInAt: 1 };
  s.workspaces = [
    { id: "ws_main", name: "Main", createdAt: 0 },
    { id: "ws_lab", name: "Lab", createdAt: 1, orgoProjectId: "p_lab" },
    { id: "ws_sync", name: "Sync", createdAt: 2, orgoProjectId: "p_sync" },
  ];
  const boppy = s.bots.find((b) => b.id === "boppy");
  if (!boppy) s.bots.push({ id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none" });
  s.bots.push(
    { id: "ana", name: "Ana", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "ready", computerId: "c_ana", workspaceId: "ws_lab" },
    { id: "ben", name: "Ben", role: "Finance", color: "#5B8CFF", isMain: false, computerStatus: "ready", computer: "own", computerId: "c_ben", workspaceId: "ws_lab" },
    { id: "syd", name: "Syd", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", workspaceId: "ws_sync" },
  );
  s.routines.push({ id: "rtn_sweep", botId: "boppy", title: "Morning sweep", goal: "Sweep the inbox.", schedule: { kind: "daily", time: "09:00" }, enabled: false });
});
const dataDir = () => join(process.cwd(), ".data", "workspaces");
/** A workspace's folder: its Orgo project's id once it has one (workspace-skills.ts folderKey). */
const wsDir = (ws) => join(dataDir(), S.getState().workspaces.find((w) => w.id === ws)?.orgoProjectId ?? ws);
const skillMd = (ws, slug) => readFileSync(join(wsDir(ws), "skills", slug, "SKILL.md"), "utf8");
const versionMd = (ws, slug, v) => readFileSync(join(wsDir(ws), ".versions", "skills", slug, v, "SKILL.md"), "utf8");
const folder = (name, md, files = {}) => {
  const f = join(scratch, "folders", name);
  mkdirSync(f, { recursive: true });
  writeFileSync(join(f, "SKILL.md"), md);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(f, p, ".."), { recursive: true });
    writeFileSync(join(f, p), c);
  }
  return f;
};
const bot = (id) => S.getState().bots.find((b) => b.id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setLabels = (id, labels) => S.update((s) => {
  const b = s.bots.find((x) => x.id === id);
  if (labels === undefined) delete b.skillLabels;
  else b.skillLabels = labels;
});

/* ---------------- The spec's form ---------------- */

await check("specOf reads both forms (metadata first); toSpecForm moves Bops' fields into metadata as strings, the rest where it was", async () => {
  const old = { name: "vm-health", description: "x", version: "1.2.0", risk: "read", runs_on: "local", requires_secrets: ["DATABASE_URL", "GITHUB_TOKEN"], label: "Ops", license: "MIT", applies_to: { env: "prod" } };
  assert.deepEqual(B.specOf(old), { label: "Ops", version: "1.2.0", risk: "read", runsOn: "local", requiresSecrets: ["DATABASE_URL", "GITHUB_TOKEN"] });
  const spec = B.toSpecForm(old);
  assert.deepEqual(spec, { name: "vm-health", description: "x", license: "MIT", applies_to: { env: "prod" }, metadata: { version: "1.2.0", risk: "read", "runs-on": "local", "requires-secrets": "DATABASE_URL GITHUB_TOKEN", label: "Ops" } });
  assert.deepEqual(B.specOf(spec), B.specOf(old), "the same fields read back");
  // metadata wins over a top level key from before; values become strings.
  assert.deepEqual(B.toSpecForm({ name: "a", description: "b", risk: "write", metadata: { risk: "read", n: 3, on: true } }).metadata, { risk: "read", n: "3", on: "true" });
  assert.deepEqual(B.toSpecForm({ name: "a", description: "b", metadata: { label: "Ops", version: "1.0.0" } }, { label: null, version: null }), { name: "a", description: "b" }, "null takes one out; an empty metadata goes");
  // As orgo-web checks a new save: a risk, a runs-on and vault key names; a version that isn't one only warns.
  assert.deepEqual(B.validateFrontmatter({ metadata: { version: "1.0", risk: "maybe", "runs-on": "moon", "requires-secrets": "OK_NAME $BAD" } }).map((p) => p.reason), [
    "frontmatter metadata.risk: one of read, write, destructive",
    "frontmatter metadata.runs-on: one of local, remote-host, container",
    "frontmatter metadata.requires-secrets: vault key names separated by spaces (never the values)",
  ]);
  assert.deepEqual(B.validateFrontmatter({ name: "pdf-tools", description: "x", metadata: { author: "example-org", version: "1.0" } }), [], "the spec's own example");
  assert.deepEqual(B.frontmatterWarnings({ metadata: { version: "1.0" }, compatibility: "x".repeat(501) }).map((p) => p.reason), ["metadata.version is not a version such as 1.2.0, so the version number is set for you", "compatibility is text of 500 characters at most"]);
  assert.equal(B.specOf({ metadata: { version: "1.0" } }).version, undefined, "read as none: it's numbered");
  assert.deepEqual(B.specOf({ version: "1.2.0", risk: "read", metadata: { version: "1.0", risk: "high" } }), { version: "1.2.0", risk: "read" }, "one Bops wouldn't take reads as none, then the old form");
  assert.deepEqual(B.validateFrontmatter(old), [], "the form from before passes as it did");
  assert.deepEqual(B.validateFrontmatter({ version: "1.0" }).map((p) => p.reason), ["frontmatter version: a version such as 1.2.0"], "the old form checked as before");
  assert.deepEqual(B.validateFrontmatter({ compatibility: "x".repeat(501) }), [], "a warning, as orgo-web takes it");
  // A stored one made fit, never refused: metadata as text, what a new save would refuse taken out.
  const fit = B.fitFrontmatter({ name: "a", description: "b", risk: "high", requires_secrets: "A B", metadata: { author: "x", version: "1.0", risk: "high", "runs-on": "local", n: 3 } });
  assert.deepEqual(fit, { name: "a", description: "b", metadata: { author: "x", "runs-on": "local", n: "3" } });
  assert.deepEqual(B.validateFrontmatter(fit), []);
  assert.deepEqual(B.fitFrontmatter({ name: "a", metadata: "free text" }), { name: "a" });
});

await check("Importing the spec's own example (metadata.version \"1.0\"): taken with a warning, numbered when published", async () => {
  const f = folder("pdf-tools", "---\nname: pdf-tools\ndescription: Works with PDF files\nmetadata: {author: example-org, version: \"1.0\"}\n---\n# PDF tools\n\nUse it.\n");
  const r = await route({ action: "import", ws: "ws_main", path: f });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.warnings.some((w) => /metadata\.version is not a version/.test(w.reason)));
  assert.match(skillMd("ws_main", "pdf-tools"), /author: example-org/);
  assert.equal(W.publishSkill("ws_main", "skill", "pdf-tools").version, "0.1.0");
  assert.match(versionMd("ws_main", "pdf-tools", "0.1.0"), /version: "0\.1\.0"/);
  assert.equal((await route({ action: "delete", ws: "ws_main", kind: "skill", slug: "pdf-tools" })).status, 200);
});

await check("A skill made, imported and published is written in the spec's form; one in the form from before is still read, and an unchanged one is still 'nothing changed'", async () => {
  const f = folder("deploy-check", "---\nname: deploy-check\ndescription: Checks a deploy\nversion: \"2.0.0\"\nrisk: write\nruns_on: remote-host\nrequires_secrets: [DEPLOY_TOKEN]\nlabel: Ops\n---\n# Deploy check\n\nRun it.\n");
  const r = await route({ action: "import", ws: "ws_main", path: f });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.ref.risk, r.body.ref.runsOn, r.body.ref.label], ["write", "remote-host", "Ops"]);
  const md = skillMd("ws_main", "deploy-check");
  assert.match(md, /^---\nname: deploy-check\ndescription: Checks a deploy\nmetadata: \{[^}\n]+\}\n---\n/);
  assert.deepEqual(B.parseSkillMd(md).frontmatter, { name: "deploy-check", description: "Checks a deploy", metadata: { label: "Ops", risk: "write", "runs-on": "remote-host", "requires-secrets": "DEPLOY_TOKEN" } });
  assert.doesNotMatch(md, /\n(version|risk|runs_on|requires_secrets|label):/, "nothing of Bops' at the top");
  const pub = W.publishSkill("ws_main", "skill", "deploy-check");
  assert.match(versionMd("ws_main", "deploy-check", pub.version), /\nmetadata: \{[^}]*version: "0\.1\.0"[^}]*\}\n/);
  // A version kept in the form from before (as Orgo or an older Bops wrote it): read as it is, and the same folder is "nothing changed".
  const vdir = join(dataDir(), "ws_main", ".versions", "skills", "deploy-check", "0.1.0");
  writeFileSync(join(vdir, "SKILL.md"), "---\nname: deploy-check\ndescription: Checks a deploy\nversion: \"0.1.0\"\nrisk: write\nruns_on: remote-host\nrequires_secrets: [DEPLOY_TOKEN]\nlabel: Ops\n---\n# Deploy check\n\nRun it.\n");
  S.update((s) => (s.workspaces[0].skills.find((x) => x.slug === "deploy-check").versions[0].sha256 = "0".repeat(64)));
  assert.match(W.readSkill("boppy", "deploy-check"), /^Skill: Deploy check \(version 0\.1\.0\)\n\n# Deploy check\n\nRun it\./);
  assert.throws(() => W.publishSkill("ws_main", "skill", "deploy-check"), /Nothing changed since 0\.1\.0\./);
  await W.deleteSkill("ws_main", "skill", "deploy-check");
});

/* ---------------- The spec's name ---------------- */

await check("Names: the spec's rule (a to z, 0 to 9, single hyphens, 64 at most), and an imported folder's SKILL.md name is its folder's", async () => {
  assert.equal(B.nameProblem("inbox-sweep"), null);
  for (const bad of ["Inbox", "inbox--sweep", "-inbox", "inbox-", "in box", "x".repeat(65), ""]) assert.ok(B.nameProblem(bad), bad);
  assert.match(B.nameProblem("other-name", "inbox-sweep"), /must be its folder's name, "inbox-sweep"/);
  const twice = folder("two--hyphens", "---\nname: two--hyphens\ndescription: x\n---\n# Two\n");
  const r1 = await route({ action: "import", ws: "ws_main", path: twice });
  assert.equal(r1.status, 400);
  assert.match(r1.body.problems[0].reason, /^frontmatter name: lowercase letters, digits and single hyphens only/);
  const other = folder("my-skill", "---\nname: not-my-skill\ndescription: x\n---\n# Mine\n");
  const r2 = await route({ action: "import", ws: "ws_main", path: other });
  assert.equal(r2.status, 400);
  assert.deepEqual(r2.body.problems, [{ path: "SKILL.md", reason: 'frontmatter name: must be its folder\'s name, "my-skill"' }]);
  // No name said: the folder's, as before.
  const none = folder("plain-folder", "---\ndescription: Does a plain thing\n---\n# Plain\n");
  const r3 = await route({ action: "import", ws: "ws_main", path: none });
  assert.equal(r3.status, 200, JSON.stringify(r3.body));
  await W.deleteSkill("ws_main", "skill", r3.body.ref.slug);
  // One kept from before with a name the spec doesn't take keeps working.
  const dir = join(dataDir(), "ws_main", "skills", "Old--Skill");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: Old--Skill\ndescription: From before\n---\n# Old skill\n\nStill works.\n");
  S.update((s) => s.workspaces[0].skills.push({ slug: "Old--Skill", kind: "skill", name: "Old skill", description: "From before", label: "Other", status: "draft", botIds: [], source: "import", createdAt: 1, updatedAt: 1 }));
  const pub = W.publishSkill("ws_main", "skill", "Old--Skill");
  assert.match(W.readSkill("boppy", "Old skill"), /Still works\./);
  assert.equal(pub.status, "published");
  await W.deleteSkill("ws_main", "skill", "Old--Skill");
});

/* ---------------- Which bot has which ---------------- */

await check("botHasSkill, every combination: a skill's own bots first, else the bot's labels (unset every label, empty none, any case)", async () => {
  const me = (skillLabels) => ({ id: "me", ...(skillLabels !== undefined ? { skillLabels } : {}) });
  const cases = [
    // [skill botIds, bot labels, has it]
    [[], undefined, true],
    [[], [], false],
    [[], ["Email"], true],
    [[], ["email"], true],
    [[], ["Finance"], false],
    [["me"], undefined, true],
    [["me"], [], true],
    [["me"], ["Finance"], true],
    [["other"], undefined, false],
    [["other"], ["Email"], false],
  ];
  for (const [botIds, labels, has] of cases) assert.equal(L.botHasSkill({ botIds, label: "Email" }, me(labels)), has, JSON.stringify([botIds, labels]));
  assert.equal(L.botHasSkill({ botIds: [] }, me(["Unsorted"])), true, "no label is Unsorted");
  assert.equal(L.botHasSkill({ botIds: [] }, me(["Other"])), true, "and Other, kept from before, is Unsorted");
  // Ticks: the first untick of an every label bot is every label but that one; every one ticked again is every label.
  const all = ["Email", "Finance", "Unsorted"];
  assert.deepEqual(L.nextBotLabels(undefined, all, "Finance", false), ["Email", "Unsorted"]);
  assert.equal(L.nextBotLabels(["Email", "Unsorted"], all, "finance", true), undefined);
  assert.deepEqual(L.nextBotLabels(["Email"], all, "Email", false), []);
  assert.deepEqual(L.nextBotLabels([], all, "Email", true), ["Email"]);
});

await check("The rule everywhere: a bot's list, read_skill, its labels' counts, a routine's skill, and its computer's folders and INDEX.md", async () => {
  W.createSkill("ws_lab", { name: "Inbox sweep", description: "Sorts the inbox", body: "# Inbox sweep\n\n1. Open it.\n", label: "Email", status: "published" });
  W.createSkill("ws_lab", { name: "Invoice run", description: "Sends the invoices", body: "# Invoice run\n", label: "Finance", status: "published" });
  W.createSkill("ws_lab", { name: "Ben only", description: "Ben's own", body: "# Ben only\n", label: "Finance", botIds: ["ben"], status: "published" });
  const names = (id) => W.skillsFor(id).map((r) => r.name).sort();
  assert.deepEqual(names("ana"), ["Inbox sweep", "Invoice run"]);
  assert.deepEqual(names("ben"), ["Ben only", "Inbox sweep", "Invoice run"]);
  setLabels("ana", ["Email"]);
  setLabels("ben", ["finance"]);
  assert.deepEqual(names("ana"), ["Inbox sweep"]);
  assert.deepEqual(names("ben"), ["Ben only", "Invoice run"]);
  assert.match(W.readSkill("ana", "Invoice run"), /^No skill called "Invoice run"\./, "not Ana's now");
  assert.match(W.readSkill("ben", "Invoice run"), /^Skill: Invoice run/);
  assert.deepEqual(W.skillGroups("ana").filter((g) => !g.builtin).map((g) => [g.label, g.count]), [["Email", 1]]);
  assert.equal(W.findSkill("ana", "Invoice run"), undefined, "a routine naming it doesn't follow it for Ana");
  const copied = [];
  const bash = async (_id, cmd) => (copied.push(cmd), { output: "", exit_code: 0 });
  assert.equal(await W.copySkillsToComputer("ana", "c_ana", bash), 1);
  const sent = copied.join("\n");
  const index = Buffer.from(/printf %s '([^']+)' \| base64 -d >> '\/workspace\/capabilities\/skills\/INDEX\.md'/.exec(sent)[1], "base64").toString();
  assert.match(index, /## Email \(1\)\n\n- Inbox sweep: Sorts the inbox/);
  assert.doesNotMatch(index, /Invoice run|Ben only/, "only what Ana has");
  setLabels("ben", []);
  assert.deepEqual(names("ben"), ["Ben only"], "none: only one naming it");
  setLabels("ana", undefined);
  setLabels("ben", undefined);
});

await check("Who has what: a tick by label (the first untick of an every label bot, back to every label), a skill's own bots the exception, owner and window only", async () => {
  const r = await route({ action: "bot-label", ws: "ws_lab", botId: "ana", label: "finance", on: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(bot("ana").skillLabels, ["Email"], "every label but Finance");
  assert.deepEqual((await route({ action: "bot-label", ws: "ws_lab", botId: "ana", label: "Finance", on: true })).body, { skillLabels: null });
  assert.equal(bot("ana").skillLabels, undefined, "every label again, new ones too");
  assert.equal((await route({ action: "bot-label", ws: "ws_lab", botId: "ana", label: "Finance", on: false }, { window: false })).status, 403, "only from the window");
  assert.equal((await route({ action: "bot-label", ws: "ws_lab", botId: "boppy", label: "Finance", on: false })).status, 404, "a bot of another workspace");
  assert.deepEqual((await route({ action: "bot-labels", ws: "ws_lab", botId: "ben", labels: ["EMAIL", "email"] })).body, { skillLabels: ["Email"] });
  assert.deepEqual((await route({ action: "bot-labels", ws: "ws_lab", botId: "ben", labels: null })).body, { skillLabels: null });
  // A skill's own bots: given to one more than its label's bots, it names them; its label's bots exactly, none again.
  setLabels("ana", ["Email"]);
  const one = W.setSkillBot("ws_lab", "skill", "invoice-run", "ana", true);
  assert.deepEqual(one.botIds.sort(), ["ana", "ben"]);
  assert.deepEqual(W.setSkillBot("ws_lab", "skill", "invoice-run", "ana", false).botIds, [], "Ben alone has Finance: as none");
  setLabels("ana", undefined);
  assert.deepEqual(W.workspaceLabels("ws_lab"), ["Email", "Finance"]);
});

await check("A label renamed: every skill in it moves (its SKILL.md too), each bot that had it has the new one, its about line goes with it; the about line is what the prompts say", async () => {
  setLabels("ben", ["Finance"]);
  W.setLabelAbout("ws_lab", "finance", "Money in and out: invoices, refunds.");
  assert.deepEqual(S.getState().workspaces.find((w) => w.id === "ws_lab").skillLabelInfo, [{ name: "Finance", about: "Money in and out: invoices, refunds.", position: 0 }]);
  assert.match(hear(W.skillsNote("ben")), /\nFinance \(2\): Money in and out: invoices, refunds\.\n- (Invoice run|Ben only): /, "said as the label's line, its skills under it");
  assert.match(hear(W.readSkill("ben", "", null, "Finance")), /^Finance \(2\): Money in and out: invoices, refunds\./);
  const r = await route({ action: "label-rename", ws: "ws_lab", from: "Finance", to: "Money" });
  assert.equal(r.body.moved, 2);
  assert.deepEqual(W.refsOf("ws_lab").map((x) => [x.slug, x.label]).sort(), [["ben-only", "Money"], ["inbox-sweep", "Email"], ["invoice-run", "Money"]]);
  assert.match(skillMd("ws_lab", "invoice-run"), /\nmetadata: \{label: Money\}\n/);
  assert.deepEqual(bot("ben").skillLabels, ["Money"]);
  assert.deepEqual(S.getState().workspaces.find((w) => w.id === "ws_lab").skillLabelInfo.map((x) => [x.name, x.about]), [["Money", "Money in and out: invoices, refunds."]]);
  // A new spelling of the same label is that label, spelled anew.
  await route({ action: "label-rename", ws: "ws_lab", from: "money", to: "MONEY" });
  assert.equal(W.findRef("ws_lab", "skill", "invoice-run").label, "MONEY");
  await route({ action: "label-rename", ws: "ws_lab", from: "MONEY", to: "Money" });
  // A secret is never a label or an about line.
  assert.equal((await route({ action: "label-about", ws: "ws_lab", label: "Money", about: `key ${FAKE_STRIPE}` })).status, 400);
  setLabels("ben", undefined);
});

/* ---------------- Orgo: the label column, skill_labels, the label info ---------------- */

await check("The bots map sends skill_labels only to an orgo-web whose bot_fields list it (null: every label)", async () => {
  Sync.bopsSyncForTests.reset();
  setLabels("ana", ["Email"]);
  orgo.maps = [];
  orgo.botFields = undefined;
  Sync.bopsSyncForTests.look();
  await Sync.bopsSyncForTests.flushAll();
  const older = orgo.maps.find((x) => x.pid === "p_lab");
  assert.ok(older, "a map went");
  assert.ok(older.body.bots.every((b) => !("skill_labels" in b)), "an older orgo-web would refuse the whole map");
  Sync.bopsSyncForTests.reset();
  orgo.maps = [];
  orgo.botFields = ["skill_labels"];
  Sync.bopsSyncForTests.look();
  await Sync.bopsSyncForTests.flushAll();
  const bots = orgo.maps.find((x) => x.pid === "p_lab").body.bots;
  assert.deepEqual(bots.map((b) => [b.bopsId, b.skill_labels]), [["ana", ["Email"]], ["ben", null]]);
  setLabels("ana", undefined);
  Sync.bopsSyncForTests.reset();
});

await check("A move reaches Orgo with a PATCH only where orgo-web keeps the label (its skill JSON says label); its column comes here as it is", async () => {
  W.createSkill("ws_sync", { name: "Deal notes", description: "Notes on a deal", body: "# Deal notes\n", label: "Sales", botIds: [] });
  orgo.column = false;
  await W.syncSkills("ws_sync");
  assert.equal(orgo.skills.length, 1);
  await sleep(5);
  W.updateSkill("ws_sync", "skill", "deal-notes", { label: "Pipeline" });
  orgo.calls = [];
  await W.syncSkills("ws_sync");
  const patch1 = orgo.calls.find((c) => c.method === "PATCH");
  assert.ok(patch1 && !("label" in patch1.body), "no label for an orgo-web without the column");
  orgo.column = true;
  await sleep(5);
  W.updateSkill("ws_sync", "skill", "deal-notes", { label: "Leads" });
  orgo.calls = [];
  await W.syncSkills("ws_sync");
  const patch2 = orgo.calls.find((c) => c.method === "PATCH");
  assert.equal(patch2?.body.label, "Leads", "its label in the PATCH, no version needed");
  assert.equal(orgo.skills[0].label, "Leads");
  // Moved on orgo.ai: the column's label comes here, in its folder's SKILL.md too, whatever Orgo's SKILL.md said.
  Object.assign(orgo.skills[0], { label: "Ops", updated_at: new Date(Date.now() + 60_000).toISOString() });
  await W.syncSkills("ws_sync");
  assert.equal(W.findRef("ws_sync", "skill", "deal-notes").label, "Ops");
  assert.match(skillMd("ws_sync", "deal-notes"), /label: Ops/);
  // Null in the column is Unsorted: no label here either, nor in its folder's SKILL.md.
  Object.assign(orgo.skills[0], { label: null, updated_at: new Date(Date.now() + 120_000).toISOString() });
  await W.syncSkills("ws_sync");
  assert.equal(W.findRef("ws_sync", "skill", "deal-notes").label, undefined);
  assert.doesNotMatch(skillMd("ws_sync", "deal-notes"), /label:/);
});

/** As after a restart: nothing in memory says whether Orgo keeps the column. */
const restart = () => {
  globalThis.bopsSkillsLabelColumn?.clear();
  globalThis.bopsSkillsLabelProbed?.clear();
};

await check("A move before this run knows Orgo keeps the column (a restart, a list of only what changed with nothing in it): the PATCH's answer says so and the label goes too; a pull keeps it", async () => {
  orgo.since = true;
  const s = orgo.skills.find((x) => x.slug === "deal-notes");
  W.updateSkill("ws_sync", "skill", "deal-notes", { label: "Sales" });
  await W.syncSkills("ws_sync");
  assert.equal(s.label, "Sales");
  restart();
  W.renameLabel("ws_sync", "Sales", "Inbox");
  orgo.calls = [];
  await W.syncSkills("ws_sync");
  assert.ok(orgo.calls.some((c) => c.method === "GET" && c.search.startsWith("?since=")), "a list of only what changed");
  assert.equal(s.label, "Inbox", "Orgo's column has the move");
  // Changed on Orgo since (orgo.ai, another Mac): the move stays here.
  Object.assign(s, { name: "Deal notes", updated_at: new Date(Date.now() + 600_000).toISOString() });
  await W.syncSkills("ws_sync");
  assert.equal(W.findRef("ws_sync", "skill", "deal-notes").label, "Inbox");
});

await check("A move waiting from an orgo-web without the column, which keeps one since (taken from the version): a pull keeps it, and it goes once the column is known", async () => {
  const s = orgo.skills.find((x) => x.slug === "deal-notes");
  orgo.column = false;
  restart();
  W.updateSkill("ws_sync", "skill", "deal-notes", { label: "Leads" });
  await W.syncSkills("ws_sync");
  assert.equal(s.label, "Inbox", "an older orgo-web: no label in the PATCH");
  // Upgraded, its column the version's (Inbox), changed there meanwhile; then a restart.
  orgo.column = true;
  Object.assign(s, { name: "Deal notes", updated_at: new Date(Date.now() + 900_000).toISOString() });
  restart();
  await W.syncSkills("ws_sync");
  assert.equal(W.findRef("ws_sync", "skill", "deal-notes").label, "Leads", "the pull kept the move");
  assert.equal(s.label, "Leads", "and it went to the column");
  // Nothing waits now: no PATCH again.
  restart();
  orgo.calls = [];
  await W.syncSkills("ws_sync");
  assert.ok(!orgo.calls.some((c) => c.method === "PATCH"));
  orgo.since = false;
});

await check("A skill brought from Orgo is never refused for its frontmatter (metadata.version \"1.0\", risk: high): made fit and kept", async () => {
  orgo.skills.push({ id: "sk_fit", slug: "pdf-forms", name: "PDF forms", description: "Fills PDF forms", type: "skill", status: "draft", bot_ids: [], version: "1.0.0", body: "---\nname: pdf-forms\ndescription: Fills PDF forms\nmetadata: {author: example-org, version: \"1.0\", risk: high, runs-on: local}\n---\n# PDF forms\n\nFill it.\n", label: null, updated_at: now() });
  const res = await W.syncSkills("ws_sync");
  assert.equal(res.failed, 0);
  const md = skillMd("ws_sync", "pdf-forms");
  assert.match(md, /author: example-org/);
  assert.match(md, /runs-on: local/);
  assert.doesNotMatch(md, /risk: high|version: "?1\.0"?[,}]/);
  orgo.skills = orgo.skills.filter((x) => x.id !== "sk_fit");
  await W.syncSkills("ws_sync");
  assert.equal(W.findRef("ws_sync", "skill", "pdf-forms"), undefined);
});

await check("Label info: orgo-web's skill_labels cached in the workspace; one changed here goes with a PUT; without the route it stays on this Mac", async () => {
  orgo.labels = [{ name: "Ops", about: "Keeping things running.", position: 0 }];
  await W.syncSkills("ws_sync");
  assert.deepEqual(S.getState().workspaces.find((w) => w.id === "ws_sync").skillLabelInfo, [{ name: "Ops", about: "Keeping things running.", position: 0 }]);
  W.setLabelAbout("ws_sync", "Sales", "Deals and calls.");
  orgo.calls = [];
  await W.syncSkills("ws_sync");
  const put = orgo.calls.find((c) => c.method === "PUT" && c.path === "/api/projects/p_sync/skill-labels");
  assert.deepEqual(put?.body.labels.map((x) => x.name), ["Ops", "Sales"]);
  assert.equal(S.getState().workspaces.find((w) => w.id === "ws_sync").skillLabelInfoUnsent, undefined);
  // No route (an older orgo-web): kept here, and the prompts still use it.
  orgo.labelsRoute = false;
  W.setLabelAbout("ws_lab", "Email", "The inbox.");
  await W.syncSkills("ws_lab");
  assert.equal(S.getState().workspaces.find((w) => w.id === "ws_lab").skillLabelInfo.find((x) => x.name === "Email").about, "The inbox.");
  assert.match(W.skillsNote("ana"), /\nEmail \(1\): The inbox\./);
  orgo.labelsRoute = true;
});

/* ---------------- Proposals ---------------- */

const chatId = botChatId("boppy");
const lastBot = () => [...S.getState().messages].reverse().find((m) => m.chatId === chatId && m.role === "bot");
W.createSkill("ws_main", { name: "Morning sweep", description: "Sorts the inbox each morning", body: "# Morning sweep\n\n1. Open the inbox.\n2. Sort by date.\n", label: "Email", status: "published" });
const proposeArgs = (o = {}) => ({ skill: "Morning sweep", file: "SKILL.md", edits: [{ old: "2. Sort by date.", new: "2. Sort by sender." }], content: null, summary: "The sort was wrong: sort by sender.", ...o });

await check("propose_skill_change on the owner's turn: offered, a card on the reply with the change, who and where; nothing changed yet", async () => {
  answers.push(() => response([toolCall("propose_skill_change", proposeArgs())]), () => response([said("I proposed a fix to Morning sweep.")]));
  const at = asked.length;
  await Chat.handleMessage(chatId, "Sort the sweep by sender from now on");
  assert.ok(toolNames(asked[at]).includes("propose_skill_change"));
  assert.match(asked[at].instructions, /propose the change with propose_skill_change: nothing changes until Alex accepts it\./);
  const out = asked[at + 1].input.find((x) => x.type === "function_call_output").output;
  assert.match(hear(out), /^Proposed\./);
  const p = lastBot().skillProposals[0];
  assert.deepEqual([p.ws, p.slug, p.file, p.base, p.botId, p.chatId, !!p.baseSha, p.read, p.status], ["ws_main", "morning-sweep", "SKILL.md", "0.1.0", "boppy", chatId, true, undefined, undefined]);
  assert.deepEqual(PL.proposalLines(p), [{ t: "-", s: "2. Sort by date." }, { t: "+", s: "2. Sort by sender." }]);
  assert.doesNotMatch(versionMd("ws_main", "morning-sweep", "0.1.0"), /sender/);
});

await check("Accept: only from the window, never on a runner; the next version through the normal path; once", async () => {
  const m = lastBot();
  const p = m.skillProposals[0];
  assert.equal((await route({ action: "proposal", do: "accept", messageId: m.id, proposalId: p.id }, { window: false })).status, 403);
  process.env.BOPS_RUNNER = "1";
  try {
    assert.deepEqual(P.acceptProposal(m.id, p.id), { ok: false, status: 409, error: "Accept it in Bops on your Mac." });
  } finally {
    delete process.env.BOPS_RUNNER;
  }
  const r = await route({ action: "proposal", do: "accept", messageId: m.id, proposalId: p.id });
  assert.deepEqual(r, { status: 200, body: { ok: true, version: "0.1.1" } });
  assert.match(versionMd("ws_main", "morning-sweep", "0.1.1"), /2\. Sort by sender\./);
  assert.equal(W.findRef("ws_main", "skill", "morning-sweep").version, "0.1.1");
  assert.equal(lastBot().skillProposals[0].status, "accepted");
  assert.equal((await route({ action: "proposal", do: "accept", messageId: m.id, proposalId: p.id })).body.error, "It was accepted already.");
  assert.equal((await route({ action: "proposal", do: "reject", messageId: m.id, proposalId: p.id })).status, 409);
});

await check("A secret in a proposal is refused, never kept; an edit that isn't in the file once is refused; Bops' own skills and unknown ones too", async () => {
  const b = bot("boppy");
  const from = { chatId, read: () => [] };
  assert.match(hear(P.offerProposal(b, proposeArgs({ edits: [{ old: "2. Sort by sender.", new: `2. Use ${FAKE_STRIPE}.` }] }), from, []).said), /^Not proposed: it holds what looks like a secret \(edit 1 line 1: Stripe secret key\)\./);
  assert.match(P.offerProposal(b, proposeArgs({ content: `key ${FAKE_STRIPE}`, edits: null, file: "notes.md" }), from, []).said, /^Not proposed: it holds what looks like a secret/);
  assert.equal(P.offerProposal(b, proposeArgs({ summary: `see ${FAKE_STRIPE}` }), from, []).proposal, undefined);
  assert.match(P.offerProposal(b, proposeArgs({ edits: [{ old: "not there", new: "x" }] }), from, []).said, /its old text isn't in the file/);
  assert.match(P.offerProposal(b, proposeArgs({ edits: [{ old: ".", new: "!" }] }), from, []).said, /^Not proposed: The edit: its old text is in the file more than once\./);
  assert.match(P.offerProposal(b, proposeArgs({ skill: "Nope" }), from, []).said, /you have no skill called "Nope"/);
  assert.match(P.offerProposal(b, proposeArgs({ file: "../x" }), from, []).said, /that file can't be/);
  const ok = P.offerProposal(b, proposeArgs({ edits: null, content: "# Faults\n\nWhen the inbox is empty, say so.\n", file: "references/faults.md" }), from, []);
  assert.equal(ok.proposal.replaces, undefined, "a new file");
});

await check("Every turn kind has it: a routine's run (its card on the run's message), someone else's turn, and a turn that read the web (create_skill still refused there)", async () => {
  // A routine's run, in the background.
  answers.push(() => response([toolCall("propose_skill_change", proposeArgs({ edits: [{ old: "1. Open the inbox.", new: "1. Open the inbox and the spam folder." }] }))]), () => response([said("NOTHING")]));
  let at = asked.length;
  const out = await Chat.backgroundTurn("boppy", { routineId: "rtn_sweep", title: "Morning sweep", goal: "Sweep the inbox.", quiet: true });
  assert.ok(toolNames(asked[at]).includes("propose_skill_change"));
  assert.ok(!toolNames(asked[at]).includes("create_skill"));
  assert.equal(out.skillProposals.length, 1);
  assert.equal(out.skillProposals[0].routineId, "rtn_sweep");
  assert.equal(out.text, PL.proposedWords(1), "a quiet run's proposal is still something to post");
  await Routines.chatRunResumed("rtn_sweep", out);
  const posted = lastBot();
  assert.deepEqual([posted.routine?.id, posted.skillProposals?.[0].routineId], ["rtn_sweep", "rtn_sweep"]);
  // Someone else's turn (a text to the bot's number): offered, and the card says who it came from.
  const m = S.addMessage({ chatId, role: "user", text: "Your sweep should sort by subject", sms: { dir: "in", from: "+15550009999", to: "+15550001111" } });
  answers.push(() => response([toolCall("propose_skill_change", proposeArgs({ edits: [{ old: "2. Sort by sender.", new: "2. Sort by subject." }] }))]), () => response([said("I passed it on.")]));
  at = asked.length;
  await Chat.outsideNews("boppy", m.id, "a text");
  assert.ok(toolNames(asked[at]).includes("propose_skill_change"));
  assert.ok(!toolNames(asked[at]).includes("create_skill"), "someone else's turn still can't save one");
  assert.deepEqual(lastBot().skillProposals[0].read, ["This turn came from a text from +15550009999"]);
  // The owner's turn that searched the web: create_skill refused, the proposal kept with whose words it read.
  answers.push(
    () => response([{ id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "inbox tips", sources: [] } }, toolCall("create_skill", { name: "Spam check", description: "x", steps: "1. Look.", pitfalls: null, label: null }), toolCall("propose_skill_change", proposeArgs({ edits: [{ old: "2. Sort by sender.", new: "2. Sort by sender, newest first." }] }))]),
    () => response([said("Done.")]),
  );
  at = asked.length;
  await Chat.handleMessage(chatId, "Save a spam check skill and fix the sweep");
  const outs = asked[at + 1].input.filter((x) => x.type === "function_call_output").map((x) => x.output);
  assert.match(outs[0], /^Not saved: this turn read something from outside Bops/);
  assert.match(outs[1], /^Proposed\./);
  assert.deepEqual(lastBot().skillProposals[0].read, ["Web search results"]);
});

await check("A stale base: Accept shows the change on what the skill is now and applies only once that was seen; one that no longer fits says so; Reject drops one", async () => {
  // The web turn's proposal was made at 0.1.1; publish another change first.
  const m = lastBot();
  const p = m.skillProposals[0];
  W.updateSkill("ws_main", "skill", "morning-sweep", { body: "# Morning sweep\n\n0. Wake up.\n1. Open the inbox.\n2. Sort by sender.\n" });
  W.publishSkill("ws_main", "skill", "morning-sweep");
  const first = await route({ action: "proposal", do: "accept", messageId: m.id, proposalId: p.id });
  assert.equal(first.status, 409);
  assert.match(first.body.stale.why, /^It's at version 0\.1\.2 now, and this was proposed for 0\.1\.1\./);
  assert.deepEqual(first.body.stale.lines.filter((l) => l.t !== " "), [{ t: "-", s: "2. Sort by sender." }, { t: "+", s: "2. Sort by sender, newest first." }]);
  assert.equal((await route({ action: "proposal", do: "accept", messageId: m.id, proposalId: p.id, seen: "x" })).status, 409, "not the view it showed");
  const ok = await route({ action: "proposal", do: "accept", messageId: m.id, proposalId: p.id, seen: first.body.stale.seen });
  assert.deepEqual(ok.body, { ok: true, version: "0.1.3" });
  assert.match(versionMd("ws_main", "morning-sweep", "0.1.3"), /0\. Wake up\.\n1\. Open the inbox\.\n2\. Sort by sender, newest first\./);
  // The text one's (sort by subject) no longer fits: said, nothing to apply.
  const text = [...S.getState().messages].reverse().find((x) => x.skillProposals?.some((y) => y.read?.[0]?.startsWith("This turn came from")));
  const tp = text.skillProposals[0];
  const stale = await route({ action: "proposal", do: "accept", messageId: text.id, proposalId: tp.id });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.stale.lines, undefined);
  assert.match(stale.body.stale.why, /its old text isn't in the file/);
  assert.deepEqual((await route({ action: "proposal", do: "reject", messageId: text.id, proposalId: tp.id })).body, { ok: true });
  assert.equal([...S.getState().messages].find((x) => x.id === text.id).skillProposals[0].status, "rejected");
  // Changes in the folder not published yet are said too (they'd be published with it).
  const run = [...S.getState().messages].reverse().find((x) => x.routine?.id === "rtn_sweep" && x.skillProposals);
  W.updateSkill("ws_main", "skill", "morning-sweep", { body: "# Morning sweep\n\n0. Wake up.\n1. Open the inbox.\n2. Sort by sender, newest first.\n3. Draft.\n" });
  const draft = await route({ action: "proposal", do: "accept", messageId: run.id, proposalId: run.skillProposals[0].id });
  assert.match(draft.body.stale.why, /It's at version 0\.1\.3 now|changes not published yet/);
});

await check("On a computer's runner: a proposal for a skill whose files aren't there is kept unchecked, its message is one the runner may write, and it's checked when accepted", async () => {
  S.update((s) => s.workspaces[0].skills.push({ slug: "cloud-only", kind: "skill", name: "Cloud only", description: "Made elsewhere", label: "Email", status: "published", version: "0.2.0", versions: [{ version: "0.2.0", at: 1, sha256: "0".repeat(64) }], botIds: [], source: "orgo", createdAt: 1, updatedAt: 1 }));
  process.env.BOPS_RUNNER = "1";
  let got;
  try {
    got = P.offerProposal(bot("boppy"), proposeArgs({ skill: "Cloud only", edits: [{ old: "a", new: "b" }] }), { chatId, read: () => [] }, []);
  } finally {
    delete process.env.BOPS_RUNNER;
  }
  assert.equal(got.proposal.unchecked, true);
  assert.equal(got.proposal.baseSha, undefined);
  const m = { id: "msg_runner", chatId, role: "bot", botId: "boppy", text: "Proposed.", at: Date.now(), skillProposals: [got.proposal] };
  assert.equal(CS.computersMessage(m, new Set(["boppy"]), new Set([chatId])), true);
  assert.equal(CS.computersMessage({ ...m, botId: "max" }, new Set(["boppy"]), new Set([chatId])), false, "never another bot's");
  S.update((s) => s.messages.push(m));
  assert.equal((await route({ action: "proposal", do: "accept", messageId: m.id, proposalId: got.proposal.id })).body.error, "Its folder is gone from this Mac.");
  S.update((s) => (s.workspaces[0].skills = s.workspaces[0].skills.filter((x) => x.slug !== "cloud-only")));
});

await check("Accept takes a proposal only as its message's own, and one without this Mac's mark only after the view on what the skill is now", async () => {
  const made = P.offerProposal(bot("boppy"), proposeArgs({ edits: [{ old: "1. Open the inbox.", new: "1. Open the inbox first." }] }), { chatId, read: () => [] }, []);
  assert.ok(made.proposal, made.said);
  const [sealed] = P.sealProposals([made.proposal]);
  assert.equal(typeof sealed.seal, "string");
  const msg = (id, botId, p) => ({ id, chatId, role: "bot", botId, text: "Proposed.", at: Date.now(), skillProposals: [p] });
  S.update((s) =>
    s.messages.push(
      msg("msg_p_other", "ana", { ...sealed, id: "prop_other" }),
      msg("msg_p_ws", "boppy", { ...sealed, id: "prop_ws", ws: "ws_lab" }),
      msg("msg_p_forged", "boppy", { ...sealed, id: "prop_forged", read: undefined }),
      msg("msg_p_sealed", "boppy", sealed),
    ),
  );
  const accept = (messageId, proposalId) => route({ action: "proposal", do: "accept", messageId, proposalId });
  assert.deepEqual([(await accept("msg_p_other", "prop_other")).status, (await accept("msg_p_ws", "prop_ws")).status], [403, 403], "another bot's message, another workspace's skill");
  // Its mark copied onto another, or a field changed since: not this Mac's own, so the view first.
  const forged = await accept("msg_p_forged", "prop_forged");
  assert.equal(forged.status, 409);
  assert.equal(forged.body.stale.why, "It wasn't made on this Mac, so here's the change on what it is now.");
  assert.notEqual(P.proposalDiff("msg_p_sealed", sealed.id).why, forged.body.stale.why, "this Mac's own is shown as it is");
  setLabels("boppy", []);
  assert.equal((await accept("msg_p_sealed", sealed.id)).body.error, "Its bot doesn't have that skill anymore.");
  setLabels("boppy", undefined);
  S.update((s) => (s.messages = s.messages.filter((m) => !m.id.startsWith("msg_p_"))));
});

await check("lineDiff: only what changed, with a little around it", async () => {
  const a = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  const b = a.replace("line 6", "line six");
  assert.deepEqual(PL.lineDiff(a, b), [{ t: " ", s: "…" }, { t: " ", s: "line 4" }, { t: " ", s: "line 5" }, { t: "-", s: "line 6" }, { t: "+", s: "line six" }, { t: " ", s: "line 7" }, { t: " ", s: "line 8" }, { t: " ", s: "…" }]);
  assert.deepEqual(PL.applyEdits("a b a", [{ old: "a", new: "c" }]), { error: "The edit: its old text is in the file more than once. Give more of the text around it." });
  assert.deepEqual(PL.applyEdits("a b", [{ old: "a", new: "c" }, { old: "c b", new: "d" }]), { text: "d" }, "in order");
});

/* ---------------- Update from folder ---------------- */

await check("Update from folder: the folder is the skill's next version (its label, bots and history kept), published when asked; another skill's folder refused", async () => {
  W.setSkillBot("ws_main", "skill", "morning-sweep", "boppy", true);
  const before = W.findRef("ws_main", "skill", "morning-sweep");
  const f = folder("morning-sweep", "---\nname: morning-sweep\ndescription: Sorts the inbox each morning, spam too\nlicense: MIT\nmetadata:\n  label: Elsewhere\n---\n# Morning sweep\n\n1. Open the inbox and spam.\n", { "references/faults.md": "Empty inbox: say so.\n", ".env": "X=1\n" });
  const r = await route({ action: "import", ws: "ws_main", slug: "morning-sweep", path: f });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.published, false);
  assert.deepEqual(r.body.skipped, [{ path: ".env", reason: "credentials file: never kept" }]);
  const after = W.findRef("ws_main", "skill", "morning-sweep");
  assert.deepEqual([after.label, after.botIds, after.version, after.versions.length, after.name], [before.label, before.botIds, before.version, before.versions.length, before.name]);
  const md = skillMd("ws_main", "morning-sweep");
  assert.match(md, /\nlicense: MIT\n/);
  assert.match(md, /label: Email/, "its own label, not the folder's");
  assert.match(md, /1\. Open the inbox and spam\./);
  assert.match(W.readSkill("boppy", "Morning sweep"), /Sort by sender, newest first/, "its bots read the published one until it's published");
  const pub = await route({ action: "import", ws: "ws_main", slug: "morning-sweep", path: folder("morning-sweep", "---\nname: morning-sweep\ndescription: Sorts the inbox each morning, spam too\n---\n# Morning sweep\n\n1. Open the inbox and spam, then sort.\n"), publish: true });
  assert.equal(pub.body.published, true);
  assert.equal(pub.body.ref.version, "0.1.4");
  assert.equal(pub.body.ref.description, "Sorts the inbox each morning, spam too");
  const other = await route({ action: "import", ws: "ws_main", slug: "morning-sweep", path: folder("evening-sweep", "---\nname: evening-sweep\ndescription: x\n---\n# Evening\n") });
  assert.equal(other.status, 400);
  assert.equal((await route({ action: "import", ws: "ws_main", slug: "nope", path: f })).status, 404);
});

/* ---------------- Plain words ---------------- */

await check("Plain words: nothing a person or a bot reads has a dash, says Orbit, or holds the made up secret", async () => {
  const all = heard.join("\n");
  assert.doesNotMatch(all, /[‒–—―]| - /);
  assert.doesNotMatch(all, /Orbit/);
  assert.ok(!all.includes(FAKE_STRIPE), "the key is never said back");
  for (const t of [P.PROPOSE_TOOL.description, ...Object.values(P.PROPOSE_TOOL.parameters.properties).map((x) => x.description)]) assert.doesNotMatch(t, /[‒–—―]| - /);
});

console.log(`\nskills v2: ${passed} passed, ${failed} failed`);
if (failed) console.log(`The throwaway folder is kept for a look: ${scratch}`);
else rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
