// Tests for skills under labels (lib/skill-labels.ts, lib/server/workspace-skills.ts, lib/server/skill-bundle.ts):
// a skill's label kept in its SKILL.md as metadata.label (written on create, a move and publish, read on an
// import and a pull, so it syncs with Orgo unchanged, as orgo-web's YAML reads and writes it), a bot's labels
// (Bops' own first, then its workspace's by how many skills, Unsorted last), the layered list in its prompts
// (few skills: listed under their labels; many: one line per label), read_skill by label and by name (the
// workspace's and Bops' own), create and update with a label (one already in use spelled as it is), labels
// from a skill's own words for one without (plain rules, once), and INDEX.md on a computer, by label, which a
// brain thread reads first. Bops' own skills are a stand in here (lib/builtin-skills.ts as it's shaped), so
// the expected text is fixed; the real file is checked for that shape when it's there. orgo-web is a fake
// (a local server), the Keychain is never there, and the state and folders live in a throwaway folder:
// nothing reaches a real service. The key in it is made up.
// Usage: node --conditions=react-server scripts/test-skill-labels.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.BOPS_UI_TOKEN = "ui-token-test-skill-labels";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-skill-labels-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const ORGO_KEY = "sk_orgo_test_skill_labels";
globalThis.bopsOrgoKey = ORGO_KEY;
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

/** Bops' own skills as lib/builtin-skills.ts shapes them: one label with two skills (one with a file), and a label with none yet. */
const BUILTINS = `import { APPS_LABEL, sameLabel } from ${JSON.stringify(pathToFileURL(`${root}/lib/skill-labels.ts`).href)};
export const BUILTIN_LABELS = [
  { label: APPS_LABEL, about: "Building, versioning and deploying apps with Ingot: read one before you change an app." },
  { label: "Bops basics", about: "Nothing in it yet." },
];
export const BUILTIN_SKILLS = [
  { slug: "bops-work-on-an-app", name: "Work on an app with Ingot", description: "Read before you change an app: ingot status, diff and commit.", label: APPS_LABEL, body: "# Work on an app with Ingot\\n\\n1. ingot clone <name>\\n2. ingot commit -m <message>\\n", files: [{ path: "examples/notes.md", content: "Notes on apps.\\n" }] },
  { slug: "bops-deploy-an-app", name: "Deploy an app", description: "Read before you put an app live with deploy_app.", label: APPS_LABEL, body: "# Deploy an app\\n\\n1. deploy_app with the app's name\\n" },
];
export const builtinSkills = (apps) => (apps ? BUILTIN_SKILLS : BUILTIN_SKILLS.filter((s) => !sameLabel(s.label, APPS_LABEL)));
export const builtinLabels = (apps) => (apps ? BUILTIN_LABELS : BUILTIN_LABELS.filter((l) => !sameLabel(l.label, APPS_LABEL)));
`;
const BUILTINS_URL = pathToFileURL(`${root}/lib/builtin-skills.ts`).href;
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror", "sessions"]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/builtin-skills") return { url: BUILTINS_URL, shortCircuit: true };
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
    if (url === BUILTINS_URL) return { format: "module", shortCircuit: true, source: BUILTINS };
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

/** Made up, in the shape the scanner knows. Nothing here is a real key. */
const FAKE_STRIPE = ["sk", "live", "0123456789abcdefABCDEF01"].join("_");
/** orgo-web reads and writes SKILL.md's YAML with js-yaml (gray-matter's engine): the same parser here. */
const yaml = createRequire(import.meta.url)("js-yaml");
const yamlOf = (md) => yaml.load(/^---\n([\s\S]*?)\n---\n/.exec(md)[1]);

/* ---------------- A fake orgo-web's skills routes ---------------- */

const remote = { skills: [], calls: [], seq: 0 };
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
  if (!m) return send(res, 404, { error: "Not found" });
  const [, pid, sid, sub] = m;
  if (sid === "approvals") return send(res, 200, { approvals: [] });
  const view = (s) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description, type: s.type, status: s.status, bot_ids: s.bot_ids, updated_at: s.updated_at, current_version: { version: s.version } });
  const now = () => new Date(Date.now() + ++remote.seq).toISOString();
  if (!sid && req.method === "GET") return send(res, 200, { skills: remote.skills.filter((s) => s.pid === pid).map(view), deleted: [], full: true, at: new Date().toISOString() });
  if (!sid && req.method === "POST") {
    const s = { id: `sk_${++remote.seq}`, pid, slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: body.name, description: body.description, type: body.type, status: body.status, bot_ids: body.bot_ids, version: body.version ?? "0.1.0", body: body.body, files: body.files, updated_at: now() };
    remote.skills.push(s);
    return send(res, 201, { skill: view(s) });
  }
  const s = remote.skills.find((x) => x.id === sid && x.pid === pid);
  if (!s) return send(res, 404, { error: "Not found", code: "skill_not_found" });
  if (sub === "export") return send(res, 200, { version: s.version, files: { "SKILL.md": { content: s.body }, ...Object.fromEntries((s.files ?? []).map((f) => [f.path, { content: f.content }])) } });
  if (sub === "versions" && req.method === "POST") {
    Object.assign(s, { body: body.body, files: body.files, version: body.version, updated_at: now() });
    return send(res, 201, { skill: view(s) });
  }
  if (req.method === "PATCH") {
    Object.assign(s, { name: body.name ?? s.name, description: body.description ?? s.description, bot_ids: body.bot_ids ?? s.bot_ids, status: body.status ?? s.status, updated_at: now() });
    return send(res, 200, { skill: view(s) });
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
/** Everything a person or a bot could read, checked for dashes at the end. */
const said = [];
const hear = (...xs) => (said.push(...xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))), xs[0]);

const S = await import(`${root}/lib/server/store.ts`);
const W = await import(`${root}/lib/server/workspace-skills.ts`);
const B = await import(`${root}/lib/server/skill-bundle.ts`);
const L = await import(`${root}/lib/skill-labels.ts`);

S.update((s) => {
  s.owner = { name: "Tiger" };
  // Bops' own skills for apps are open to an @orgo.ai account (lib/apps-access.ts); a check below signs in as someone else.
  s.account = { user: { id: "u_tiger", email: "ava@orgo.ai", name: "Tiger" }, signedInAt: 1 };
  s.workspaces = [
    { id: "ws_small", name: "Small", createdAt: 0 },
    { id: "ws_big", name: "Big", createdAt: 1 },
    { id: "ws_old", name: "Old", createdAt: 2 },
    { id: "ws_sync", name: "Sync", createdAt: 3, orgoProjectId: "p_sync" },
    { id: "ws_none", name: "None", createdAt: 4 },
  ];
  s.bots = [
    { id: "sam", name: "Sam", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "ready", computerId: "c_sam", workspaceId: "ws_small" },
    { id: "pip", name: "Pip", role: "Research", color: "#5B8CFF", isMain: false, computerStatus: "none", computer: "shared", workspaceId: "ws_small" },
    { id: "bea", name: "Bea", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "ready", computerId: "c_bea", workspaceId: "ws_big" },
    { id: "syd", name: "Syd", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", workspaceId: "ws_sync" },
    { id: "nol", name: "Nol", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "ready", computerId: "c_nol", workspaceId: "ws_none" },
  ];
});
const dataDir = () => join(process.cwd(), ".data", "workspaces");
const skillMd = (ws, slug) => readFileSync(join(dataDir(), ws, "skills", slug, "SKILL.md"), "utf8");
const versionMd = (ws, slug, v) => readFileSync(join(dataDir(), ws, ".versions", "skills", slug, v, "SKILL.md"), "utf8");
let at = 100;
/** A published skill of a workspace, made in a fixed order (its createdAt), so lists come out the same each run. */
const make = (ws, input) => {
  at += 1;
  const { ref } = W.createSkill(ws, { body: `# ${input.name}\n\n1. Do it.\n`, status: "published", times: { createdAt: at, updatedAt: at }, ...input });
  return ref;
};

/* ---------------- SKILL.md ---------------- */

await check("The label in SKILL.md: metadata.label, written and read back the same, the rest of metadata kept", async () => {
  const p = B.parseSkillMd("---\nname: x\ndescription: X\nmetadata:\n  label: Sales calls\n  owner: sam\n---\n# X\n");
  assert.ok(p.ok);
  assert.equal(B.labelOf(p.frontmatter), "Sales calls");
  const moved = B.withLabel(p.frontmatter, "Sales: calls, east");
  assert.deepEqual(moved.metadata, { owner: "sam", label: "Sales: calls, east" });
  const md = B.renderSkillMd(moved, p.body);
  assert.equal(md, '---\nname: x\ndescription: X\nmetadata: {label: "Sales: calls, east", owner: sam}\n---\n\n# X\n');
  assert.equal(B.labelOf(B.parseSkillMd(md).frontmatter), "Sales: calls, east", "read back as written");
  assert.deepEqual(B.validateFrontmatter(moved), [], "a key Bops' checks pass");
  // A label written by hand at the top is read, and kept in metadata from the next write on.
  const hand = B.parseSkillMd("---\nname: x\ndescription: X\nlabel: Ops\n---\n").frontmatter;
  assert.equal(B.labelOf(hand), "Ops");
  assert.deepEqual(B.withLabel(hand, "Ops"), { name: "x", description: "X", metadata: { label: "Ops" } });
  assert.equal(B.labelOf({ name: "x" }), undefined);
  assert.equal(B.labelOf({ metadata: { label: "   " } }), undefined, "blank is none");
  assert.deepEqual(B.withLabel({ name: "x" }, undefined), { name: "x" }, "no label: as it was");
});

await check("orgo-web's YAML (js-yaml) reads the label Bops writes, and Bops reads it as orgo-web writes it back", async () => {
  for (const label of ["Email", "Apps and source control", "Sales: calls, east", "Q&A #2", "it's 'quoted'"]) {
    const md = B.renderSkillMd(B.withLabel({ name: "x", description: "X", version: "1.0.0" }, label), "# X\n");
    const fm = yamlOf(md);
    assert.equal(fm.metadata.label, label, `orgo-web reads ${label}`);
    // orgo-web stores it rendered again in its own key order, nested maps as blocks.
    const back = `---\n${yaml.dump({ name: fm.name, description: fm.description, version: fm.version, metadata: fm.metadata })}---\n# X\n`;
    assert.equal(B.labelOf(B.parseSkillMd(back).frontmatter), label, `Bops reads ${label} back`);
  }
});

/* ---------------- Labels from a skill's own words ---------------- */

await check("A skill without a label gets one from its name and description, by plain rules; none fits: Unsorted", async () => {
  const cases = [
    ["Inbox sweep", "Sort the Gmail inbox each morning", "Email"],
    ["Book a meeting", "Find a time on the calendar", "Calendar"],
    ["Follow up leads", "Check the CRM pipeline", "Sales"],
    ["Screen candidates", "Read resumes for the job posting", "Recruiting"],
    ["Weekly invoice summary", "When Tiger asks for the weekly summary", "Finance"],
    ["Answer tickets", "Customer support in Zendesk", "Support"],
    ["Competitor scan", "Research what competitors charge", "Research"],
    ["Blog post", "Write a draft for the blog", "Writing"],
    ["Tweet the launch", "Post on Twitter and LinkedIn", "Social"],
    ["Ship the website", "Deploy the site after a commit", L.APPS_LABEL],
    ["Fix the merge conflict", "In the GitHub repo", L.APPS_LABEL],
    // Bops' own label only for words that mean source control or deploying: a site, an app or a code alone isn't one.
    ["Parking pass", 'When asked "a parking pass for X": book it on the garage site', L.UNSORTED],
    ["Discount code", "Find a discount code for the Uber app", L.UNSORTED],
    ["Bank branch", "Find the nearest branch and its hours", "Finance"],
    ["Water the plants", "Every Monday", L.UNSORTED],
    // A tie goes to the first rule; a word in the name counts twice.
    ["Email the invoice", "", "Email"],
    ["Expenses", "Read the email with the receipts", "Finance"],
  ];
  for (const [name, description, want] of cases) assert.equal(W.guessLabel(name, description), want, `${name}: ${description}`);
});

await check("Skills from before labels get one once, from their words, kept after (no change to send)", async () => {
  S.update((s) => {
    s.workspaces.find((w) => w.id === "ws_old").skills = [
      { slug: "old-payroll", kind: "skill", name: "Old payroll run", description: "Runs payroll on Fridays", status: "published", version: "0.1.0", botIds: [], source: "bops", createdAt: 1, updatedAt: 5 },
      { slug: "old-chosen", kind: "skill", name: "Chosen", description: "Tweets", label: "Ops", status: "draft", botIds: [], source: "bops", createdAt: 2, updatedAt: 6 },
    ];
  });
  const [pay, chosen] = W.refsOf("ws_old", "skill");
  assert.deepEqual([pay.label, pay.updatedAt], ["Finance", 5], "labeled, not changed");
  assert.equal(chosen.label, "Ops", "one with a label keeps it");
  S.update((s) => (s.workspaces.find((w) => w.id === "ws_old").skills[0].description = "Tweets about payday"));
  assert.equal(W.refsOf("ws_old", "skill")[0].label, "Finance", "once: its words changing later don't move it");
});

/* ---------------- Making them with a label ---------------- */

await check("A new skill: a label given is kept in its SKILL.md and the state, one in use spelled as it is; none: from its words, in the state", async () => {
  const inbox = make("ws_small", { name: "Inbox sweep", description: 'Sorts the inbox each morning when asked for "the sweep"', label: "Email" });
  assert.equal(inbox.label, "Email");
  assert.match(skillMd("ws_small", "inbox-sweep"), /\nmetadata: \{label: Email\}\n/);
  const weekly = make("ws_small", { name: "Weekly invoice summary", description: "When asked for the week's invoices" });
  assert.equal(weekly.label, "Finance", "from its words");
  assert.doesNotMatch(skillMd("ws_small", "weekly-invoice-summary"), /metadata/, "its folder as written: the label waits in the state");
  assert.match(versionMd("ws_small", "weekly-invoice-summary", "0.1.0"), /\nmetadata: \{label: Finance, version: "0\.1\.0"\}\n/, "and goes into its SKILL.md once published (with its version, as the Agent Skills spec keeps both: in metadata)");
  make("ws_small", { name: "Water the plants", description: "Every Monday, a reminder" });
  const news = make("ws_small", { name: "Newsletter draft", description: "Writes the Friday newsletter", label: "  email " });
  assert.equal(news.label, "Email", "the workspace's spelling");
  const deploy = make("ws_small", { name: "Deploy checklist", description: "Before a deploy of the site", label: "apps AND source control" });
  assert.equal(deploy.label, L.APPS_LABEL, "Bops' own label, spelled as Bops spells it");
  // Not Sam's: a draft, and one only Pip has.
  W.createSkill("ws_small", { name: "Draft thing", description: "Not yet", body: "# Draft\n", label: "Drafts" });
  make("ws_small", { name: "Pip's own", description: "Looks things up", label: "Research", botIds: ["pip"] });
  // A long label is cut; a frontmatter label is the one kept.
  const long = W.createSkill("ws_old", { name: "Long", description: "x", body: "# Long\n", label: "A".repeat(60) }).ref;
  assert.equal(long.label, "A".repeat(L.SKILL_LABEL_MAX));
  const fmd = W.createSkill("ws_old", { name: "From frontmatter", description: "x", body: "# F\n", frontmatter: { metadata: { label: "Ops", owner: "sam" } } }).ref;
  assert.equal(fmd.label, "Ops", "spelled as ws_old already has it");
  assert.match(skillMd("ws_old", "from-frontmatter"), /\nmetadata: \{label: Ops, owner: sam\}\n/);
});

await check("A folder imported with a label in its SKILL.md keeps it", async () => {
  const f = join(scratch, "vm-health");
  mkdirSync(f);
  writeFileSync(join(f, "SKILL.md"), "---\nname: vm-health\ndescription: Checks a VM when asked \"is it up\"\nmetadata:\n  label: Ops\n  owner: sam\n---\n# VM health\n");
  const { ref } = W.importFolder("ws_old", f);
  assert.equal(ref.label, "Ops");
  assert.equal(B.labelOf(B.parseSkillMd(skillMd("ws_old", "vm-health")).frontmatter), "Ops");
  assert.deepEqual(B.parseSkillMd(skillMd("ws_old", "vm-health")).frontmatter.metadata, { label: "Ops", owner: "sam" });
});

/* ---------------- A bot's labels ---------------- */

const APPS_ABOUT = "Building, versioning and deploying apps with Ingot: read one before you change an app.";

await check("A bot's labels: Bops' own first (only one with a skill), then its workspace's by how many, Unsorted last", async () => {
  assert.deepEqual(W.skillGroups("sam"), [
    { label: L.APPS_LABEL, about: APPS_ABOUT, builtin: true, count: 3, slugs: ["bops-work-on-an-app", "bops-deploy-an-app", "deploy-checklist"] },
    { label: "Email", about: "Inbox sweep, Newsletter draft", builtin: false, count: 2, slugs: ["inbox-sweep", "newsletter-draft"] },
    { label: "Finance", about: "Weekly invoice summary", builtin: false, count: 1, slugs: ["weekly-invoice-summary"] },
    { label: "Unsorted", about: "Water the plants", builtin: false, count: 1, slugs: ["water-the-plants"] },
  ]);
  assert.deepEqual(
    W.skillGroups("pip").map((g) => [g.label, g.count]),
    [[L.APPS_LABEL, 3], ["Email", 2], ["Finance", 1], ["Research", 1], ["Unsorted", 1]],
    "Pip's own skill too",
  );
  assert.deepEqual(W.skillGroups("nol"), [{ label: L.APPS_LABEL, about: APPS_ABOUT, builtin: true, count: 2, slugs: ["bops-work-on-an-app", "bops-deploy-an-app"] }], "a bot with none of its own has Bops'");
  assert.deepEqual(W.skillGroups("nobody"), []);
});

const HEAD = "Your skills: how your workspace does jobs it was shown before, and Bops' own, under labels. When a job fits a label, open it with read_skill and label to see its skills, then read the one that fits with read_skill and name, and follow it.";

await check("The list in its prompts, a few skills: under their labels, Bops' labels one line each", async () => {
  assert.equal(
    hear(W.skillsNote("sam")),
    [
      `${HEAD} One listed here you can read at once. Tell the user if a step no longer works.`,
      `Apps and source control (3): ${APPS_ABOUT}`,
      "- Deploy checklist: Before a deploy of the site",
      "Email (2):",
      '- Inbox sweep: Sorts the inbox each morning when asked for "the sweep"',
      "- Newsletter draft: Writes the Friday newsletter",
      "Finance (1):",
      "- Weekly invoice summary: When asked for the week's invoices",
      "Unsorted (1):",
      "- Water the plants: Every Monday, a reminder",
    ].join("\n"),
  );
  assert.equal(hear(W.skillsNote("nol")), [`${HEAD} Tell the user if a step no longer works.`, `Apps and source control (2): ${APPS_ABOUT}`].join("\n"), "only Bops' own");
  assert.equal(W.skillsNote("nobody"), "");
});

await check("The list in its prompts, up to 15 of its own (as many as were listed before labels): each with its description, under its label", async () => {
  S.update((s) => {
    s.workspaces.push({ id: "ws_mid", name: "Mid", createdAt: 5 });
    s.bots.push({ id: "mia", name: "Mia", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", workspaceId: "ws_mid" });
  });
  for (let n = 1; n <= 15; n++) make("ws_mid", { name: `Mid job ${n}`, description: `When asked for "mid job ${n}": does it`, label: n % 2 ? "Ops" : "Office" });
  const note = hear(W.skillsNote("mia"));
  assert.match(note.split("\n")[0], /One listed here you can read at once\./);
  for (let n = 1; n <= 15; n++) assert.ok(note.includes(`\n- Mid job ${n}: When asked for "mid job ${n}": does it`), `Mid job ${n}, with its description`);
  assert.deepEqual(note.split("\n").slice(1).filter((l) => !l.startsWith("- ")), [`Apps and source control (2): ${APPS_ABOUT}`, "Ops (8):", "Office (7):"]);
  // One more: one line per label, its skills' names.
  make("ws_mid", { name: "Mid job 16", description: 'When asked for "mid job 16": does it', label: "Ops" });
  const many = W.skillsNote("mia");
  assert.match(many, /\n- Ops \(9\): Mid job 1, Mid job 3, /);
  assert.doesNotMatch(many, /does it/);
});

await check("The list in its prompts, many skills: one line per label, short, the rest by reading a label", async () => {
  for (const n of [1, 2, 3]) make("ws_big", { name: `Email job ${n}`, description: `Email job number ${n}, with a long description that never reaches the prompt`, label: "Email" });
  const topics = "ABCDEFGHIJKLMNOPQRS".split("");
  for (const t of topics) make("ws_big", { name: `Skill ${t}`, description: `Does ${t}`, label: `Topic ${t}` });
  const note = hear(W.skillsNote("bea"));
  const lines = note.split("\n");
  assert.equal(lines[0], `${HEAD} Tell the user if a step no longer works.`);
  assert.deepEqual(lines.slice(1, 4), [`- Apps and source control (2): ${APPS_ABOUT}`, "- Email (3): Email job 1, Email job 2, Email job 3", "- Topic A (1): Skill A"]);
  assert.equal(lines.length, 1 + 15 + 1, "15 labels, then how to see the rest");
  assert.equal(lines[15], "- Topic M (1): Skill M");
  assert.equal(lines[16], "(6 more labels: read_skill with a label not listed here names them all.)");
  assert.doesNotMatch(note, /long description/, "no skill's description in it");
  assert.ok(note.length < 1500, `short: ${note.length}`);
  assert.match(W.readSkill("bea", "", null, "topic s"), /^Topic S \(1\)\nRead the one that fits with read_skill and name, then follow it\.\n- Skill S: Does S$/, "a label not listed opens all the same");
  // One of its own under Bops' label: named in that line, before Bops' words, so it's never out of sight.
  make("ws_big", { name: "Release notes", description: "After each deploy, writes what changed", label: L.APPS_LABEL });
  assert.equal(hear(W.skillsNote("bea")).split("\n")[1], `- Apps and source control (3): Release notes, and Bops' own: ${APPS_ABOUT}`);
});

/* ---------------- read_skill ---------------- */

await check("read_skill's tool: strict, every property required, label and name nullable", async () => {
  const t = W.READ_SKILL_TOOL;
  assert.equal(t.strict, true);
  assert.equal(t.parameters.additionalProperties, false);
  assert.deepEqual(t.parameters.required, Object.keys(t.parameters.properties));
  assert.deepEqual(t.parameters.required, ["name", "file", "label"]);
  assert.deepEqual(t.parameters.properties.label.type, ["string", "null"]);
  assert.deepEqual(t.parameters.properties.name.type, ["string", "null"]);
  hear(t.description, ...Object.values(t.parameters.properties).map((p) => p.description));
});

const LABELS_SAID = "Your labels: Apps and source control (3), Email (2), Finance (1), Unsorted (1). Open one with read_skill and label to see its skills.";

await check("read_skill by label: its skills one line each, Bops' own included; a label as the name; one there isn't", async () => {
  assert.equal(
    hear(W.readSkill("sam", "", null, "apps AND source control")),
    [
      `Apps and source control (3): ${APPS_ABOUT}`,
      "Read the one that fits with read_skill and name, then follow it.",
      "- Work on an app with Ingot: Read before you change an app: ingot status, diff and commit.",
      "- Deploy an app: Read before you put an app live with deploy_app.",
      "- Deploy checklist: Before a deploy of the site",
    ].join("\n"),
  );
  const email = ["Email (2)", "Read the one that fits with read_skill and name, then follow it.", '- Inbox sweep: Sorts the inbox each morning when asked for "the sweep"', "- Newsletter draft: Writes the Friday newsletter"].join("\n");
  assert.equal(W.readSkill("sam", "", null, "email"), email);
  assert.equal(W.readSkill("sam", "Email", null, null), email, "no skill by that name: the label");
  assert.equal(W.readSkill("sam", "Nothing like it", null, "Email"), email, "a name that isn't one, with a label: the label");
  assert.equal(hear(W.readSkill("sam", "", null, "Payroll")), `No label called "Payroll". ${LABELS_SAID}`);
  assert.equal(hear(W.readSkill("sam", "")), `Give a skill's name, or a label to see its skills. ${LABELS_SAID}`);
  assert.equal(hear(W.readSkill("sam", "Payroll")), `No skill called "Payroll". ${LABELS_SAID}`);
  assert.equal(W.findRef("ws_small", "skill", "inbox-sweep").uses, undefined, "opening a label isn't a use");
});

await check("read_skill by name: the workspace's as before (a use), Bops' own (its body, its files, one file); a name wins over a label", async () => {
  assert.equal(W.readSkill("sam", "inbox SWEEP"), "Skill: Inbox sweep (version 0.1.0)\n\n# Inbox sweep\n\n1. Do it.");
  assert.equal(W.findRef("ws_small", "skill", "inbox-sweep").uses, 1);
  assert.equal(W.readSkill("sam", "Inbox sweep", null, "Finance"), "Skill: Inbox sweep (version 0.1.0)\n\n# Inbox sweep\n\n1. Do it.", "the skill named");
  assert.equal(
    hear(W.readSkill("sam", "Work on an app with Ingot")),
    "Skill: Work on an app with Ingot (Bops' own)\n\n# Work on an app with Ingot\n\n1. ingot clone <name>\n2. ingot commit -m <message>\n\nIts files (read one with read_skill and file; on your computer they're in /workspace/capabilities/skills/bops-work-on-an-app/):\n- examples/notes.md",
  );
  assert.equal(W.readSkill("sam", "bops-deploy-an-app"), "Skill: Deploy an app (Bops' own)\n\n# Deploy an app\n\n1. deploy_app with the app's name", "by slug");
  assert.equal(W.readSkill("nol", "deploy an app", null, null), "Skill: Deploy an app (Bops' own)\n\n# Deploy an app\n\n1. deploy_app with the app's name", "every bot has them");
  assert.equal(W.readSkill("sam", "bops-work-on-an-app", "examples/notes.md"), "Work on an app with Ingot, examples/notes.md:\nNotes on apps.\n");
  assert.equal(hear(W.readSkill("sam", "bops-work-on-an-app", "../etc/passwd")), '"Work on an app with Ingot" has no file ../etc/passwd. Its files: examples/notes.md.');
  assert.match(W.readSkill("pip", "Pip's own"), /^Skill: Pip's own/);
  assert.match(W.readSkill("sam", "Pip's own"), /^No skill called "Pip's own"\./, "not Sam's");
});

/* ---------------- Moving one ---------------- */

await check("update with a label: moved at once (a bot's draft edit too), in its SKILL.md, the rest kept; none keeps it; a secret refused", async () => {
  const lead = W.createSkill("ws_small", { name: "Lead follow up", description: "Follows up on leads", body: "# Lead follow up\n", label: "  sales   calls  ", files: [{ path: "notes.md", content: "Call list.\n" }] }).ref;
  assert.equal(lead.label, "sales calls", "a new one, as given");
  assert.equal(skillMd("ws_small", "lead-follow-up"), "---\nname: lead-follow-up\ndescription: Follows up on leads\nmetadata: {label: sales calls}\n---\n\n# Lead follow up\n");
  const moved = W.updateSkill("ws_small", "skill", "lead-follow-up", { label: "EMAIL" });
  assert.equal(moved.label, "Email");
  assert.equal(skillMd("ws_small", "lead-follow-up"), "---\nname: lead-follow-up\ndescription: Follows up on leads\nmetadata: {label: Email}\n---\n\n# Lead follow up\n");
  assert.equal(readFileSync(join(dataDir(), "ws_small", "skills", "lead-follow-up", "notes.md"), "utf8"), "Call list.\n", "its files as they were");
  for (const label of [null, "", "   ", undefined]) assert.equal(W.updateSkill("ws_small", "skill", "lead-follow-up", { label }).label, "Email", `${JSON.stringify(label)} keeps it`);
  assert.throws(() => W.updateSkill("ws_small", "skill", "lead-follow-up", { label: FAKE_STRIPE }), /looks like a secret/);
  assert.equal(W.findRef("ws_small", "skill", "lead-follow-up").label, "Email");
  // A bot's edit of a published skill: its name and description wait for Publish, the label doesn't.
  make("ws_small", { name: "Refund check", description: "Checks a refund", label: "Finance" });
  const r = W.updateSkill("ws_small", "skill", "refund-check", { name: "Refund check", description: "Checks a refund twice", body: "# Refund check\n\n1. Twice.\n", label: "support" }, { draft: true });
  assert.deepEqual([r.label, r.description], ["Support", "Checks a refund"]);
  assert.match(skillMd("ws_small", "refund-check"), /^---\nname: refund-check\ndescription: Checks a refund twice\nmetadata: \{label: Support\}\n---\n/);
  const pub = W.publishSkill("ws_small", "skill", "refund-check");
  assert.deepEqual([pub.label, pub.description, pub.version], ["Support", "Checks a refund twice", "0.1.1"]);
  assert.match(versionMd("ws_small", "refund-check", "0.1.1"), /\nmetadata: \{label: Support, version: "0\.1\.1"\}\n/);
  // Only moved, on a published skill: the folder's SKILL.md says so, and the next version carries it.
  W.updateSkill("ws_small", "skill", "refund-check", { label: "Finance" });
  assert.match(skillMd("ws_small", "refund-check"), /\nmetadata: \{label: Finance\}\n/);
  assert.match(versionMd("ws_small", "refund-check", W.publishSkill("ws_small", "skill", "refund-check").version), /\nmetadata: \{label: Finance, version: "0\.1\.2"\}\n/);
  for (const slug of ["lead-follow-up", "refund-check"]) await W.deleteSkill("ws_small", "skill", slug);
});

/* ---------------- With Orgo ---------------- */

await check("Orgo: the label goes in the SKILL.md sent, one there comes here (a new one, and a change to one here)", async () => {
  make("ws_sync", { name: "Weekly invoice summary", description: "When asked for the week's invoices" });
  const fm = { name: "screen-candidates", description: "Reads resumes for a role", version: "1.0.0", metadata: { label: "Hiring" } };
  remote.skills.push({ id: "sk_orgo", pid: "p_sync", slug: "screen-candidates", name: "Screen candidates", description: "Reads resumes for a role", type: "skill", status: "published", bot_ids: [], version: "1.0.0", body: `---\n${yaml.dump(fm)}---\n# Screen candidates\n`, files: [], updated_at: new Date(Date.now() - 60_000).toISOString() });
  const r = await W.syncSkills("ws_sync");
  assert.deepEqual([r.mode, r.failed], ["orgo", 0]);
  const sent = remote.calls.find((c) => c.method === "POST" && c.path === "/api/workspaces/p_sync/skills");
  assert.ok(sent, remote.calls.map((c) => `${c.method} ${c.path}`).join(", "));
  assert.equal(yamlOf(sent.body.body).metadata.label, "Finance", "the label from its words, in what Orgo stores");
  assert.equal(W.findRef("ws_sync", "skill", "screen-candidates").label, "Hiring", "Orgo's label, here");
  assert.deepEqual(W.skillGroups("syd").map((g) => g.label), [L.APPS_LABEL, "Finance", "Hiring"]);
  // Moved on orgo.ai (its SKILL.md changed there, rendered as orgo-web renders it): moved here too.
  const there = remote.skills.find((x) => x.id === "sk_orgo");
  there.body = `---\n${yaml.dump({ ...fm, metadata: { label: "Recruiting" } })}---\n# Screen candidates\n`;
  there.updated_at = new Date().toISOString();
  await W.syncSkills("ws_sync");
  assert.equal(W.findRef("ws_sync", "skill", "screen-candidates").label, "Recruiting");
  // Orgo's copy with no label at all: the one here stays.
  there.body = "---\nname: screen-candidates\ndescription: Reads resumes for a role\nversion: '1.0.0'\n---\n# Screen candidates\n";
  there.updated_at = new Date(Date.now() + 1000).toISOString();
  await W.syncSkills("ws_sync");
  assert.equal(W.findRef("ws_sync", "skill", "screen-candidates").label, "Recruiting");
});

await check("Orgo: a move here stays when Orgo's copy comes back with the label it had (its PATCH takes none), goes with the next version, and one moved there comes here", async () => {
  const slug = "weekly-invoice-summary";
  const there = remote.skills.find((x) => x.pid === "p_sync" && x.slug === slug);
  assert.equal(yamlOf(there.body).metadata.label, "Finance");
  W.updateSkill("ws_sync", "skill", slug, { label: "Billing" });
  const from = remote.calls.length;
  await W.syncSkills("ws_sync");
  assert.ok(remote.calls.slice(from).some((c) => c.method === "PATCH" && c.path.endsWith(`/${there.id}`)), "sent as a change");
  assert.equal(yamlOf(there.body).metadata.label, "Finance", "Orgo's SKILL.md as it was");
  // Changed on orgo.ai otherwise (who has it): that comes here, the move stays.
  there.bot_ids = ["syd"];
  there.updated_at = new Date(Date.now() - 5000).toISOString();
  await W.syncSkills("ws_sync");
  const r = W.findRef("ws_sync", "skill", slug);
  assert.deepEqual([r.label, r.botIds], ["Billing", ["syd"]], "the move kept, the change taken");
  assert.match(skillMd("p_sync", slug), /\nmetadata: \{label: Billing\}\n/, "in its folder's SKILL.md too");
  // Published here: the version carries the move to Orgo.
  await new Promise((done) => setTimeout(done, 5));
  W.publishSkill("ws_sync", "skill", slug);
  await W.syncSkills("ws_sync");
  assert.equal(yamlOf(there.body).metadata.label, "Billing");
  // Moved there (another Mac's version): that comes here.
  there.body = there.body.replace("label: Billing", "label: Accounts");
  there.updated_at = new Date(Date.now() - 4000).toISOString();
  await W.syncSkills("ws_sync");
  assert.equal(W.findRef("ws_sync", "skill", slug).label, "Accounts");
});

/* ---------------- On a computer ---------------- */

/** A fake computer's bash: the files the copy wrote there, by path. */
function fakeComputer() {
  const files = new Map();
  const calls = [];
  const bash = async (_computerId, command) => {
    calls.push(command);
    for (const line of command.split("\n")) {
      if (line.startsWith("rm -rf ")) for (const p of [...files.keys()]) if (line.split(" ").slice(2).some((d) => p.startsWith(`${d}/`))) files.delete(p);
      for (const m of line.matchAll(/: > '([^']+)'/g)) files.set(m[1], Buffer.alloc(0));
      for (const m of line.matchAll(/printf %s '([A-Za-z0-9+/=]*)' \| base64 -d >> '([^']+)'/g)) files.set(m[2], Buffer.concat([files.get(m[2]) ?? Buffer.alloc(0), Buffer.from(m[1], "base64")]));
    }
    return { output: "", exit_code: 0 };
  };
  return { files, calls, bash, text: (p) => files.get(p)?.toString("utf8") };
}

await check("On a computer: Bops' own skills beside the workspace's, and INDEX.md listing them by label with their folders", async () => {
  const c = fakeComputer();
  await W.copySkillsToComputer("sam", "c_sam", c.bash);
  const K = "/workspace/capabilities/skills";
  assert.equal(
    c.text(`${K}/INDEX.md`),
    [
      "# Skills, by label",
      "",
      "How your workspace does jobs it was shown before, and Bops' own. Open the label that fits the job, then read that skill's SKILL.md in its folder and follow it. A script nobody approved yet says so when it runs: ask to have it approved in Skills, in Knowledge.",
      "",
      "## Apps and source control (3)",
      "",
      APPS_ABOUT,
      "",
      "- Work on an app with Ingot: Read before you change an app: ingot status, diff and commit.",
      `  Folder: ${K}/bops-work-on-an-app/`,
      "- Deploy an app: Read before you put an app live with deploy_app.",
      `  Folder: ${K}/bops-deploy-an-app/`,
      "- Deploy checklist: Before a deploy of the site",
      `  Folder: ${K}/deploy-checklist/`,
      "",
      "## Email (2)",
      "",
      '- Inbox sweep: Sorts the inbox each morning when asked for "the sweep"',
      `  Folder: ${K}/inbox-sweep/`,
      "- Newsletter draft: Writes the Friday newsletter",
      `  Folder: ${K}/newsletter-draft/`,
      "",
      "## Finance (1)",
      "",
      "- Weekly invoice summary: When asked for the week's invoices",
      `  Folder: ${K}/weekly-invoice-summary/`,
      "",
      "## Research (1)",
      "",
      "- Pip's own: Looks things up",
      `  Folder: ${K}/pip-s-own/`,
      "",
      "## Unsorted (1)",
      "",
      "- Water the plants: Every Monday, a reminder",
      `  Folder: ${K}/water-the-plants/`,
      "",
    ].join("\n"),
    "Pip shares Sam's computer: Pip's own is there too",
  );
  hear(c.text(`${K}/INDEX.md`));
  assert.equal(c.text(`${K}/bops-work-on-an-app/SKILL.md`), "---\nname: bops-work-on-an-app\ndescription: \"Read before you change an app: ingot status, diff and commit.\"\nmetadata: {label: Apps and source control}\n---\n\n# Work on an app with Ingot\n\n1. ingot clone <name>\n2. ingot commit -m <message>\n");
  assert.equal(c.text(`${K}/bops-work-on-an-app/examples/notes.md`), "Notes on apps.\n");
  assert.match(c.text(`${K}/inbox-sweep/SKILL.md`), /\nmetadata: \{label: Email, version: "0\.1\.0"\}\n/);
  assert.match(c.text(`${K}/weekly-invoice-summary/SKILL.md`), /\nmetadata: \{label: Finance, version: "0\.1\.0"\}\n/, "a published one carries its label");
  // Nothing changed: not copied again. A bot with none of its own: Bops' own and the index all the same.
  const n = c.calls.length;
  await W.copySkillsToComputer("sam", "c_sam", c.bash);
  assert.equal(c.calls.length, n, "the same: nothing sent");
  const none = fakeComputer();
  assert.equal(await W.copySkillsToComputer("nol", "c_nol", none.bash), 0, "none of its own went");
  assert.match(none.text(`${K}/INDEX.md`), /^# Skills, by label\n[\s\S]*\n## Apps and source control \(2\)\n[\s\S]*Folder: \/workspace\/capabilities\/skills\/bops-deploy-an-app\/\n$/);
  assert.ok(none.text(`${K}/bops-deploy-an-app/SKILL.md`));
  // On a computer's runner, which has a skill's files only where it made them (they're synced to the Mac): one
  // it hasn't leaves the folder as the Mac copied it, never cleared down to Bops' own.
  process.env.BOPS_RUNNER = "1";
  const ws = () => S.getState().workspaces.find((w) => w.id === "ws_small");
  S.update(() => ws().skills.push({ slug: "synced-elsewhere", kind: "skill", name: "Synced elsewhere", description: "Only on the Mac", label: "Other", status: "published", version: "0.1.0", botIds: [], source: "bops", createdAt: 9, updatedAt: 9 }));
  try {
    const runner = fakeComputer();
    assert.equal(await W.copySkillsToComputer("sam", "c_runner", runner.bash), 0);
    assert.deepEqual(runner.calls, [], "nothing sent, nothing cleared");
    S.update(() => (ws().skills = ws().skills.filter((r) => r.slug !== "synced-elsewhere")));
    await W.copySkillsToComputer("sam", "c_runner", runner.bash);
    assert.ok(runner.text(`${K}/inbox-sweep/SKILL.md`), "with every one there: copied as on the Mac");
  } finally {
    delete process.env.BOPS_RUNNER;
    S.update(() => (ws().skills = ws().skills.filter((r) => r.slug !== "synced-elsewhere")));
  }
});

await check("A brain thread's brief: INDEX.md first, then the label that fits, then the skill; one line per label", async () => {
  assert.equal(
    hear(W.skillsIndexNote("sam", "Tiger")),
    [
      "Your skills: how your workspace does jobs it was shown before, and Bops' own, as folders on your computer under labels. Before a job, read /workspace/capabilities/skills/INDEX.md first, open the label that fits the job there, then read that skill's SKILL.md in its folder and follow it. Tell Tiger if a step no longer works.",
      `- Apps and source control (3): Deploy checklist, and Bops' own: ${APPS_ABOUT}`,
      "- Email (2): Inbox sweep, Newsletter draft",
      "- Finance (1): Weekly invoice summary",
      "- Unsorted (1): Water the plants",
    ].join("\n"),
  );
  assert.equal(W.skillsIndexNote("nobody"), "");
  assert.match(W.skillsIndexNote("bea"), /\n\(6 more labels in INDEX\.md\.\)$/);
});

/* ---------------- Someone apps aren't open to ---------------- */

await check("Someone apps aren't open to (lib/apps-access.ts): Bops' own skills for apps aren't in their labels, read_skill, a brief or on a computer; the workspace's own keep their labels", async () => {
  const was = S.getState().account;
  S.update((s) => (s.account = { user: { id: "u_other", email: "tiger@example.com", name: "Tiger" }, signedInAt: 1 }));
  try {
    assert.deepEqual(W.skillGroups("sam"), [
      { label: "Email", about: "Inbox sweep, Newsletter draft", builtin: false, count: 2, slugs: ["inbox-sweep", "newsletter-draft"] },
      { label: L.APPS_LABEL, about: "Deploy checklist", builtin: false, count: 1, slugs: ["deploy-checklist"] },
      { label: "Finance", about: "Weekly invoice summary", builtin: false, count: 1, slugs: ["weekly-invoice-summary"] },
      { label: "Unsorted", about: "Water the plants", builtin: false, count: 1, slugs: ["water-the-plants"] },
    ]);
    assert.deepEqual(W.skillGroups("nol"), [], "a bot with none of its own has none");
    assert.match(hear(W.readSkill("sam", "bops-deploy-an-app")), /^No skill called "bops-deploy-an-app"\./);
    assert.match(hear(W.readSkill("nol", "Work on an app with Ingot")), /^No skill called "Work on an app with Ingot"\./);
    assert.ok(!W.skillsIndexNote("sam", "Tiger").includes("Bops' own:"), "the brief names none of them");
    const c = fakeComputer();
    await W.copySkillsToComputer("sam", "c_sam", c.bash);
    const K = "/workspace/capabilities/skills";
    assert.ok(c.text(`${K}/deploy-checklist/SKILL.md`), "the workspace's own go");
    assert.equal(c.text(`${K}/bops-work-on-an-app/SKILL.md`), undefined, "Bops' own for apps don't");
    assert.equal(c.text(`${K}/bops-deploy-an-app/SKILL.md`), undefined);
    assert.ok(!hear(c.text(`${K}/INDEX.md`) ?? "").includes("bops-"), "nor are they in INDEX.md");
    // One nobody gave a label (from before labels): deploy and git words don't put it under Bops' own label for apps.
    assert.equal(W.guessLabel("Ship the website", "Deploy the site after a commit"), L.UNSORTED);
    assert.equal(W.guessLabel("Fix the merge conflict", "In the GitHub repo, then email the team"), "Email", "its other words decide");
    S.update((s) => s.workspaces.find((w) => w.id === "ws_old").skills.push({ slug: "old-deploy", kind: "skill", name: "Deploy the website", description: "push to GitHub, deploy on Vercel", status: "published", version: "0.1.0", botIds: [], source: "bops", createdAt: 3, updatedAt: 7 }));
    assert.equal(W.refsOf("ws_old", "skill").find((r) => r.slug === "old-deploy").label, undefined, "Unsorted: no label kept");
    assert.equal(W.knownLabel("ws_old", "apps and source control"), "apps and source control", "nor spelled as Bops' own");
  } finally {
    S.update((s) => {
      s.account = was;
      const old = s.workspaces.find((w) => w.id === "ws_old");
      old.skills = old.skills.filter((r) => r.slug !== "old-deploy");
    });
  }
  assert.equal(W.skillGroups("nol")[0]?.label, L.APPS_LABEL, "back on @orgo.ai: there again");
});

/* ---------------- The real built-in skills ---------------- */

await check("lib/builtin-skills.ts, when it's there, is shaped as the harness reads it", async () => {
  if (!existsSync(`${root}/lib/builtin-skills.ts`)) return console.log("     (not there yet: skipped)");
  const R = await import(`${BUILTINS_URL}?real`);
  assert.ok(R.BUILTIN_LABELS.length && R.BUILTIN_SKILLS.length);
  assert.equal(R.BUILTIN_LABELS[0].label, L.APPS_LABEL, "the apps label first");
  for (const s of R.BUILTIN_SKILLS) {
    assert.ok(R.BUILTIN_LABELS.some((b) => L.sameLabel(b.label, s.label)), `${s.slug}: its label is one of BUILTIN_LABELS`);
    assert.match(s.slug, B.SLUG_RE);
    assert.ok(s.description.length <= B.BUNDLE_LIMITS.description, s.slug);
    for (const f of s.files ?? []) assert.ok(!("reason" in B.normalizePath(f.path)) && typeof f.content === "string", `${s.slug}: ${f.path}`);
  }
  assert.equal(new Set(R.BUILTIN_SKILLS.map((s) => s.slug)).size, R.BUILTIN_SKILLS.length, "slugs are unique");
  // Those for apps only where apps are open (lib/apps-access.ts); the stand in above does the same.
  assert.deepEqual(R.builtinSkills(true), R.BUILTIN_SKILLS);
  assert.deepEqual(R.builtinSkills(false).filter((s) => L.sameLabel(s.label, L.APPS_LABEL)), []);
  assert.deepEqual(R.builtinLabels(false).filter((b) => L.sameLabel(b.label, L.APPS_LABEL)), []);
});

await check("Plain words: nothing a bot reads has a dash; no stray warnings", async () => {
  for (const x of said) assert.ok(!/[–—]/.test(x), `no dashes: ${x.slice(0, 120)}`);
  assert.deepEqual(logged.filter((l) => /^\[skills\]/.test(l)), [], "no stray warnings");
  assert.deepEqual(rejections, []);
});

server.close();
console.log(`\nskill labels: ${passed} passed, ${failed} failed`);
if (!failed) rmSync(scratch, { recursive: true, force: true });
else console.log(`The throwaway folder is kept for a look: ${scratch}`);
process.exit(failed ? 1 : 0);
