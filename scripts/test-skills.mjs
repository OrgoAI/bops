// Tests for a workspace's skills and apps (lib/server/workspace-skills.ts, lib/server/skill-bundle.ts,
// app/api/skills): folders in the Agent Skill shape at <userDir>/workspaces/<id>/skills|apps/<slug>/, made
// strictly (no secret, no junk, the caps; a finding names the path, the line and the kind, never the text),
// drafts its bots don't see until published, versions published and rolled back, which bots have one,
// scripts approved by their content's sha256, read_skill (the body, or one file), a folder imported the way
// orgo-web's importer takes one (junk, links out of the folder and files holding a secret left out and
// listed; no SKILL.md and a README is drafted from), the folders on a computer several workspaces' bots share,
// a workspace's folder moving to its Orgo project's id, and keeping in step with orgo-web's skills routes
// (none on today's orgo-web: local only, nothing sent; with them: pushed, pulled, the later change winning,
// a delete sent). orgo-web is a fake (a local server), the Keychain is never there, and the state and
// folders live in a throwaway folder: nothing reaches a real service. The keys in it are made up.
// Usage: node --conditions=react-server scripts/test-skills.mjs
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
const UI = "ui-token-test-skills";
process.env.BOPS_UI_TOKEN = UI;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-skills-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const ORGO_KEY = "sk_orgo_test_skills";
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
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(String(e?.stack ?? e)));

/** Made up, in the shapes the scanner knows. Nothing here is a real key. */
const FAKE_PRIVATE_KEY = ["-----BEGIN OPENSSH", "PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----"].join(" ");
const FAKE_STRIPE = ["sk", "live", "0123456789abcdefABCDEF01"].join("_");

/* ---------------- A fake orgo-web's skills routes (or none, as today) ---------------- */

const remote = { routes: false, skills: [], calls: [], seq: 0 };
const send = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  const url = new URL(req.url, "http://fake");
  const body = text ? JSON.parse(text) : undefined;
  remote.calls.push({ method: req.method, path: url.pathname, body });
  if (req.headers.authorization !== `Bearer ${ORGO_KEY}`) return send(res, 401, { error: "Not authenticated" });
  const m = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/skills(?:\/([^/]+))?(?:\/(versions|export))?$/);
  if (!m || !remote.routes) {
    res.writeHead(404, { "content-type": "text/html" });
    return res.end("<!doctype html><title>404</title>");
  }
  const [, pid, sid, sub] = m;
  const view = (s) => ({ id: s.id, workspace_id: pid, slug: s.slug, name: s.name, description: s.description, type: s.type, status: s.status, bot_ids: s.bot_ids, source: s.source, updated_at: s.updated_at, current_version: s.version ? { version: s.version } : null });
  const now = () => new Date(Date.now() + ++remote.seq).toISOString();
  if (!sid && req.method === "GET") return send(res, 200, { skills: remote.skills.filter((s) => s.pid === pid).map(view) });
  if (!sid && req.method === "POST") {
    const s = { id: `sk_${++remote.seq}`, pid, slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: body.name, description: body.description, type: body.type, status: body.status, bot_ids: body.bot_ids, source: body.source, version: body.version ?? "0.1.0", body: body.body, files: body.files, updated_at: now() };
    remote.skills.push(s);
    return send(res, 201, { skill: view(s), version: { version: s.version }, warnings: [] });
  }
  const s = remote.skills.find((x) => x.id === sid && x.pid === pid);
  if (!s) return send(res, 404, { error: "Not found", code: "skill_not_found" });
  if (sub === "export") return send(res, 200, { slug: s.slug, name: s.name, description: s.description, type: s.type, version: s.version, files: { "SKILL.md": { content: s.body }, ...Object.fromEntries((s.files ?? []).map((f) => [f.path, { content: f.content, executable: !!f.executable }])) } });
  if (sub === "versions" && req.method === "POST") {
    Object.assign(s, { body: body.body ?? s.body, files: body.files ?? s.files, version: body.version, updated_at: now() });
    return send(res, 201, { skill: view(s), version: { version: s.version } });
  }
  if (req.method === "PATCH") {
    Object.assign(s, { ...(body.name ? { name: body.name } : {}), ...(body.description ? { description: body.description } : {}), ...(body.bot_ids ? { bot_ids: body.bot_ids } : {}), ...(body.status ? { status: body.status } : {}), updated_at: now() });
    return send(res, 200, { skill: view(s) });
  }
  if (req.method === "DELETE") {
    remote.skills = remote.skills.filter((x) => x !== s);
    return send(res, 200, { deleted: true, id: s.id });
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
/** Everything a person or a bot could read, checked for dashes and for the made up secrets at the end. */
const said = [];
const hear = (...xs) => (said.push(...xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))), xs[0]);

const S = await import(`${root}/lib/server/store.ts`);
const W = await import(`${root}/lib/server/workspace-skills.ts`);
const B = await import(`${root}/lib/server/skill-bundle.ts`);
const Route = await import(`${root}/app/api/skills/route.ts`);
const route = async (body, method = "POST") => {
  const res = await Route[method](new Request(`http://localhost:3210/api/skills${method === "GET" ? body ?? "" : ""}`, { method, headers: { "content-type": "application/json", "x-bops-window": UI }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }));
  return { status: res.status, body: hear(await res.json()) };
};

S.update((s) => {
  s.owner = { name: "Tiger" };
  s.workspaces = [
    { id: "ws_main", name: "bops", createdAt: 0 },
    { id: "ws_two", name: "Two", createdAt: 1 },
  ];
  s.bots = [
    { id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "ready", computerId: "c_free", freeComputer: true },
    { id: "max", name: "Max", role: "Sales", color: "#5B8CFF", isMain: false, computerStatus: "none", computer: "shared" },
    // Two's main bot works on the free computer Boppy has (shareFree).
    { id: "tess", name: "Tess", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", computer: "shared", workspaceId: "ws_two" },
  ];
});
const dataDir = () => join(process.cwd(), ".data", "workspaces");

/* ---------------- SKILL.md ---------------- */

await check("SKILL.md: frontmatter read (lists, a nested map, block text, quotes) and written back the same", async () => {
  const md = '---\nname: vm-health\ndescription: |\n  Checks a VM.\n  Use when "is it up".\nversion: "1.2.0"\nrisk: read\nrequires_secrets: [DATABASE_URL, "STRIPE_SECRET_KEY"]\nrequires_tools:\n  - ssh\n  - jq\napplies_to:\n  vmm: ">=0.3.0 <0.4"\n  env: [staging, prod]\n# a comment\nexpires_when: on build 10296c8 or later\n---\n# VM health\n';
  const p = B.parseSkillMd(md);
  assert.ok(p.ok);
  assert.deepEqual(p.frontmatter, {
    name: "vm-health",
    description: 'Checks a VM.\nUse when "is it up".',
    version: "1.2.0",
    risk: "read",
    requires_secrets: ["DATABASE_URL", "STRIPE_SECRET_KEY"],
    requires_tools: ["ssh", "jq"],
    applies_to: { vmm: ">=0.3.0 <0.4", env: ["staging", "prod"] },
    expires_when: "on build 10296c8 or later",
  });
  assert.equal(p.body, "# VM health\n");
  const again = B.parseSkillMd(B.renderSkillMd(p.frontmatter, p.body));
  assert.deepEqual(again.frontmatter, p.frontmatter, "rendered and read back, the same");
  assert.match(B.renderSkillMd(p.frontmatter, p.body), /^---\nname: vm-health\ndescription: "Checks a VM\.\\nUse when \\"is it up\\"\."\nversion: "1\.2\.0"\n/, "name, description, version first; the version quoted");
  assert.deepEqual(B.parseSkillMd("no frontmatter here"), { ok: true, frontmatter: null, body: "no frontmatter here" });
  assert.deepEqual(B.parseSkillMd("---\n: what\n---\n"), { ok: false, reason: "frontmatter is not YAML Bops can read" });
});

await check("The secret scanner: each kind by path, line and kind, never the text; placeholders and vault names pass", async () => {
  const text = [`key=${FAKE_STRIPE}`, "url=postgres://app:$PGPASSWORD@db/x", "url2=postgres://app:hunter2hunter2@db/x", FAKE_PRIVATE_KEY, "API_KEY=changeme", "export GITHUB_TOKEN=$GITHUB_TOKEN"].join("\n");
  assert.deepEqual(B.scanSecrets("scripts/x.sh", text), [
    { path: "scripts/x.sh", line: 1, reason: "secret: Stripe secret key" },
    { path: "scripts/x.sh", line: 3, reason: "secret: connection string with a password" },
    { path: "scripts/x.sh", line: 4, reason: "secret: private key block" },
  ]);
  assert.deepEqual(B.junkReason("heal/SKILL.md.bak-2"), "junk: backup file");
  assert.deepEqual(B.junkReason("a/__pycache__/x.pyc"), "junk: __pycache__");
  assert.deepEqual(B.junkReason("runs/sweep.log"), "junk: log file");
  assert.equal(B.junkReason("scripts/check.sh"), null);
  assert.deepEqual(B.normalizePath("../etc/passwd"), { reason: "path leaves the folder (..)" });
  assert.deepEqual(B.normalizePath("/etc/passwd"), { reason: "path is absolute" });
  assert.deepEqual(B.normalizePath("./scripts/a.sh"), { path: "scripts/a.sh" });
});

/* ---------------- Making, publishing, rolling back ---------------- */

let report;
await check("A new skill is a folder and a draft: its bots don't see it until it's published", async () => {
  const made = W.createSkill("ws_main", { name: "Weekly report", description: "Sums up the week when asked for \"the weekly report\"", body: "# Weekly report\n\n1. Read the chat.\n", files: [{ path: "scripts/sum.sh", content: "#!/bin/sh\necho 1\n", executable: true }] });
  report = made.ref;
  assert.deepEqual([report.slug, report.status, report.version, report.botIds, report.source], ["weekly-report", "draft", undefined, [], "bops"]);
  const dir = join(dataDir(), "ws_main", "skills", "weekly-report");
  assert.equal(readFileSync(join(dir, "SKILL.md"), "utf8"), '---\nname: weekly-report\ndescription: "Sums up the week when asked for \\"the weekly report\\""\n---\n\n# Weekly report\n\n1. Read the chat.\n');
  assert.notEqual(statSync(join(dir, "scripts", "sum.sh")).mode & 0o111, 0, "its script executable in its folder");
  assert.deepEqual(W.skillsFor("boppy"), [], "a draft isn't any bot's yet");
  assert.equal(W.readSkill("boppy", "Weekly report"), 'No skill called "Weekly report". You have none yet.');
  // The same name again: its own slug.
  const twin = W.createSkill("ws_main", { name: "Weekly report", description: "Another", body: "# Two\n" }).ref;
  assert.equal(twin.slug, "weekly-report-2");
  await W.deleteSkill("ws_main", "skill", twin.slug);
  // Published: every bot of its workspace has it (none named), at 0.1.0; not another workspace's bots.
  const pub = W.publishSkill("ws_main", "skill", report.slug);
  assert.deepEqual([pub.status, pub.version, pub.versions.length], ["published", "0.1.0", 1]);
  assert.deepEqual(W.skillsFor("max").map((r) => r.slug), ["weekly-report"]);
  assert.deepEqual(W.skillsFor("tess"), [], "Two's bots can't see bops' skills");
  assert.throws(() => W.publishSkill("ws_main", "skill", report.slug), /Nothing changed since 0\.1\.0\./);
});

await check("Refused whole: a secret (by where and what kind, never the text), junk, a path out of the folder, a file too big", async () => {
  const refused = (input) => {
    try {
      W.createSkill("ws_main", { name: "Bad", description: "Bad", body: "# Bad\n", ...input });
    } catch (e) {
      hear(e.message, e.problems);
      return { message: e.message, status: e.status, problems: e.problems };
    }
    assert.fail("not refused");
  };
  const secret = refused({ files: [{ path: "scripts/pay.sh", content: `curl -u ${FAKE_STRIPE}: https://api.stripe.com/v1/charges` }] });
  assert.deepEqual(secret, { message: "That has a secret in it. Use the key's vault name instead ($NAME, listed in requires_secrets).", status: 422, problems: [{ path: "scripts/pay.sh", line: 1, reason: "secret: Stripe secret key" }] });
  assert.deepEqual(refused({ files: [{ path: "notes.log", content: "x" }] }).problems, [{ path: "notes.log", reason: "junk: log file" }]);
  assert.deepEqual(refused({ files: [{ path: "../x.sh", content: "x" }] }).problems, [{ path: "../x.sh", reason: "path leaves the folder (..)" }]);
  assert.deepEqual(refused({ files: [{ path: "big.txt", content: "x".repeat(256 * 1024 + 1) }] }).problems, [{ path: "big.txt", reason: "file is over 256 KB" }]);
  assert.deepEqual(refused({ body: `# Bad\n${FAKE_PRIVATE_KEY}\n` }).problems, [{ path: "SKILL.md", line: 2, reason: "secret: private key block" }]);
  assert.throws(() => W.createSkill("ws_main", { name: "x", description: "", body: "y" }), /Say what it does and when to use it\./);
  assert.equal(W.refsOf("ws_main").some((r) => r.name === "Bad"), false, "nothing kept");
  assert.equal(existsSync(join(dataDir(), "ws_main", "skills", "bad")), false, "no folder either");
});

await check("A change in its folder is a draft of the next version: published as 0.1.1; rolled back, its bots read 0.1.0", async () => {
  W.updateSkill("ws_main", "skill", report.slug, { body: "# Weekly report\n\n1. Read the chat.\n2. Sum it up in a table.\n" });
  const d = W.skillDetail("ws_main", "skill", report.slug);
  assert.equal(d.changed, true);
  assert.doesNotMatch(W.readSkill("max", report.slug), /in a table/, "its bots still read 0.1.0");
  assert.equal(W.publishSkill("ws_main", "skill", report.slug).version, "0.1.1");
  assert.match(W.readSkill("max", report.slug), /^Skill: Weekly report \(version 0\.1\.1\)[\s\S]*Sum it up in a table/);
  const back = W.rollbackSkill("ws_main", "skill", report.slug, "0.1.0");
  assert.equal(back.version, "0.1.0");
  assert.doesNotMatch(W.readSkill("max", report.slug), /in a table/);
  assert.doesNotMatch(readFileSync(join(dataDir(), "ws_main", "skills", report.slug, "SKILL.md"), "utf8"), /in a table/, "the folder went back too");
  assert.throws(() => W.rollbackSkill("ws_main", "skill", report.slug, "9.9.9"), /It has no version 9\.9\.9\./);
  assert.equal(W.rollbackSkill("ws_main", "skill", report.slug, "0.1.1").version, "0.1.1", "and forward again");
});

await check("Which bots have it: every bot until one is taken away; the last one can't be", async () => {
  const off = W.setSkillBot("ws_main", "skill", report.slug, "max", false);
  assert.deepEqual(off.botIds, ["boppy"]);
  assert.deepEqual(W.skillsFor("max"), []);
  assert.throws(() => W.setSkillBot("ws_main", "skill", report.slug, "boppy", false), /At least one bot keeps it\. Delete it instead\./);
  assert.throws(() => W.setSkillBot("ws_main", "skill", report.slug, "tess", true), /That bot isn't in this workspace\./);
  assert.deepEqual(W.setSkillBot("ws_main", "skill", report.slug, "max", true).botIds, [], "every bot named is every bot again");
});

await check("Scripts run once approved by content: shown as needing it, approved, kept through an unchanged version, cleared by a change", async () => {
  const file = W.skillDetail("ws_main", "skill", report.slug).files[0];
  assert.deepEqual([file.path, file.script, file.approved], ["scripts/sum.sh", true, false]);
  assert.match(W.readSkill("max", report.slug), /- scripts\/sum\.sh \(script, not approved yet: ask to have it approved in Skills, in Knowledge, before running it\)/);
  assert.throws(() => W.approveScript("ws_main", "f".repeat(64)), /No script in this workspace has that content\./);
  assert.throws(() => W.approveScript("ws_main", "not-a-sha"), /That isn't a script's sha256\./);
  const shown = await route({ action: "file", kind: "skill", slug: report.slug, path: "scripts/sum.sh" });
  assert.deepEqual(shown.body, { path: "scripts/sum.sh", content: "#!/bin/sh\necho 1\n", sha256: file.sha256 }, "Approve shows the script");
  const ok = await route({ action: "approve", sha256: file.sha256 });
  assert.equal(ok.status, 200);
  assert.equal(W.skillDetail("ws_main", "skill", report.slug).files[0].approved, true);
  assert.match(W.readSkill("max", report.slug), /- scripts\/sum\.sh \(script, approved\)/);
  // A new version with the script as it was: still approved. Changed: not.
  W.updateSkill("ws_main", "skill", report.slug, { body: "# Weekly report\n\nNew words.\n" });
  W.publishSkill("ws_main", "skill", report.slug);
  assert.equal(W.skillDetail("ws_main", "skill", report.slug).files[0].approved, true);
  W.updateSkill("ws_main", "skill", report.slug, { files: [{ path: "scripts/sum.sh", content: "#!/bin/sh\necho 2\n", executable: true }] });
  assert.equal(W.skillDetail("ws_main", "skill", report.slug).files[0].approved, false);
  // One file of it, for a bot; never one out of it.
  W.publishSkill("ws_main", "skill", report.slug);
  assert.match(W.readSkill("max", report.slug, "scripts/sum.sh"), /a script not approved yet/, "a script nobody approved: never its content");
  W.approveScript("ws_main", W.skillDetail("ws_main", "skill", report.slug).files[0].sha256);
  assert.equal(W.readSkill("max", report.slug, "scripts/sum.sh"), "Weekly report, scripts/sum.sh:\n#!/bin/sh\necho 2\n");
  assert.match(W.readSkill("max", report.slug, "../../../state.json"), /has no file/);
});

/* ---------------- Importing a folder ---------------- */

await check("Import a folder: junk, links out of it and a file holding a secret are left out and listed (never the text); the rest is a draft", async () => {
  const f = join(scratch, "vm-health");
  mkdirSync(join(f, "scripts"), { recursive: true });
  mkdirSync(join(f, "__pycache__"));
  mkdirSync(join(f, "node_modules", "x"), { recursive: true });
  mkdirSync(join(f, "references"));
  writeFileSync(join(f, "SKILL.md"), "---\nname: vm-health\ndescription: Checks a VM when asked \"is it up\"\nrisk: read\nruns_on: local\nrequires_secrets: [DATABASE_URL]\n---\n# VM health\n\nRun scripts/check-health.sh.\n");
  writeFileSync(join(f, "scripts", "check-health.sh"), "#!/bin/sh\npsql \"$DATABASE_URL\" -c 'select 1'\ncurl -H \"Authorization: $GITHUB_TOKEN\" x\n");
  chmodSync(join(f, "scripts", "check-health.sh"), 0o755);
  writeFileSync(join(f, "scripts", "fix-vnc.sh"), `#!/bin/sh\ncat > key <<'K'\n${FAKE_PRIVATE_KEY}\nK\n`);
  writeFileSync(join(f, "references", "faults.md"), "| symptom | fix |\n");
  writeFileSync(join(f, ".DS_Store"), "x");
  writeFileSync(join(f, "SKILL.md.bak-1"), "old");
  writeFileSync(join(f, "sweep.log"), "ran");
  writeFileSync(join(f, ".netrc"), "machine host login u password hunter2pass\n");
  writeFileSync(join(f, ".env"), "ADMIN_PASSWORD=CorrectHorse42\n");
  writeFileSync(join(f, "__pycache__", "a.pyc"), "x");
  writeFileSync(join(f, "node_modules", "x", "index.js"), "x");
  writeFileSync(join(f, "logo.bin"), Buffer.from([0, 1, 2, 3]));
  symlinkSync("/etc/hosts", join(f, "hosts"));
  symlinkSync(join(f, "references", "faults.md"), join(f, "faults-link.md"));
  const r = await route({ action: "import", kind: "skill", path: f });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.ref.slug, r.body.ref.status, r.body.ref.source, r.body.ref.risk, r.body.ref.runsOn], ["vm-health", "draft", "import", "read", "local"]);
  assert.equal(r.body.drafted, false);
  assert.deepEqual(
    r.body.skipped.map((p) => `${p.path}${p.line ? `:${p.line}` : ""} ${p.reason}`).sort(),
    [".DS_Store junk: .DS_Store", "SKILL.md.bak-1 junk: backup file", "__pycache__ junk: __pycache__", "hosts link to outside the folder", "logo.bin binary file (only text files are kept)", "node_modules junk: node_modules", "scripts/fix-vnc.sh:3 secret: private key block", "sweep.log junk: log file", ".netrc credentials file: never kept", ".env credentials file: never kept"].sort(),
  );
  assert.deepEqual(r.body.warnings, [{ path: "scripts/check-health.sh", line: 3, reason: "uses GITHUB_TOKEN, which requires_secrets doesn't declare" }]);
  const d = W.skillDetail("ws_main", "skill", "vm-health");
  assert.deepEqual(d.files.map((x) => [x.path, x.executable, x.script]), [["faults-link.md", false, false], ["references/faults.md", false, false], ["scripts/check-health.sh", true, true]]);
  assert.ok(!JSON.stringify(r.body).includes("OPENSSH PRIVATE KEY-----\nb3Bl"), "the key isn't said back");
  // A folder with only a README: drafted from it.
  const g = join(scratch, "orgo-doctor");
  mkdirSync(g);
  writeFileSync(join(g, "README.md"), "# Orgo doctor\n\nFinds what's wrong with a computer and says the fix.\n");
  writeFileSync(join(g, "Makefile"), "check:\n\t./check.sh\n");
  const doc = await route({ action: "import", kind: "app", path: g });
  assert.deepEqual([doc.body.ref.kind, doc.body.ref.slug, doc.body.ref.name, doc.body.ref.description, doc.body.drafted], ["app", "orgo-doctor", "Orgo doctor", "Finds what's wrong with a computer and says the fix.", true]);
  assert.ok(existsSync(join(dataDir(), "ws_main", "apps", "orgo-doctor", "Makefile")), "an app's folder is under apps/");
  // A secret in SKILL.md itself refuses the whole folder.
  const h = join(scratch, "leaky");
  mkdirSync(h);
  writeFileSync(join(h, "SKILL.md"), `---\nname: leaky\ndescription: x\n---\nkey: ${FAKE_STRIPE}\n`);
  const leak = await route({ action: "import", path: h });
  assert.equal(leak.status, 422);
  assert.deepEqual(leak.body.problems, [{ path: "SKILL.md", line: 5, reason: "secret: Stripe secret key" }]);
  assert.equal(W.refsOf("ws_main").some((x) => x.slug === "leaky"), false);
  assert.deepEqual((await route({ action: "import", path: "relative/path" })).body, { error: "Pick a folder." });
  assert.equal((await route({ action: "import", path: join(scratch, "nope") })).status, 404);
});

/* ---------------- On a computer, and the prompts ---------------- */

await check("A computer two workspaces' bots share gets only the working bot's workspace's skills, the other's cleared; unapproved scripts never arrive", async () => {
  W.createSkill("ws_two", { name: "Weekly report", description: "Two's own", body: "# Two's\n", status: "published" });
  const sent = [];
  const n = await W.copySkillsToComputer("boppy", "c_free", async (id, command) => (sent.push({ id, command }), { output: "", exit_code: 0 }));
  assert.equal(n, 1, "bops' weekly report only (bops' app and the imported skill are drafts; Two's is Two's)");
  const all = sent.map((x) => x.command).join("\n");
  assert.match(all, /'\/workspace\/capabilities\/skills\/weekly-report\/SKILL\.md'/);
  assert.doesNotMatch(all, /weekly-report-2/);
  assert.doesNotMatch(all, /vm-health|orgo-doctor/, "drafts don't go");
  assert.doesNotMatch(all, new RegExp(Buffer.from("# Two's\n").toString("base64").slice(0, 8)), "nothing of Two's");
  // Unchanged since: nothing sent again.
  const again = sent.length;
  await W.copySkillsToComputer("boppy", "c_free", async (id, command) => (sent.push({ id, command }), { output: "", exit_code: 0 }));
  assert.equal(sent.length, again);
  // Two's bot works there next: everything is cleared and only Two's goes.
  await W.copySkillsToComputer("tess", "c_free", async (id, command) => (sent.push({ id, command }), { output: "", exit_code: 0 }));
  const two = sent.slice(again).map((x) => x.command).join("\n");
  assert.match(two, /rm -rf \/workspace\/capabilities\/skills/);
  assert.match(two, /'\/workspace\/capabilities\/skills\/weekly-report\/SKILL\.md'/);
  assert.doesNotMatch(two, /scripts\/sum\.sh.*chmod/, "bops' approvals don't reach Two's");
});

await check("Versions are version shaped (never a path); a key in a description is refused; a bot's edit waits for Publish", async () => {
  const r = W.createSkill("ws_main", { name: "Paths", description: "Tries versions", body: "# Paths\n" }).ref;
  const home = join(scratch, "keep-me");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "x"), "x");
  assert.throws(() => W.publishSkill("ws_main", "skill", r.slug, { version: "../../../../../../../../.." }), /A version looks like 1\.2\.0\./);
  assert.ok(existsSync(join(home, "x")), "nothing deleted outside");
  assert.equal(W.skillDetail("ws_main", "skill", r.slug, "../../..").missing, true);
  assert.throws(() => W.createSkill("ws_main", { name: "Leak", description: `Use ${FAKE_STRIPE}`, body: "# x\n" }), /looks like a secret/);
  W.publishSkill("ws_main", "skill", r.slug);
  W.updateSkill("ws_main", "skill", r.slug, { description: "Changed by a bot", body: "# Paths\n\nNew.\n" }, { draft: true });
  assert.equal(W.findRef("ws_main", "skill", r.slug).description, "Tries versions", "the prompts keep the published one");
  W.publishSkill("ws_main", "skill", r.slug);
  assert.equal(W.findRef("ws_main", "skill", r.slug).description, "Changed by a bot", "live once published");
  await W.deleteSkill("ws_main", "skill", r.slug);
});

await check("The prompts list skills and apps by name and description, at most 15 of them", async () => {
  W.publishSkill("ws_main", "app", "orgo-doctor");
  const note = hear(W.skillsNote("max"));
  assert.match(note, /^Your skills: [^\n]+\n- Weekly report: [^\n]+\nApps you can run on your computer \(read one with read_skill before running it\):\n- Orgo doctor: Finds what's wrong with a computer and says the fix\.$/);
  for (let i = 0; i < 20; i++) W.createSkill("ws_main", { name: `Many ${i}`, description: `Number ${i}`, body: `# ${i}\n`, status: "published" });
  const many = W.skillsNote("max");
  assert.equal(many.split("\n").filter((l) => l.startsWith("- ")).length, 15);
  assert.match(many, /\(7 more\. read_skill with a name not listed here gives all their names\.\)$/);
  for (let i = 0; i < 20; i++) await W.deleteSkill("ws_main", "skill", `many-${i}`);
});

/* ---------------- The folder, and Orgo ---------------- */

await check("A workspace bound to its Orgo project: its folder moves to the project's id, merging by slug with one there", async () => {
  // Another Mac already synced a skill into the project's folder.
  mkdirSync(join(dataDir(), "p_two", "skills", "from-there"), { recursive: true });
  writeFileSync(join(dataDir(), "p_two", "skills", "from-there", "SKILL.md"), "---\nname: from-there\ndescription: x\n---\n");
  mkdirSync(join(dataDir(), "p_two", "skills", "weekly-report"), { recursive: true });
  writeFileSync(join(dataDir(), "p_two", "skills", "weekly-report", "SKILL.md"), "theirs");
  const O = await import(`${root}/lib/server/orgo.ts`);
  O.bindProject("ws_two", "p_two");
  assert.equal(S.getState().workspaces.find((w) => w.id === "ws_two").orgoProjectId, "p_two");
  assert.ok(!existsSync(join(dataDir(), "ws_two")), "the old folder is gone");
  assert.ok(existsSync(join(dataDir(), "p_two", "skills", "from-there", "SKILL.md")), "what was there stays");
  assert.equal(readFileSync(join(dataDir(), "p_two", "skills", "weekly-report", "SKILL.md"), "utf8"), "theirs", "a slug both have: what was there stays");
  assert.ok(existsSync(join(dataDir(), "p_two", ".versions", "skills", "weekly-report", "0.1.0", "SKILL.md")), "its versions came along");
});

await check("Today's orgo-web has no skills routes: they stay on this Mac, and nothing is sent", async () => {
  remote.routes = false;
  remote.calls = [];
  const r = await W.syncSkills("ws_two");
  assert.deepEqual(r, { mode: "local", pushed: 0, pulled: 0, failed: 0 });
  assert.deepEqual(remote.calls.map((c) => `${c.method} ${c.path}`), ["GET /api/workspaces/p_two/skills"], "one look, nothing written");
  assert.deepEqual(await W.syncSkills("ws_two"), { mode: "local", pushed: 0, pulled: 0, failed: 0 });
  assert.equal(remote.calls.length, 1, "not asked again");
  assert.deepEqual(await W.syncSkills("ws_main"), { mode: "local", pushed: 0, pulled: 0, failed: 0 }, "a workspace with no project: local only");
});

await check("With orgo-web's skills routes: pushed, pulled, the later change winning each way, a delete sent", async () => {
  remote.routes = true;
  globalThis.bopsSkillsRoutes?.clear();
  // One only on Orgo (made in Orgo's own app), published.
  remote.skills.push({ id: "sk_orgo", pid: "p_two", slug: "made-in-orgo", name: "Made in Orgo", description: "From Orgo", type: "skill", status: "published", bot_ids: [], source: "orgo", version: "1.0.0", body: "---\nname: made-in-orgo\ndescription: From Orgo\nversion: \"1.0.0\"\n---\n# Made in Orgo\n", files: [{ path: "scripts/x.sh", content: "#!/bin/sh\n", executable: true }], updated_at: new Date(Date.now() - 60_000).toISOString() });
  remote.calls = [];
  const r = await W.syncSkills("ws_two");
  assert.equal(r.mode, "orgo");
  assert.equal(r.failed, 0);
  // Two's weekly report went to Orgo with its SKILL.md text, its type and bots.
  const pushed = remote.calls.find((c) => c.method === "POST" && c.path === "/api/workspaces/p_two/skills");
  assert.ok(pushed, remote.calls.map((c) => `${c.method} ${c.path}`).join(", "));
  assert.deepEqual([pushed.body.name, pushed.body.type, pushed.body.status, pushed.body.source, pushed.body.version], ["Weekly report", "skill", "published", "bops", "0.1.0"]);
  assert.match(pushed.body.body, /^---\nname: weekly-report\n/);
  // Orgo's came here, published at its version, a script without its approval.
  const got = W.findRef("ws_two", "skill", "made-in-orgo");
  assert.deepEqual([got.source, got.status, got.version, got.remoteId], ["orgo", "published", "1.0.0", "sk_orgo"]);
  assert.ok(existsSync(join(dataDir(), "p_two", "skills", "made-in-orgo", "scripts", "x.sh")));
  assert.match(W.readSkill("tess", "Made in Orgo"), /^Skill: Made in Orgo \(version 1\.0\.0\)/);
  // Run again: nothing changed on either side, nothing sent.
  remote.calls = [];
  assert.deepEqual(await W.syncSkills("ws_two"), { mode: "orgo", pushed: 0, pulled: 0, failed: 0 });
  assert.deepEqual(remote.calls.map((c) => c.method), ["GET"]);
  // Changed on Orgo since: brought here.
  const there = remote.skills.find((s) => s.id === "sk_orgo");
  Object.assign(there, { name: "Made in Orgo, v2", version: "1.0.1", body: there.body.replace("# Made in Orgo", "# Made in Orgo, changed there"), updated_at: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await W.syncSkills("ws_two")).pulled, 1);
  assert.equal(W.findRef("ws_two", "skill", "made-in-orgo").name, "Made in Orgo, v2");
  assert.match(W.readSkill("tess", "made-in-orgo"), /changed there/);
  // Changed here later: sent to Orgo (its name, and a new version).
  await new Promise((r2) => setTimeout(r2, 5));
  W.updateSkill("ws_two", "skill", "weekly-report", { name: "Weekly report, Two", body: "# Two's, better\n" });
  W.publishSkill("ws_two", "skill", "weekly-report");
  remote.calls = [];
  const out = await W.syncSkills("ws_two");
  assert.equal(out.pushed, 1, JSON.stringify(out));
  assert.equal(remote.calls.find((c) => c.method === "PATCH").body.name, "Weekly report, Two");
  assert.equal(remote.calls.find((c) => c.method === "POST" && c.path.endsWith("/versions")).body.version, "0.1.1");
  // Deleted here: deleted on Orgo too.
  const id = W.findRef("ws_two", "skill", "weekly-report").remoteId;
  remote.calls = [];
  await W.deleteSkill("ws_two", "skill", "weekly-report");
  assert.deepEqual(remote.calls.map((c) => `${c.method} ${c.path}`), [`DELETE /api/workspaces/p_two/skills/${id}`]);
  assert.equal(remote.skills.some((s) => s.id === id), false);
});

await check("Syncs at once (the publish's timer, the window, the sign-in move) are one at a time: one POST, never a second copy on Orgo", async () => {
  const made = W.createSkill("ws_two", { name: "Race check", description: "Checks the race", body: "# Race check\n" }).ref;
  W.publishSkill("ws_two", "skill", made.slug);
  for (const t of globalThis.bopsSkillsSync?.values() ?? []) clearTimeout(t);
  globalThis.bopsSkillsSync?.clear();
  remote.calls = [];
  const [a, b, c] = await Promise.all([W.syncSkills("ws_two"), W.syncSkills("ws_two"), W.syncSkills("ws_two")]);
  const posts = remote.calls.filter((x) => x.method === "POST" && x.path === "/api/workspaces/p_two/skills");
  assert.equal(posts.length, 1, remote.calls.map((x) => `${x.method} ${x.path}`).join(", "));
  assert.equal(remote.skills.filter((x) => x.pid === "p_two" && x.name === "Race check").length, 1, "one copy on Orgo");
  assert.equal(W.findRef("ws_two", "skill", made.slug).remoteId, remote.skills.find((x) => x.name === "Race check").id, "tied to that copy");
  // Every call waits for the run after the one under way, and sees the final state (nothing left to push).
  assert.ok(a === b && b === c, "one answer for the calls made meanwhile");
  assert.deepEqual(a, { mode: "orgo", pushed: 0, pulled: 0, failed: 0 });
  // Over: the next call is a run of its own.
  remote.calls = [];
  assert.deepEqual(await W.syncSkills("ws_two"), { mode: "orgo", pushed: 0, pulled: 0, failed: 0 });
  assert.equal(remote.calls.filter((x) => x.method === "POST").length, 0);
  await W.deleteSkill("ws_two", "skill", made.slug);
});

await check("The route lists a workspace's skills and apps, after a sync when asked; only from the Bops window", async () => {
  const list = await route("?sync=1&ws=ws_two", "GET");
  assert.equal(list.status, 200);
  assert.equal(list.body.orgo, true);
  assert.deepEqual(list.body.skills.map((r) => r.slug), ["made-in-orgo"]);
  const res = await Route.GET(new Request("http://localhost:3210/api/skills", { headers: {} }));
  assert.equal(res.status, 403);
  assert.equal((await route({ action: "detail", kind: "skill", slug: "gone" })).status, 404);
});

await check("Plain words: nothing a person or a bot reads has a dash, or a secret", async () => {
  for (const x of said) {
    assert.ok(!/[–—]/.test(x), `no dashes: ${x.slice(0, 120)}`);
    assert.ok(!x.includes(FAKE_STRIPE) && !x.includes("b3BlbnNzaC1rZXktdjEAAAAA"), `no secret said back: ${x.slice(0, 120)}`);
  }
  for (const l of logged) assert.ok(!l.includes(FAKE_STRIPE) && !l.includes("b3BlbnNzaC1rZXktdjEAAAAA"), "never logged");
  assert.deepEqual(logged.filter((l) => /^\[skills\]/.test(l)), [], "no stray warnings");
  assert.deepEqual(rejections, []);
});

server.close();
console.log(`\nskills: ${passed} passed, ${failed} failed`);
if (!failed) rmSync(scratch, { recursive: true, force: true });
else console.log(`The throwaway folder is kept for a look: ${scratch}`);
process.exit(failed ? 1 : 0);
