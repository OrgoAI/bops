// Tests for Knowledge's Skills page grouped by label (components/app/skills.tsx, lib/skill-labels.ts):
// the skills under their labels, Bops' own labels first (lib/builtin-skills.ts) and marked Built in, then
// the workspace's, the most skills first, Other last; a workspace skill given one of Bops' labels sits in
// that label; each heading counts its skills; only the first two labels start open, then as this Mac
// remembers them (and with no storage at all, still the first two); a row is one line with Draft until
// it's published; one of Bops' own opens read only, its SKILL.md to read; a workspace skill opened has a
// label chip that opens the labels there are and New label, and moving it sends the update route a label.
//
// The .tsx files are compiled with the TypeScript in node_modules as they load, and rendered to HTML.
// Usage: node scripts/test-skills-ui-labels.mjs   (not with --conditions=react-server: these are client components)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

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
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (!url.endsWith(".tsx")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));

// A window, enough of one (nothing here runs effects: it's rendered to HTML). What this Mac remembers
// is `stored`, which a test fills; a storage that throws is tried too. Nothing reaches a server: fetch
// is a stub that keeps what it was sent.
const stored = new Map();
let storageThrows = false;
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = {
  getItem: (k) => {
    if (storageThrows) throw new Error("no storage");
    return stored.get(k) ?? null;
  },
  setItem: (k, v) => {
    if (storageThrows) throw new Error("no storage");
    stored.set(k, v);
  },
  removeItem: (k) => stored.delete(k),
};
globalThis.matchMedia = () => ({ matches: false });
const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url, body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, status: 200, json: async () => ({}) };
};

const Sk = await import(pathToFileURL(`${root}/components/app/skills.tsx`).href);
const L = await import(pathToFileURL(`${root}/lib/skill-labels.ts`).href);
const B = await import(pathToFileURL(`${root}/lib/builtin-skills.ts`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const noop = () => {};
/** Text as React writes it in HTML. */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/* ---------------- A workspace ---------------- */

const BUILT_LABELS = B.BUILTIN_LABELS.map((b) => L.cleanLabel(b.label));
const BUILT = B.BUILTIN_SKILLS;
const builtIn = (label) => BUILT.filter((s) => L.sameLabel(s.label, label));

let at = 1000;
const skill = (slug, label, extra = {}) => ({
  slug,
  kind: "skill",
  name: `Skill ${slug}`,
  description: `What ${slug} does and when`,
  ...(label === undefined ? {} : { label }),
  status: "published",
  version: "1",
  versions: [{ version: "1", at: 1, sha256: "a".repeat(64) }],
  botIds: [],
  source: "bops",
  createdAt: 1,
  updatedAt: at--,
  ...extra,
});

// Newest first, as skillsIn sorts them: Email has three (one spelled in lower case), Sales calls one,
// Billing one, two with no label (Other), and one given Bops' own apps label.
const SKILLS = [
  skill("reply", "Email"),
  skill("triage", "email"),
  skill("calls", "Sales calls"),
  skill("plain", undefined),
  skill("deploy-notes", L.APPS_LABEL),
  skill("digest", "  Email  "),
  skill("refunds", "Billing", { status: "draft", version: undefined, versions: [] }),
  skill("blank", ""),
];

// Signed in with an @orgo.ai email, so Bops' own skills for apps are listed (lib/apps-access.ts); a test
// at the end signs in as someone else, who sees none of them.
function world(skills = SKILLS) {
  return {
    account: { user: { id: "u1", name: "Tess Ito", email: "tess@orgo.ai" } },
    workspace: "ws_main",
    workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, skills, apps: [] }],
    bots: [{ id: "nova", name: "Nova", color: "#4F7BF7", role: "Helper" }],
    chats: [],
    routines: [],
    watches: [],
    sessions: [],
    messages: [],
    accounts: [],
  };
}

const render = (state = world(), extra = {}) => renderToStaticMarkup(h(Sk.SkillsPage, { state, only: "skill", onClose: noop, ...extra }));
const labelsIn = (html) => [...html.matchAll(/data-label="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
/** The HTML of one label's section, up to the next. */
const section = (html, label) => {
  const start = html.indexOf(`data-label="${label}"`);
  if (start < 0) return null;
  const next = html.indexOf("data-label=", start + 10);
  return html.slice(start, next < 0 ? undefined : next);
};
const heading = (part) => part.slice(0, part.indexOf("</button>"));
const rowsIn = (part) => [...part.matchAll(/title="([^"\n]+)\n/g)].map((m) => m[1]);

/* ---------------- Groups and their order ---------------- */

await test("Bops' own labels exist, the apps label first, each with skills to read", () => {
  assert.ok(BUILT_LABELS.length > 0, "at least one built-in label");
  assert.equal(BUILT_LABELS[0], L.APPS_LABEL, "Apps and source control first");
  for (const label of BUILT_LABELS) assert.ok(builtIn(label).length > 0, `${label} has skills`);
  for (const s of BUILT) assert.ok(s.slug && s.name && s.description && typeof s.body === "string" && s.body.trim(), `${s.slug} has a name, a description and a SKILL.md`);
});

await test("Groups: Bops' labels first, then the workspace's, the most skills first, then by name, Other last; one label whatever its case or spacing", () => {
  const groups = Sk.labelGroups(SKILLS);
  assert.deepEqual(groups.map((g) => g.label), [...BUILT_LABELS, "Email", "Billing", "Sales calls", "Other"]);
  assert.deepEqual(groups.map((g) => g.builtin), [...BUILT_LABELS.map(() => true), false, false, false, false]);
  const email = groups.find((g) => g.label === "Email");
  assert.deepEqual(email.slugs, ["reply", "triage", "digest"], "every spelling of Email, newest first");
  assert.equal(email.count, 3);
  assert.equal(email.about, "Skill reply, Skill triage, Skill digest", "a workspace label's about is its skills' names");
  assert.deepEqual(groups.at(-1).slugs, ["plain", "blank"], "no label and an empty one are Other");
  const apps = groups[0];
  assert.deepEqual(apps.slugs, [...builtIn(L.APPS_LABEL).map((s) => s.slug), "deploy-notes"], "a workspace skill with Bops' apps label sits in it, after Bops' own");
  assert.equal(apps.count, builtIn(L.APPS_LABEL).length + 1);
  assert.equal(apps.about, B.BUILTIN_LABELS[0].about, "a built-in label keeps its own about");
  // Apps have no built-in labels.
  assert.deepEqual(Sk.labelGroups([skill("a", "Tools", { kind: "app" })], false).map((g) => g.label), ["Tools"]);
  assert.deepEqual(Sk.labelGroups([]).map((g) => g.label), BUILT_LABELS, "no skills of the workspace's: Bops' own still there");
});

await test("The page: a heading per label in that order, with its count, Built in on Bops' own only", () => {
  stored.clear();
  const html = render();
  assert.deepEqual(labelsIn(html), [...BUILT_LABELS, "Email", "Billing", "Sales calls", "Other"]);
  for (const label of BUILT_LABELS) {
    const head = heading(section(html, label));
    assert.match(head, />Built in</, `${label} says Built in`);
    assert.match(head, /data-tip="[^"]+"/, "what its skills are for, in its tooltip");
  }
  for (const label of ["Email", "Billing", "Sales calls", "Other"]) assert.ok(!heading(section(html, label)).includes("Built in"), `${label} isn't built in`);
  assert.match(heading(section(html, "Email")), /aria-label="Email, 3 skills"/);
  assert.match(heading(section(html, "Email")), /tabular-nums[^>]*>3</, "the count beside the name");
  assert.match(heading(section(html, "Billing")), /aria-label="Billing, 1 skill"/);
  assert.match(heading(section(html, L.APPS_LABEL)), new RegExp(`aria-label="${L.APPS_LABEL}, ${builtIn(L.APPS_LABEL).length + 1} skills, built in"`));
  assert.ok(!html.includes("—") && !html.includes("–"), "no dashes in the copy");
});

await test("Folds: the first two labels open, the rest folded until opened; then as this Mac remembers it", () => {
  stored.clear();
  const order = [...BUILT_LABELS, "Email", "Billing", "Sales calls", "Other"];
  let html = render();
  const expanded = (label) => /aria-expanded="true"/.test(heading(section(html, label)));
  assert.deepEqual(order.map(expanded), order.map((_, i) => i < Sk.OPEN_LABELS));
  const firstOpen = order[0];
  assert.ok(rowsIn(section(html, firstOpen)).length > 0, "an open label lists its rows");
  assert.deepEqual(rowsIn(section(html, "Other")), [], "a folded one has none until it first opens");
  // Folded and opened on this Mac, per account and workspace.
  stored.set(`bops.skills.open.u1.ws_main.${firstOpen.toLowerCase()}`, "0");
  stored.set("bops.skills.open.u1.ws_main.other", "1");
  html = render();
  assert.equal(expanded(firstOpen), false, "the user folded it");
  assert.equal(expanded("Other"), true, "the user opened it");
  assert.deepEqual(rowsIn(section(html, "Other")), ["Skill plain", "Skill blank"]);
  // Another workspace's (or account's) aren't these.
  html = render({ ...world(), account: { user: { id: "u2", name: "Ida", email: "ida@orgo.ai" } } });
  assert.equal(expanded("Other"), false);
  // No storage at all: it still renders, the first two open.
  storageThrows = true;
  html = render();
  storageThrows = false;
  assert.deepEqual(order.map(expanded), order.map((_, i) => i < Sk.OPEN_LABELS));
  stored.clear();
});

await test("Rows: one line each, its name and what it does, all of it in the tooltip, Draft until it's published", () => {
  stored.clear();
  for (const label of ["Email", "Billing"]) stored.set(`bops.skills.open.u1.ws_main.${label.toLowerCase()}`, "1");
  const html = render();
  const email = section(html, "Email");
  assert.deepEqual(rowsIn(email), ["Skill reply", "Skill triage", "Skill digest"]);
  assert.match(email, /title="Skill reply\nWhat reply does and when"/);
  assert.match(email, /class="max-w-\[45%\] shrink-0 truncate[^"]*">Skill reply</, "the name on one line, cut short");
  assert.match(email, /class="min-w-0 flex-1 truncate[^"]*">What reply does and when</, "what it does beside it, cut short");
  assert.ok(!email.includes(">Draft<"), "published: no chip");
  assert.match(section(html, "Billing"), />Draft</, "a draft says so");
  assert.ok(!html.includes(">v1<"), "no version chips on the rows");
  stored.clear();
});

await test("No skills of the workspace's: Bops' own labels still there, and a line on making one", () => {
  stored.clear();
  const html = render(world([]));
  assert.deepEqual(labelsIn(html), BUILT_LABELS);
  assert.match(html, /No skills of your own yet\. Save one from a chat’s menu\./);
});

/* ---------------- Bops' own, read only ---------------- */

await test("One of Bops' own opens read only: Built in, its label, its SKILL.md to read, nothing to change", () => {
  const s = builtIn(L.APPS_LABEL)[0];
  const html = render(world(), { focus: `builtin:${s.slug}` });
  assert.ok(html.includes(`>${esc(s.name)}<`), "its name");
  assert.ok(html.includes(esc(s.description)), "what it does");
  assert.match(html, />Built in</);
  assert.match(html, new RegExp(`>${L.APPS_LABEL}<`), "its label, as plain text");
  assert.match(html, /Every bot has it\. It comes with Bops, so it can&#x27;t be changed here\./);
  assert.ok(html.includes(renderToStaticMarkup(h(Sk.SkillMarkdown, { text: s.body }))), "its SKILL.md, all of it");
  for (const word of [">Delete<", ">Publish", ">Open in Finder<", "aria-haspopup", ">Bots<", ">Versions<"]) assert.ok(!html.includes(word), `no ${word}`);
  assert.ok(!html.includes("data-label="), "the list is gone while it's open");
  // One with files beside its SKILL.md lists them, each to view; none to approve, nothing to change.
  const withFiles = BUILT.find((x) => x.files?.length);
  if (withFiles) {
    const page = render(world(), { focus: `builtin:${withFiles.slug}` });
    assert.match(page, />Files</);
    for (const f of withFiles.files) assert.ok(page.includes(`>${esc(f.path)}<`), `${f.path} listed`);
    assert.equal(page.match(/>View</g)?.length, withFiles.files.length, "each to view");
    assert.ok(!page.includes(esc(withFiles.files[0].content)), "shut until viewed");
    for (const word of [">Approve", ">Review<", ">Delete<"]) assert.ok(!page.includes(word), `no ${word}`);
  }
});

/* ---------------- The label chip ---------------- */

await test("A workspace skill opened: its label as a chip that opens the labels; one with none says Other", () => {
  let html = render(world(), { focus: "skill:triage" });
  assert.match(html, /aria-haspopup="menu" aria-expanded="false" aria-label="Label: Email\. Change it" data-label-chip="Email"/, "the cleaned label, not its spelling");
  assert.match(html, />Delete</, "a workspace skill can still be changed");
  html = render(world(), { focus: "skill:plain" });
  assert.match(html, /data-label-chip="Other"/);
});

await test("The picker: every label there is, the skill's own checked, Other, then New label; a move sends the update route its label", () => {
  const labels = Sk.labelChoices(SKILLS);
  assert.deepEqual(labels, [...BUILT_LABELS, "Email", "Billing", "Sales calls", "Other"]);
  assert.deepEqual(Sk.labelChoices([skill("x", "Email")]), [...BUILT_LABELS, "Email", "Other"], "Other is always a choice");
  const html = renderToStaticMarkup(h(Sk.LabelMenu, { current: "email", labels, onPick: noop, onClose: noop }));
  assert.deepEqual([...html.matchAll(/role="menuitemradio" aria-checked="(true|false)"[^>]*><span[^>]*>([^<]+)</g)].map((m) => [m[2].replace(/&amp;/g, "&"), m[1]]), labels.map((l) => [l, String(l === "Email")]));
  assert.match(html, /role="menuitem"[^>]*>New label</);
  assert.ok(html.indexOf(">New label<") > html.lastIndexOf("menuitemradio"), "New label after the labels");
  assert.deepEqual(Sk.labelEdit("  Sales   calls "), { action: "update", edit: { label: "Sales calls" } }, "cleaned before it's sent");
  assert.deepEqual(Sk.labelEdit(""), { action: "update", edit: { label: "Other" } });
  assert.equal(Sk.labelEdit("x".repeat(80)).edit.label.length, L.SKILL_LABEL_MAX);
  assert.equal(sent.length, 0, "rendering sends nothing");
});

/* ---------------- Someone apps aren't open to ---------------- */

await test("Someone apps aren't open to (lib/apps-access.ts): none of Bops' own skills for apps, nor their label to pick; a skill they gave that label keeps it", () => {
  stored.clear();
  const other = { ...world(), account: { user: { id: "u3", name: "Sam", email: "sam@example.com" } } };
  const html = render(other);
  assert.deepEqual(labelsIn(html), ["Email", L.APPS_LABEL, "Billing", "Sales calls", "Other"], "the workspace's labels only, the apps one for its own skill");
  for (const s of BUILT) assert.ok(!html.includes(esc(s.name)), `no ${s.slug}`);
  assert.ok(!html.includes(">Built in<"), "no Built in chip");
  assert.deepEqual(Sk.labelGroups(SKILLS, true, false).map((g) => [g.label, g.builtin, g.builtins.length]), [
    ["Email", false, 0],
    [L.APPS_LABEL, false, 0],
    ["Billing", false, 0],
    ["Sales calls", false, 0],
    ["Other", false, 0],
  ]);
  assert.deepEqual(Sk.labelChoices([skill("x", "Email")], false), ["Email", "Other"], "nothing of Bops' own to move one to");
  // One of Bops' own asked for by name doesn't open.
  assert.ok(!render(other, { focus: `builtin:${BUILT[0].slug}` }).includes(esc(BUILT[0].name)));
  stored.clear();
});

console.log(`\nskills ui labels: ${passed} passed`);
