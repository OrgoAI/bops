// Tests for Knowledge, Skills in a workspace shared with the user (components/app/skills.tsx, memory-categories.tsx): for
// an Admin there, Skills shows the workspace's skills as Orgo keeps them (GET /api/skills, read again after each change),
// "Kept in Orgo for everyone in" its name; Publish only on a draft; no Import an app folder, no Open in Finder, no label to
// move, no Who has what or Suggest labels; Update from folder asks before it publishes; a skill that follows its label
// says so in place of its bots' switches. Knowledge's other kinds keep the owner's line, with Open Skills for an Admin; a
// Member sees no Skills. Nothing says a dash or Orbit. The .tsx files are compiled with the TypeScript in node_modules as
// they load and rendered into a DOM (linkedom); the server is a stubbed fetch.
// Usage: node scripts/test-skills-ui-shared.mjs   (not with --conditions=react-server: these are client components)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
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

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
win.HTMLElement.prototype.focus = function () {};
win.HTMLElement.prototype.scrollTo = function () {};
win.HTMLElement.prototype.scrollIntoView = function () {};
globalThis.window = globalThis;
globalThis.location = { origin: "http://localhost:3210" };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// The Mac app's bridge: a folder picked in Finder, and one shown there.
let picked = null;
globalThis.bopsMac = { pickFolder: async () => picked, revealFolder: async () => true };

/** The server, stubbed: every call kept, answered from `lists` and `details`. */
const calls = [];
let lists;
let details;
let answers = {};
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url: String(url), method, body });
  const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
  if (String(url).startsWith("/api/skills") && method === "GET") return reply(200, { ...lists, orgo: true, shared: true });
  if (String(url) === "/api/skills" && method === "POST") {
    if (body.action === "detail") return reply(200, details[body.slug]);
    const a = answers[body.action];
    return a ? reply(a.status ?? 200, a.body) : reply(200, { ok: true, ref: lists.skills.find((x) => x.slug === body.slug) });
  }
  return reply(404, {});
};

const { createRoot } = await import("react-dom/client");
const { act, createElement: h } = await import("react");
const { SkillsPage } = await import(pathToFileURL(`${root}/components/app/skills.tsx`).href);
const { MemoryView } = await import(pathToFileURL(`${root}/components/app/memory-categories.tsx`).href);
const { sharedWsId } = await import(`${root}/lib/shared.ts`);
const { SkillDrafts, OpenSkill } = await import(pathToFileURL(`${root}/components/app/skill-drafts.tsx`).href);

let passed = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack.split("\n").slice(0, 10).join("\n  ")}`);
  }
}
const settle = () => new Promise((r) => setTimeout(r, 5));
async function mount(el) {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => {
    r.render(el);
    await settle();
  });
  await act(settle);
  return { box, done: async () => (await act(async () => r.unmount()), box.remove()) };
}
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new win.Event("click", { bubbles: true }));
    await settle();
    await settle();
  });
const buttons = (box) => [...box.querySelectorAll("button")];
const button = (box, label) => buttons(box).find((b) => b.textContent.trim() === label);
const words = (box) => box.textContent.replace(/\s+/g, " ").trim();
const seen = [];
const look = (box) => (seen.push(words(box)), words(box));

const WS = sharedWsId("p1");
const ref = (over) => ({ kind: "skill", labelBy: "skill", botIds: [], source: "orgo", createdAt: 0, updatedAt: 1, ...over });
const reset = () => {
  calls.length = 0;
  answers = {};
  picked = null;
  lists = {
    skills: [
      ref({ slug: "weekly-report", name: "Weekly report", description: "Sums up the week.", status: "draft", label: "Writing", botIds: ["max"], updatedAt: 3 }),
      ref({ slug: "triage", name: "Triage", description: "Sorts the inbox.", status: "published", version: "0.1.1", label: "Email", updatedAt: 2 }),
    ],
    apps: [],
  };
  const files = [{ path: "scripts/sum.sh", size: 20, sha256: "d".repeat(64), executable: true, script: true, approved: false, binary: false }];
  details = {
    "weekly-report": { ref: { ...lists.skills[0], versions: [{ version: "0.1.0", at: 0, sha256: "" }] }, body: "# Weekly report\n", frontmatter: {}, files, dir: null, missing: false, changed: false, shared: true },
    triage: { ref: { ...lists.skills[1], versions: [{ version: "0.1.0", at: 0, sha256: "" }, { version: "0.1.1", at: 0, sha256: "" }] }, body: "# Triage\n", frontmatter: {}, files: [], dir: "/should/not/show", missing: false, changed: true, shared: true },
  };
};
/** The shared workspace open, as the window's state has it (AppState.shared): its bots, none of its skills. */
const state = (role = "admin") => ({
  workspace: WS,
  workspaces: [{ id: WS, name: "Acme", createdAt: 0 }],
  bots: [
    { id: "max", name: "Max", role: "Sales", color: "#5B8CFF", isMain: true, workspaceId: WS, computerStatus: "none" },
    { id: "ivy", name: "Ivy", role: "Support", color: "#0A0A0A", isMain: false, workspaceId: WS, computerStatus: "none" },
  ],
  chats: [],
  sessions: [],
  messages: [],
  routines: [],
  account: { user: { id: "u_sam", email: "sam@example.com" }, signedInAt: 0 },
  shared: { projectId: "p1", name: "Acme", owner: "ada@example.com", role, wsId: WS, can: role === "admin" ? ["memory"] : [] },
});

await check("an Admin's Skills is Orgo's list, read once open: no app import, no Who has what or Suggest, and it says where it's kept", async () => {
  reset();
  const m = await mount(h(SkillsPage, { state: state(), only: "skill", onClose() {} }));
  try {
    const t = look(m.box);
    assert.ok(calls.some((c) => c.method === "GET" && c.url === "/api/skills"), "the list asked of the server (the shared branch)");
    assert.ok(!calls.some((c) => c.url.includes("sync=1")), "no sync of the viewer's own workspace");
    assert.match(t, /Kept in Orgo for everyone in Acme\./);
    assert.match(t, /Weekly report/);
    assert.match(t, /Triage/);
    assert.ok(button(m.box, "Import a skill folder"), "a skill folder can be imported");
    assert.ok(!button(m.box, "Import an app folder"), "never an app");
    assert.ok(!/Who has what|Suggest labels/.test(t));
  } finally {
    await m.done();
  }
});

await check("a draft opened: Publish, no label to move, no Open in Finder; pressing it publishes and reads the list again", async () => {
  reset();
  const m = await mount(h(SkillsPage, { state: state(), only: "skill", focus: "skill:weekly-report", onClose() {} }));
  try {
    const t = look(m.box);
    assert.ok(button(m.box, "Publish"), "Publish on a draft");
    assert.ok(!m.box.querySelector("[aria-haspopup=menu]"), "no label chip menu");
    assert.match(t, /Writing/);
    assert.ok(!button(m.box, "Open in Finder"));
    assert.ok(button(m.box, "Update from folder"));
    const before = calls.filter((c) => c.method === "GET").length;
    await click(button(m.box, "Publish"));
    assert.deepEqual(calls.filter((c) => c.method === "POST" && c.body.action === "publish").map((c) => [c.body.slug, c.body.kind]), [["weekly-report", "skill"]]);
    assert.ok(calls.filter((c) => c.method === "GET").length > before, "the list read again");
  } finally {
    await m.done();
  }
});

await check("a published one opened: no Publish (its folder's changes aren't Orgo's), its versions to roll back to, and its label's bots said, not switched", async () => {
  reset();
  const m = await mount(h(SkillsPage, { state: state(), only: "skill", focus: "skill:triage", onClose() {} }));
  try {
    const t = look(m.box);
    assert.ok(!buttons(m.box).some((b) => /^Publish/.test(b.textContent.trim())), "no Publish on a published one");
    assert.ok(!button(m.box, "Open in Finder"), "no folder, whatever the detail says");
    assert.ok(button(m.box, "Roll back to this"), "an older version to roll back to");
    assert.match(t, /Every bot with the label Email has it\. The owner picks which bots have a label\./);
    assert.ok(!m.box.querySelector("[aria-pressed]"), "no bot switches for a skill that follows its label");
  } finally {
    await m.done();
  }
});

await check("Update from folder asks before it publishes, and sends nothing until Publish", async () => {
  reset();
  picked = "/Users/sam/skills/weekly-report";
  answers.import = { body: { ref: { ...lists.skills[0], status: "published", version: "0.1.1" }, skipped: [], warnings: [], published: true } };
  const m = await mount(h(SkillsPage, { state: state(), only: "skill", focus: "skill:weekly-report", onClose() {} }));
  try {
    await click(button(m.box, "Update from folder"));
    assert.match(look(m.box), /Publish the folder weekly-report as its next version\? Its bots use it at once\./);
    assert.ok(!calls.some((c) => c.body?.action === "import"), "nothing sent yet");
    const bar = m.box.querySelector("[data-folder-confirm]");
    await click([...bar.querySelectorAll("button")].find((b) => b.textContent.trim() === "Publish"));
    assert.deepEqual(calls.filter((c) => c.body?.action === "import").map((c) => [c.body.slug, c.body.path]), [["weekly-report", "/Users/sam/skills/weekly-report"]]);
    assert.match(look(m.box), /Published Weekly report from the folder as its next version\./);
  } finally {
    await m.done();
  }
});

await check("a skill naming its bots: each a switch, sent as on or off", async () => {
  reset();
  const m = await mount(h(SkillsPage, { state: state(), only: "skill", focus: "skill:weekly-report", onClose() {} }));
  try {
    const sw = [...m.box.querySelectorAll("[aria-pressed]")];
    assert.deepEqual(sw.map((b) => [b.textContent.trim(), b.getAttribute("aria-pressed")]), [["Max", "true"], ["Ivy", "false"]]);
    await click(sw[1]);
    assert.deepEqual(calls.filter((c) => c.body?.action === "bot").map((c) => [c.body.botId, c.body.on]), [["ivy", true]]);
  } finally {
    await m.done();
  }
});

await check("Knowledge in a shared workspace: Skills for an Admin, Open Skills under the owner's line; a Member sees neither", async () => {
  reset();
  let opened = null;
  const props = (role, category) => ({ state: state(role), user: "u_sam", ws: WS, category, onCategory: (c) => (opened = c), onClose() {} });
  let m = await mount(h(MemoryView, props("admin", "skills")));
  try {
    assert.match(look(m.box), /Kept in Orgo for everyone in Acme\./);
  } finally {
    await m.done();
  }
  m = await mount(h(MemoryView, props("admin", "all")));
  try {
    assert.match(look(m.box), /Knowledge in Acme is kept on the owner's Bops/);
    await click(button(m.box, "Open Skills"));
    assert.equal(opened, "skills");
  } finally {
    await m.done();
  }
  calls.length = 0;
  for (const category of ["skills", "all"]) {
    m = await mount(h(MemoryView, props("member", category)));
    try {
      assert.match(look(m.box), /Knowledge in Acme is kept on the owner's Bops/);
      assert.ok(!button(m.box, "Open Skills"));
      assert.ok(!/Kept in Orgo/.test(words(m.box)));
    } finally {
      await m.done();
    }
  }
  assert.ok(!calls.some((c) => c.url.startsWith("/api/skills")), "a Member's window never asks");
});

await check("a bot's draft in a chat: a card that opens it in Skills (never a publish of its own), for the owner and an Admin; a Member sees none", async () => {
  reset();
  const msg = { id: "m1", chatId: "bot:max", role: "bot", botId: "max", text: "Saved it.", at: 1, skillDrafts: [{ kind: "skill", slug: "weekly-report", name: "Weekly report" }] };
  const opened = [];
  const card = (st) => h(OpenSkill.Provider, { value: (item) => opened.push(item) }, h(SkillDrafts, { message: msg, state: st }));
  // An Admin of a shared workspace.
  let m = await mount(card(state("admin")));
  try {
    assert.match(look(m.box), /Saved as a draft: Weekly report/);
    await click(button(m.box, "Review and publish"));
    assert.deepEqual(opened, ["skill:weekly-report"]);
    assert.deepEqual(calls, [], "the card itself sends nothing");
  } finally {
    await m.done();
  }
  // A Member there: nothing.
  m = await mount(card(state("member")));
  try {
    assert.equal(m.box.querySelector("[data-skill-drafts]"), null);
  } finally {
    await m.done();
  }
  // The owner, in their own workspace: once it's published, it says so.
  const own = { ...state(), shared: undefined, workspaces: [{ id: "ws_main", name: "Mine", createdAt: 0, skills: [{ ...lists.skills[0], status: "published", version: "0.1.0" }] }] };
  m = await mount(card(own));
  try {
    assert.match(look(m.box), /Published: Weekly report/);
    assert.ok(button(m.box, "Open in Skills"));
  } finally {
    await m.done();
  }
});

await check("nothing on these pages has a dash or says Orbit", async () => {
  for (const t of seen) {
    assert.ok(!/[‒–—―]| - /.test(t), `a dash in: ${t.slice(0, 200)}`);
    assert.ok(!/orbit/i.test(t), `Orbit in: ${t.slice(0, 200)}`);
  }
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
