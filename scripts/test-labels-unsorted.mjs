// Tests for Unsorted, Bops' label suggestions and a label renamed in one step (lib/skill-labels.ts,
// lib/server/skill-bundle.ts, lib/server/workspace-skills.ts, lib/server/skill-label-model.ts, app/api/skills):
// Unsorted is no label (none, empty, "Other" or "Unsorted" in any case), never kept as one in the state, a
// SKILL.md or Orgo's column, and a skill kept as "Other" before is Unsorted; a skill nobody gave a label gets
// Bops' suggestion (labelBy "auto"), from its words, then one model call for the skills made within a couple of
// seconds (one new label a call at most; off, offline or no answer: the label from its words), kept out of its
// SKILL.md and Orgo until it's confirmed, changed or published; the model's call itself (the LIGHT model, not
// stored, a strict schema, low effort); and a rename: here at once (every skill's label and SKILL.md), then
// orgo-web's POST …/skill-labels/rename once, no skill sent on its own, kept on disk while Orgo is away and sent
// at the next start, each skill on its own from an orgo-web without the route, to Unsorted as none, and from
// Unsorted on its own while suggestions there aren't Orgo's. OpenAI and orgo-web are fakes (fetch answered
// here), the Keychain is never there, and the state and folders live in a throwaway folder: nothing reaches a
// real service. The keys in it are made up.
// Usage: node --conditions=react-server scripts/test-labels-unsorted.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-labels-unsorted";
const UI = "ui-token-test-labels-unsorted";
process.env.BOPS_UI_TOKEN = UI;
process.env.BOPS_ORGO_ORIGIN = "http://orgo.test";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-labels-unsorted-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const ORGO_KEY = "sk_orgo_test_labels_unsorted";
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

/* ---------------- Fakes: OpenAI and orgo-web ---------------- */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const asked = [];
const answers = [];

/**
 * orgo-web with the label column, the skill-labels route and its rename (`rename`: the status the rename answers,
 * 200 doing it: every skill of the project under `from`, any case, Unsorted for none, gets `to`, null for Unsorted,
 * no new version; the row renamed or merged). Every call is kept.
 */
const orgo = { calls: [], skills: [], seq: 0, labels: [], rename: 200 };
const now = () => new Date(Date.now() + ++orgo.seq).toISOString();
const view = (s) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description, type: s.type, status: s.status, bot_ids: s.bot_ids, updated_at: s.updated_at, current_version: s.version ? { version: s.version } : null, label: s.label ?? null });
const labelIn = (md) => /\nmetadata: \{[^}]*label: ([^,}]+)/.exec(md ?? "")?.[1]?.trim();
const unsorted = (l) => !l || /^(unsorted|other)$/i.test(String(l).trim());
const same = (a, b) => (unsorted(a) ? "" : String(a).trim().toLowerCase()) === (unsorted(b) ? "" : String(b).trim().toLowerCase());
async function fakeOrgo(req, url) {
  const body = req.method === "GET" || req.method === "DELETE" ? undefined : JSON.parse((await req.text()) || "null");
  orgo.calls.push({ method: req.method, path: url.pathname, body });
  if (req.headers.get("authorization") !== `Bearer ${ORGO_KEY}`) return json({ error: "Not authenticated" }, 401);
  if (/^\/api\/projects\/[^/]+\/bops$/.test(url.pathname)) return json({ kinds: [] });
  if (/^\/api\/projects\/[^/]+\/skill-labels\/rename$/.test(url.pathname)) {
    if (orgo.rename !== 200) return orgo.rename === 404 ? new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } }) : json({ error: "Not now" }, orgo.rename);
    const to = unsorted(body.to) ? null : body.to.replace(/\s+/g, " ").trim().slice(0, 40);
    let moved = 0;
    for (const s of orgo.skills)
      if (same(s.label, body.from)) {
        s.label = to;
        s.updated_at = now();
        moved++;
      }
    const row = orgo.labels.find((x) => same(x.name, body.from));
    const there = orgo.labels.find((x) => x !== row && same(x.name, to));
    if (row && to && !there) row.name = to;
    else if (row) orgo.labels = orgo.labels.filter((x) => x !== row).map((x) => (x === there && !x.about ? { ...x, about: row.about } : x));
    return json({ moved, label: to });
  }
  if (/^\/api\/projects\/[^/]+\/skill-labels$/.test(url.pathname)) {
    if (req.method === "PUT") orgo.labels = body.labels;
    return json({ labels: orgo.labels });
  }
  const m = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/skills(?:\/([^/]+))?(?:\/(versions|export))?$/);
  if (!m) return new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } });
  const [, , sid, sub] = m;
  if (sid === "approvals") return json({ approvals: [] });
  if (!sid && req.method === "GET") return json({ skills: orgo.skills.map(view) });
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
    if (labelIn(body.body)) s.label = labelIn(body.body);
    return json({ skill: view(s) }, 201);
  }
  if (req.method === "PATCH") {
    Object.assign(s, { ...(body.name ? { name: body.name } : {}), ...(body.bot_ids ? { bot_ids: body.bot_ids } : {}), ...(body.status ? { status: body.status } : {}), updated_at: now() });
    if ("label" in body) s.label = body.label;
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
    const text = answers.shift()?.(b) ?? '{"skills":[]}';
    return json({ id: `resp_${asked.length}`, object: "response", model: b.model, status: "completed", output: [{ id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 50, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
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
const heard = [];
const hear = (x) => (heard.push(typeof x === "string" ? x : JSON.stringify(x)), x);

const S = await import(`${root}/lib/server/store.ts`);
const W = await import(`${root}/lib/server/workspace-skills.ts`);
const B = await import(`${root}/lib/server/skill-bundle.ts`);
const L = await import(`${root}/lib/skill-labels.ts`);
const O = await import(`${root}/lib/server/sync-outbox.ts`);
const M = await import(`${root}/lib/server/skill-label-model.ts`);
const Route = await import(`${root}/app/api/skills/route.ts`);
clearInterval(globalThis.__bopsRoutines);
const route = async (body) => {
  const res = await Route.POST(new Request("http://localhost:3210/api/skills", { method: "POST", headers: { "content-type": "application/json", "x-bops-window": UI }, body: JSON.stringify(body) }));
  return { status: res.status, body: hear(await res.json()) };
};

S.update((s) => {
  s.owner = { name: "Alex" };
  s.account = { user: { id: "u_alex", email: "alex@example.com", name: "Alex" }, signedInAt: 1 };
  s.workspaces = [
    { id: "ws_local", name: "Local", createdAt: 0 },
    { id: "ws_a", name: "Acme", createdAt: 1, orgoProjectId: "p_a" },
  ];
  s.bots.push({ id: "ana", name: "Ana", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", workspaceId: "ws_a" }, { id: "lou", name: "Lou", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", workspaceId: "ws_local" });
});
const wsDir = (ws) => join(process.cwd(), ".data", "workspaces", S.getState().workspaces.find((w) => w.id === ws)?.orgoProjectId ?? ws);
const skillMd = (ws, slug) => readFileSync(join(wsDir(ws), "skills", slug, "SKILL.md"), "utf8");
const ref = (ws, slug) => W.findRef(ws, "skill", slug);
const make = (ws, name, description, extra = {}) => W.createSkill(ws, { name, description, body: `# ${name}\n\n1. Do it.\n`, ...extra }).ref;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const since = (mark) => orgo.calls.slice(mark);
const remote = (slug) => orgo.skills.find((x) => x.slug === slug);
const batches = () => globalThis.bopsLabelSuggest;

/* ---------------- Unsorted is no label ---------------- */

await check("Unsorted is no label: none, empty, Other or Unsorted in any case; never kept in a SKILL.md", async () => {
  for (const v of [undefined, null, "", "  ", "Other", "other", " OTHER ", "Unsorted", "unsorted"]) {
    assert.equal(L.isUnsorted(v), true, String(v));
    assert.equal(L.cleanLabel(v), "Unsorted");
    assert.equal(L.keptLabel(v), undefined);
  }
  assert.equal(L.keptLabel("  Sales   calls "), "Sales calls");
  assert.equal(L.isUnsorted("Others"), false, "only the word itself");
  assert.ok(L.sameLabel("Other", "Unsorted"));
  // A SKILL.md that says Other or Unsorted has no label; one written says none.
  assert.equal(B.labelOf(B.parseSkillMd("---\nname: x\ndescription: X\nmetadata:\n  label: Other\n---\n").frontmatter), undefined);
  assert.equal(B.labelOf({ metadata: { label: "unsorted" } }), undefined);
  assert.deepEqual(B.withLabel({ name: "x", metadata: { label: "Email", owner: "sam" } }, "Unsorted"), { name: "x", metadata: { owner: "sam" } });
  assert.deepEqual(B.toSpecForm({ name: "x", label: "Other" }), { name: "x" }, "an old top level Other isn't moved into metadata");
  assert.deepEqual(B.withLabel({ name: "x" }, undefined), { name: "x" }, "no label given: as it was");
});

await check("Kept as Other or Unsorted before: Unsorted, no label, from now on; one from before labels gets a suggestion from its words", async () => {
  S.update((s) => {
    s.workspaces.find((w) => w.id === "ws_local").skills = [
      { slug: "old-other", kind: "skill", name: "Plants", description: "Water them", label: "Other", status: "draft", botIds: [], source: "bops", createdAt: 1, updatedAt: 1 },
      { slug: "old-unsorted", kind: "skill", name: "Misc", description: "Things", label: "unsorted", status: "draft", botIds: [], source: "bops", createdAt: 2, updatedAt: 2 },
      { slug: "old-none", kind: "skill", name: "Inbox sweep", description: "Sort the Gmail inbox", status: "draft", botIds: [], source: "bops", createdAt: 3, updatedAt: 3 },
    ];
  });
  const [other, uns, none] = W.refsOf("ws_local", "skill");
  assert.equal(other.label, undefined);
  assert.equal(uns.label, undefined);
  assert.equal(other.labelBy, "user", "decided: not looked at again");
  assert.deepEqual([none.label, none.labelBy], ["Email", "auto"]);
  assert.deepEqual(W.workspaceLabels("ws_local"), ["Email", "Unsorted"], "listed as Unsorted, last");
});

/* ---------------- Suggestions ---------------- */

await check("A new skill: its own label, the skill's; none: Bops' suggestion from its words, kept out of its SKILL.md and Orgo until confirmed", async () => {
  const mark = orgo.calls.length;
  // Bops' words decide only while the workspace has no labels of its own, so these two come first.
  const guess = make("ws_a", "Inbox sweep", "Sort the Gmail inbox each morning");
  assert.deepEqual([guess.label, guess.labelBy], ["Email", "auto"]);
  const pub = make("ws_a", "Invoice run", "Send the invoices on Friday");
  assert.deepEqual([pub.label, pub.labelBy], ["Finance", "auto"]);
  const given = make("ws_a", "Deal notes", "Notes after a call", { label: "Ops" });
  assert.deepEqual([given.label, given.labelBy], ["Ops", "skill"]);
  assert.doesNotMatch(skillMd("ws_a", "inbox-sweep"), /label/, "not in its SKILL.md");
  await W.syncSkills("ws_a");
  assert.equal(remote("inbox-sweep").label, null, "Orgo has it as Unsorted");
  assert.doesNotMatch(remote("inbox-sweep").body, /label/, "nor in Orgo's SKILL.md");
  assert.equal(remote("deal-notes").label, "Ops");
  // Confirm: the same label, as the owner's: in its SKILL.md and Orgo's column now.
  W.updateSkill("ws_a", "skill", "inbox-sweep", { label: "Email" });
  assert.deepEqual([ref("ws_a", "inbox-sweep").label, ref("ws_a", "inbox-sweep").labelBy], ["Email", "user"]);
  assert.match(skillMd("ws_a", "inbox-sweep"), /metadata: \{label: Email\}/);
  await W.syncSkills("ws_a");
  assert.equal(remote("inbox-sweep").label, "Email");
  assert.ok(since(mark).some((c) => c.method === "PATCH" && c.body?.label === "Email"));
  // Moved to Unsorted: none anywhere.
  W.updateSkill("ws_a", "skill", "inbox-sweep", { label: "unsorted" });
  assert.equal(ref("ws_a", "inbox-sweep").label, undefined);
  assert.doesNotMatch(skillMd("ws_a", "inbox-sweep"), /label/);
  await W.syncSkills("ws_a");
  assert.equal(remote("inbox-sweep").label, null);
  // Published, a suggestion is the owner's: in the version and Orgo's column.
  W.publishSkill("ws_a", "skill", "invoice-run");
  assert.equal(ref("ws_a", "invoice-run").labelBy, "user");
  await W.syncSkills("ws_a");
  assert.equal(remote("invoice-run").label, "Finance");
  batches()?.clear();
});

await check("The model: skills made within a couple of seconds in one call, among the workspace's own labels (no presets beside them), one new label at most; a label chosen meanwhile stays", async () => {
  const calls = [];
  W.labelSuggestForTests.ask = async (skills, labels) => {
    calls.push({ skills, labels });
    return new Map([
      [0, "ops"],
      [1, "Plant care"],
      [2, "Another new one"],
      [3, "Calendar"],
    ]);
  };
  try {
    make("ws_a", "Rotate keys", "Every quarter");
    make("ws_a", "Water plants", "Every Monday");
    make("ws_a", "Feed the fish", "Twice a day");
    make("ws_a", "Lunch order", "Order for the team");
    // Each new one joins the same call; one with words that place it and a workspace with labels of its own joins too.
    make("ws_a", "Book a meeting", "Find a time on the calendar");
    assert.equal(batches().get("ws_a").keys.size, 5, "one batch");
    W.updateSkill("ws_a", "skill", "lunch-order", { label: "Food" });
    await W.labelSuggestForTests.run("ws_a");
    assert.equal(calls.length, 1, "one call");
    assert.deepEqual(calls[0].skills.map((x) => x.name), ["Rotate keys", "Water plants", "Feed the fish", "Book a meeting"], "the one chosen meanwhile isn't asked");
    assert.ok(calls[0].labels.includes("Ops") && calls[0].labels.includes("Food"), "the workspace's own");
    assert.ok(!calls[0].labels.includes("Email") && !calls[0].labels.includes("Calendar"), "no preset beside them");
    assert.ok(!calls[0].labels.some((l) => L.isUnsorted(l)), "never Unsorted as a label to pick");
    assert.deepEqual([ref("ws_a", "rotate-keys").label, ref("ws_a", "rotate-keys").labelBy], ["Ops", "auto"], "spelled as the workspace has it");
    assert.deepEqual([ref("ws_a", "water-plants").label, ref("ws_a", "water-plants").labelBy], ["Plant care", "auto"], "one new label");
    assert.equal(ref("ws_a", "feed-the-fish").label, undefined, "a second new one isn't taken");
    assert.equal(ref("ws_a", "lunch-order").label, "Food");
    assert.deepEqual([ref("ws_a", "book-a-meeting").label, ref("ws_a", "book-a-meeting").labelBy], [undefined, "auto"], "Calendar isn't the workspace's, and a second new label isn't taken");
    assert.doesNotMatch(skillMd("ws_a", "water-plants"), /label/, "a suggestion stays out of its SKILL.md");
    await W.syncSkills("ws_a");
    assert.equal(remote("water-plants").label, null, "and out of Orgo");
    // Off: no call; the label from its words, or none.
    assert.equal((await route({ ws: "ws_a", action: "label-suggest", on: false })).body.on, false);
    assert.equal(S.getState().workspaces.find((w) => w.id === "ws_a").skillLabelsAIOff, true);
    make("ws_a", "Sweep the porch", "Saturdays");
    assert.equal(batches().get("ws_a"), undefined, "nothing waits for a call");
    assert.equal(ref("ws_a", "sweep-the-porch").label, undefined);
    assert.equal((await route({ ws: "ws_a", action: "label-suggest", on: true })).body.on, true);
    assert.equal(S.getState().workspaces.find((w) => w.id === "ws_a").skillLabelsAIOff, undefined, "on is the default, unset");
    // No answer (offline, out of credit): each keeps what it had.
    W.labelSuggestForTests.ask = async () => null;
    make("ws_a", "Tweet the launch", "Post on Twitter");
    await W.labelSuggestForTests.run("ws_a");
    assert.deepEqual([ref("ws_a", "tweet-the-launch").label, ref("ws_a", "tweet-the-launch").labelBy], [undefined, "auto"], "no preset from its words where the workspace has labels of its own: Unsorted");
  } finally {
    W.labelSuggestForTests.ask = undefined;
    batches()?.clear();
  }
  // Without Bops Cloud (self hosted here) the model isn't asked at all: the words decide.
  const before = asked.length;
  make("ws_a", "Clean the garage", "Once a month");
  await W.labelSuggestForTests.run("ws_a");
  assert.equal(asked.length, before);
  assert.equal(ref("ws_a", "clean-the-garage").label, undefined);
});

await check("The model's call: the LIGHT model, not stored, a strict schema, low effort; each answer by its place; a bad answer is none", async () => {
  answers.push(() => JSON.stringify({ skills: [{ i: 0, label: "Ops" }, { i: 1, label: "Hiring" }, { i: 7, label: "Nope" }] }));
  const got = await M.pickLabels([{ i: 0, name: "Rotate keys", description: "Every quarter" }, { i: 1, name: "Phone screens", description: "First calls" }], ["Ops", "Email"]);
  assert.deepEqual([...got], [[0, "Ops"], [1, "Hiring"]], "one outside the batch is left out");
  const b = asked.at(-1);
  assert.equal(b.model, "gpt-6-luna");
  assert.equal(b.store, false);
  assert.deepEqual(b.reasoning, { effort: "low" });
  assert.equal(b.text.format.type, "json_schema");
  assert.equal(b.text.format.strict, true);
  assert.deepEqual(JSON.parse(b.input).labels, ["Ops", "Email"]);
  assert.doesNotMatch(b.instructions, /[‒–—―]/);
  answers.push(() => "not json");
  assert.equal(await M.pickLabels([{ i: 0, name: "x", description: "y" }], []), null);
  logged.splice(0, logged.length, ...logged.filter((l) => !/labels from a model/.test(l)));
});

await check("A new label from the model with a dash as punctuation isn't taken; an app gets no suggestion at all", async () => {
  W.labelSuggestForTests.ask = async () => new Map([[0, "Chairs \u2014 tables"]]);
  try {
    make("ws_a", "Count the chairs", "Before the party");
    await W.labelSuggestForTests.run("ws_a");
    assert.deepEqual([ref("ws_a", "count-the-chairs").label, ref("ws_a", "count-the-chairs").labelBy], [undefined, "auto"]);
  } finally {
    W.labelSuggestForTests.ask = undefined;
    batches()?.clear();
  }
  // An app's label is changed nowhere in Skills: one naming none is Unsorted, decided, and no model is asked.
  const app = W.createSkill("ws_local", { kind: "app", name: "Inbox app", description: "Sort the Gmail inbox", body: "# Inbox app\n" }).ref;
  assert.deepEqual([app.label, app.labelBy], [undefined, "skill"]);
  assert.equal(batches()?.get("ws_local"), undefined);
});

/* ---------------- A label renamed ---------------- */

await check("Rename: here at once (every skill's label and SKILL.md, its bots, its line), then Orgo's rename once, no skill sent on its own, no new version", async () => {
  make("ws_a", "Server check", "Look at the servers", { label: "Ops" });
  W.publishSkill("ws_a", "skill", "server-check");
  W.setLabelAbout("ws_a", "Ops", "Keeping things running");
  S.update((s) => (s.bots.find((b) => b.id === "ana").skillLabels = ["Ops", "Email"]));
  await W.syncSkills("ws_a");
  const versions = orgo.skills.map((x) => x.version);
  // A draft in a published skill's folder, and a draft skill's folder edited: neither sent to Orgo (only a version is).
  const draft = (slug, to) => writeFileSync(join(wsDir("ws_a"), "skills", slug, "SKILL.md"), skillMd("ws_a", slug).replace("1. Do it.", to));
  draft("server-check", "1. Do it better, v2 draft.");
  draft("deal-notes", "1. Do it, with notes.");
  const mark = orgo.calls.length;
  const moved = hear(await route({ ws: "ws_a", action: "label-rename", from: "ops", to: "Operations" })).body.moved;
  assert.equal(moved, 3, "Deal notes, Server check and the suggestion Rotate keys");
  assert.equal(ref("ws_a", "deal-notes").label, "Operations");
  assert.match(skillMd("ws_a", "deal-notes"), /label: Operations/);
  assert.deepEqual([ref("ws_a", "rotate-keys").label, ref("ws_a", "rotate-keys").labelBy], ["Operations", "auto"], "a suggestion stays one");
  assert.doesNotMatch(skillMd("ws_a", "rotate-keys"), /label/);
  assert.deepEqual(S.getState().bots.find((b) => b.id === "ana").skillLabels, ["Operations", "Email"]);
  assert.equal(S.getState().workspaces.find((w) => w.id === "ws_a").skillLabelInfo.find((x) => x.name === "Operations")?.about, "Keeping things running");
  await W.syncSkills("ws_a");
  const renames = since(mark).filter((c) => c.path === "/api/projects/p_a/skill-labels/rename");
  assert.deepEqual(renames.map((c) => c.body), [{ from: "Ops", to: "Operations" }], "once");
  assert.ok(!since(mark).some((c) => c.method === "PATCH" && "label" in (c.body ?? {})), "no skill on its own");
  assert.equal(remote("deal-notes").label, "Operations");
  assert.equal(remote("rotate-keys").label, null, "Orgo never had the suggestion");
  assert.deepEqual(orgo.skills.map((x) => x.version), versions, "no new version");
  assert.equal(ref("ws_a", "deal-notes").label, "Operations", "the pull after keeps it");
  assert.equal(orgo.labels.find((x) => x.name === "Operations")?.about, "Keeping things running");
  // Orgo's new updated_at for each skill it moved is taken from its list: nothing is pulled over a folder.
  assert.ok(!since(mark).some((c) => c.path.endsWith("/export")), "no skill brought from Orgo");
  assert.match(skillMd("ws_a", "server-check"), /1\. Do it better, v2 draft\./, "the folder draft is kept");
  assert.match(skillMd("ws_a", "deal-notes"), /1\. Do it, with notes\./);
  assert.match(skillMd("ws_a", "deal-notes"), /label: Operations/);
  assert.equal(ref("ws_a", "server-check").remoteAt, remote("server-check").updated_at);
});

await check("Unsorted has no line of its own: refused here (Orgo keeps no row for it), so none is lost at the next sync", async () => {
  for (const l of ["Unsorted", "other"]) assert.throws(() => W.setLabelAbout("ws_a", l, "Things nobody sorted"), /no line of its own/);
  const r = await route({ ws: "ws_a", action: "label-about", label: "Unsorted", about: "Things nobody sorted" });
  assert.equal(r.status, 400);
  assert.ok(!S.getState().workspaces.find((w) => w.id === "ws_a").skillLabelInfo.some((x) => L.isUnsorted(x.name)));
});

await check("Orgo away: the rename waits on disk (later ones behind it), nothing sent on its own meanwhile, and goes at the next start", async () => {
  orgo.rename = 503;
  const mark = orgo.calls.length;
  W.renameLabel("ws_a", "Operations", "Ops team");
  await W.syncSkills("ws_a");
  assert.equal(ref("ws_a", "deal-notes").label, "Ops team", "here at once");
  assert.equal(remote("deal-notes").label, "Operations", "not there yet");
  assert.ok(!since(mark).some((c) => c.method === "PATCH" && "label" in (c.body ?? {})), "the rename carries it: no PATCH of its own");
  O.outboxForTests.writeAll();
  const file = join(process.cwd(), ".data", "outbox", "skill-label-renames.json");
  assert.ok(existsSync(file));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).entries.map((e) => e.item), [{ pid: "p_a", from: "Operations", to: "Ops team" }]);
  // A restart, Orgo back: sent once, the skills there move.
  O.outboxForTests.restart();
  orgo.rename = 200;
  W.skillDeletesOnStart();
  for (let i = 0; i < 50 && remote("deal-notes").label !== "Ops team"; i++) await sleep(20);
  assert.equal(remote("deal-notes").label, "Ops team");
  assert.equal(remote("server-check").label, "Ops team");
  O.outboxForTests.writeAll();
  assert.ok(!existsSync(file), "nothing left waiting");
});

await check("An orgo-web without the rename route (404): each skill moved goes on its own with the next sync, and later ones don't ask again", async () => {
  orgo.rename = 404;
  const mark = orgo.calls.length;
  W.renameLabel("ws_a", "Ops team", "Infra");
  await W.syncSkills("ws_a");
  const patched = since(mark).filter((c) => c.method === "PATCH" && c.body?.label === "Infra");
  assert.equal(patched.length, 2, "Deal notes and Server check, each with its label");
  assert.equal(remote("deal-notes").label, "Infra");
  assert.equal(remote("rotate-keys").label, null, "the suggestion still isn't sent");
  const mark2 = orgo.calls.length;
  W.renameLabel("ws_a", "Infra", "Platform");
  await W.syncSkills("ws_a");
  assert.ok(!since(mark2).some((c) => c.path.endsWith("/skill-labels/rename")), "not asked again");
  assert.equal(remote("server-check").label, "Platform");
  globalThis.bopsSkillLabelRename?.clear();
  orgo.rename = 200;
});

await check("To Unsorted: its skills have none, here and on Orgo; from Unsorted while suggestions are there on Orgo: each skill on its own", async () => {
  const mark = orgo.calls.length;
  W.renameLabel("ws_a", "Platform", "Unsorted");
  await W.syncSkills("ws_a");
  assert.equal(ref("ws_a", "deal-notes").label, undefined);
  assert.doesNotMatch(skillMd("ws_a", "deal-notes"), /label/);
  assert.deepEqual(since(mark).filter((c) => c.path.endsWith("/skill-labels/rename")).map((c) => c.body), [{ from: "Platform", to: "Unsorted" }]);
  assert.equal(remote("deal-notes").label, null);
  assert.ok(!S.getState().workspaces.find((w) => w.id === "ws_a").skillLabelInfo.some((x) => L.isUnsorted(x.name)), "Unsorted keeps no row");
  // Water plants is a suggestion here (Plant care) and Unsorted on Orgo: Orgo's rename of Unsorted would move it, so each goes on its own.
  const mark2 = orgo.calls.length;
  const moved = W.renameLabel("ws_a", "Unsorted", "Admin");
  await W.syncSkills("ws_a");
  assert.ok(moved >= 2);
  assert.ok(!since(mark2).some((c) => c.path.endsWith("/skill-labels/rename")), "no rename of Unsorted");
  assert.equal(remote("deal-notes").label, "Admin");
  assert.equal(remote("water-plants").label, null, "the suggestion stays where it was");
  assert.deepEqual([ref("ws_a", "water-plants").label, ref("ws_a", "water-plants").labelBy], ["Plant care", "auto"]);
  assert.deepEqual([ref("ws_a", "rotate-keys").label, remote("rotate-keys").label], ["Admin", "Admin"], "one renamed to Unsorted was decided there, so it moves");
  assert.equal(ref("ws_a", "deal-notes").labelBy, "user");
});

await check("A workspace without an Orgo project: renamed here, nothing waits to go", async () => {
  W.renameLabel("ws_local", "Email", "Mail");
  assert.equal(ref("ws_local", "old-none").label, "Mail");
  O.outboxForTests.writeAll();
  assert.ok(!existsSync(join(process.cwd(), ".data", "outbox", "skill-label-renames.json")));
});

await check("Plain words: nothing a person or a bot reads has a dash or says Orbit; no stray warnings", async () => {
  const all = heard.join("\n");
  assert.doesNotMatch(all, /[‒–—―]| - /);
  assert.doesNotMatch(all, /Orbit/);
  assert.deepEqual(logged.filter((l) => /^\[skills\]/.test(l)), [], "no stray warnings");
});

console.log(`\nlabels unsorted: ${passed} passed, ${failed} failed`);
if (failed) console.log(`The throwaway folder is kept for a look: ${scratch}`);
else rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
