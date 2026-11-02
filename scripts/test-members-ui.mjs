// Tests for the People sheet's bot picker (components/app/members.tsx): which bots it offers (the open
// workspace's, its main bot first, none while a workspace shared with the user is open), how a level picked
// on a row changes someone's access (lib/member-access.ts), and the picker rendered: a row for every bot at
// once, new ones too, then one row per bot with its mascot, each None, Read or Write, Write saying what it
// lets them do (chat with the bot, have it work, answer it, stop it; never the owner's logins, keys or Macs). Then the sheet rendered into a DOM (linkedom) and clicked, against a fake Bops: the owner
// says Every bot, each person and invite says which bots they see and that View only is about the
// computers; an invite goes out with every bot there now to read unless bots were chosen, and the form
// starts over after; a person's bots save at once, one change at a time with the newest last, and go back
// to what was saved when Bops turns one down, or to the last one saved when the read after it fails; an invite
// sent again keeps its bots, from its row or the form; and with a shared workspace open no bots are offered or
// sent. Last, the words: no dashes, and the footer says the bots you pick, never the Vault.
//
// Nothing reaches a server (fetch is a fake). The .tsx files are compiled with the TypeScript in node_modules as they load.
// Usage: node scripts/test-members-ui.mjs   (not with --conditions=react-server: these are client components)
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

// A window, enough of one.
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const S = await import(pathToFileURL(`${root}/components/app/members.tsx`).href);
const M = await import(pathToFileURL(`${root}/lib/members.ts`).href);
const A = await import(pathToFileURL(`${root}/lib/member-access.ts`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const noop = () => {};

const BOTS = [
  { id: "sam", name: "Sam", color: "#7AA2F7", isMain: false, workspaceId: "ws_main" },
  { id: "boppy", name: "Boppy", color: "#F7C948", isMain: true },
  { id: "rex", name: "Rex", color: "#9ECE6A", isMain: true, workspaceId: "ws_two" },
];
const base = {
  account: { user: { id: "u1", name: "Tess Ito", email: "tess@example.com" } },
  bots: BOTS,
  workspaces: [
    { id: "ws_main", name: "Main" },
    { id: "ws_two", name: "Two" },
  ],
  workspace: "ws_main",
  routines: [],
  watches: [],
  sessions: [],
  messages: [],
  chats: [],
  accounts: [],
};

/* ---------------- Which bots, and a level picked ---------------- */

await test("the bots offered are the open workspace's, main bot first; none while a shared workspace is open", () => {
  assert.deepEqual(S.sheetBots(base).map((b) => b.id), ["boppy", "sam"]);
  assert.deepEqual(S.sheetBots({ ...base, workspace: "ws_two" }).map((b) => b.id), ["rex"]);
  // The sheet's people are another workspace's (the default's "bops" one, for a workspace with none of its own): its bots.
  assert.deepEqual(S.sheetBots({ ...base, workspace: "ws_two" }, "ws_main").map((b) => b.id), ["boppy", "sam"]);
  assert.equal(S.sheetBots({ ...base, shared: { projectId: "p9", name: "Acme", owner: "dana@acme.test", role: "member", wsId: "shared_p9" } }), null);
});

await test("a level picked on a bot names it unless it's the rest's level; on Every bot it sets them all, new ones too", () => {
  const a = { others: "none", bots: { boppy: "read" } };
  assert.deepEqual(S.withLevel(a, "sam", "write"), { others: "none", bots: { boppy: "read", sam: "write" } });
  assert.deepEqual(S.withLevel(a, "boppy", "none"), { others: "none", bots: {} }, "back to the rest's level: not named");
  assert.deepEqual(S.withLevel(a, "boppy", "write"), { others: "none", bots: { boppy: "write" } });
  assert.deepEqual(S.withLevel(a, null, "read"), { others: "read", bots: {} });
  assert.deepEqual(a, { others: "none", bots: { boppy: "read" } }, "the access it was given is left alone");
  // What it makes is what Bops Cloud keeps.
  for (const x of [S.withLevel(a, "sam", "write"), S.withLevel(a, "boppy", "none"), S.withLevel(a, null, "write")]) assert.deepEqual(A.cleanAccess(x), x);
});

/* ---------------- The picker ---------------- */

/** Each row of a rendered picker: its name, whether it has a mascot, and its levels with the one checked. */
function rowsOf(html) {
  return [...html.matchAll(/<div class="flex h-\[30px\][^"]*">([\s\S]*?)<\/div><\/div>/g)].map(([, row]) => ({
    name: row.match(/truncate[^"]*">([^<]*)</)?.[1].replace("&#x27;", "'"),
    mascot: /viewBox="0 0 40 40" style="width:16px;height:16px/.test(row),
    levels: [...row.matchAll(/role="radio" aria-checked="(true|false)"[^>]*>([^<]*)</g)].map(([, on, label]) => (on === "true" ? `[${label}]` : label)).join(" "),
    tips: [...row.matchAll(/data-tip="([^"]*)"/g)].map(([, t]) => t.replace(/&#x27;/g, "'")),
  }));
}

await test("the picker: Every bot first, then each bot with its mascot, one line each, None, Read or Write", () => {
  const html = renderToStaticMarkup(h(S.BotAccess, { bots: S.sheetBots(base), value: { others: "none", bots: { boppy: "read", sam: "write" } }, onChange: noop }));
  const rows = rowsOf(html);
  assert.deepEqual(
    rows.map((r) => `${r.name}: ${r.levels}${r.mascot ? " (mascot)" : ""}`),
    ["Every bot, new ones too: [None] Read Write", "Boppy: None [Read] Write (mascot)", "Sam: None Read [Write] (mascot)", "Use its computer: [Off] On"],
  );
  for (const r of rows.slice(0, -1)) assert.deepEqual(r.tips.slice(-3), [M.ACCESS_TIPS.none, M.ACCESS_TIPS.read, M.ACCESS_TIPS.write], `${r.name}: each level says what it does`);
  assert.equal(M.ACCESS_TIPS.write, "Can chat with this bot, have it do work, answer what it asks and stop it. Never your logins, keys or Macs.");
  // Under the rows, what each level means, said plainly once.
  const levels = html.match(/<ul data-access-levels[^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? "";
  assert.deepEqual(
    [...levels.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, li]) => li.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'")),
    ["None: can't see this bot in Bops. On orgo.ai they still see its computer.", "Read: sees everything this bot does, including your chats with it.", "Write: can chat with this bot, have it do work, answer what it asks and stop it. Never your logins, keys or Macs."],
  );
  assert.equal((html.match(/truncate/g) ?? []).length, 4, "every name is cut short, not wrapped");
  assert.match(html, /aria-label="What they can do with Sam"/);
  // Single bots set apart: Every bot's level is only the new bots', lighter, and says so, to a screen reader too.
  const group = html.match(/<div role="radiogroup" aria-label="What they can do with bots you make later" aria-describedby="([^"]+)"[\s\S]*?<\/div>/);
  assert.ok(group, "named for what its level is now: bots made later");
  assert.match(group[0], /aria-checked="true"[^>]*class="[^"]*bg-white\/60/);
  assert.match(rowsOf(html)[0].tips[0], /^Bots you make later: None\. Pick here to set every bot below too\.$/);
  assert.match(html, new RegExp(`<span id="${group[1]}" class="sr-only">Bots you make later: None\\. Pick here to set every bot below too\\.</span>`));
  const same = renderToStaticMarkup(h(S.BotAccess, { bots: S.sheetBots(base), value: { others: "read", bots: {} }, onChange: noop }));
  assert.ok(!/bg-white\/60/.test(same), "every bot alike: Every bot's level shows as picked");
  assert.match(same, /aria-label="What they can do with Every bot, new ones too"/);
});

await test("a bot added later shows at the level for bots not named", () => {
  const rows = rowsOf(renderToStaticMarkup(h(S.BotAccess, { bots: S.sheetBots(base), value: { others: "read", bots: { boppy: "none" } }, onChange: noop })));
  assert.deepEqual(rows.map((r) => r.levels), ["None [Read] Write", "[None] Read Write", "None [Read] Write", "[Off] On"]);
});

await test("a bot named Constructor is at the level kept for it, never one read off the object", () => {
  const bots = [...S.sheetBots(base), { id: "constructor", name: "Constructor", color: "#ccc", isMain: false, workspaceId: "ws_main" }];
  const none = { others: "none", bots: {} };
  assert.equal(A.accessSummary(none, bots.map((b) => b.id)), "No bots");
  const rows = rowsOf(renderToStaticMarkup(h(S.BotAccess, { bots, value: none, onChange: noop })));
  assert.deepEqual(rows.map((r) => `${r.name}: ${r.levels}`), ["Every bot, new ones too: [None] Read Write", "Boppy: [None] Read Write", "Sam: [None] Read Write", "Constructor: [None] Read Write", "Use its computer: [Off] On"]);
});

/* ---------------- The sheet, clicked ---------------- */

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
win.HTMLElement.prototype.focus = function () {};
win.HTMLElement.prototype.scrollIntoView = () => {};
// Typing as React hears it: by the input event, when the document says it has one (linkedom's doesn't).
doc.oninput = null;
Object.defineProperty(win.HTMLInputElement.prototype, "type", {
  configurable: true,
  get() {
    return this.getAttribute("type") || "text";
  },
  set(v) {
    this.setAttribute("type", v);
  },
});
globalThis.document = doc;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
async function mount(el) {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => {
    r.render(el);
    await settle();
  });
  return { box, done: async () => (await act(async () => r.unmount()), box.remove()) };
}
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new win.Event("click", { bubbles: true }));
    await settle();
  });
const type = (el, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    await settle();
  });
const submit = (form) =>
  act(async () => {
    form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await settle();
  });

const buttonOf = (el, text) => [...el.querySelectorAll("button")].find((b) => b.textContent === text);
/** The level `level` on the picker row for `name` ("Every bot, new ones too" or a bot's name). */
const levelButton = (el, name, level) => buttonOf(el.querySelector(`[aria-label="What they can do with ${name}"]`), level);
const summaryOf = (el) => el.querySelector("[data-access-summary]")?.textContent;
/** A row of Who has access or Invited, by the name or email on it. */
const rowOf = (box, who) => [...box.querySelectorAll(".group")].find((r) => r.textContent.includes(who));

/** Bops, faked: who has access (kept as Bops keeps it after each change), and what each change was sent. */
function bops() {
  const info = {
    state: "ready",
    orgoUrl: "https://orgo.test/workspaces/w1",
    host: "orgo",
    fullAccess: "on",
    keysOnComputers: false,
    you: { id: "u1", name: "Tess Ito", email: "tess@example.com" },
    people: [{ id: "m1", name: "Jamie Lee", email: "jamie@example.com", role: "viewer", guest: false, access: { others: "none", bots: { boppy: "read" } } }],
    invites: [{ email: "alex@example.com", role: "viewer", expiresAt: new Date(2026, 9, 28).getTime(), expired: false, link: "https://orgo.test/accept/x", access: { others: "read", bots: { sam: "write" } } }],
    seats: { plan: "max_bops", canAdd: true, limit: 5, used: 2, upgrade: null, caps: { pro_bops: 2, max_bops: 5 } },
  };
  // `failReadsAfter`: once this many changes were sent, reading who has access fails (as Bops not answering).
  // `refuseWith`: the next changes are turned down with this {status, body}, as the route answers one.
  const fake = { info, sent: [], refuse: false, refuseWith: null, hold: null, failReadsAfter: Infinity };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET" && fake.sent.length >= fake.failReadsAfter) return { ok: false, status: 500, json: async () => JSON.parse("<html>") };
    if (method === "GET") return { ok: true, status: 200, json: async () => structuredClone(info) };
    const body = JSON.parse(init.body);
    fake.sent.push({ method, body });
    if (fake.hold) await fake.hold;
    if (fake.refuse) return { ok: false, status: 502, json: async () => ({ code: "ORGO_ERROR", error: "Orgo couldn't do that just now." }) };
    if (fake.refuseWith) return { ok: false, status: fake.refuseWith.status, json: async () => structuredClone(fake.refuseWith.body) };
    if (method === "PATCH" && body.access && body.memberId) info.people.find((p) => p.id === body.memberId).access = A.cleanAccess(body.access);
    if (method === "PATCH" && body.role && body.memberId) info.people.find((p) => p.id === body.memberId).role = body.role;
    if (method === "PATCH" && body.role && body.invite) info.invites.find((i) => i.email === body.invite).role = body.role;
    if (method === "POST") return { ok: true, status: 200, json: async () => ({ email: body.email, role: body.role, emailSent: true }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return fake;
}

await test("the owner says Every bot; a person and an invite say which bots, and each says their role plainly", async () => {
  bops();
  const { box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  const you = rowOf(box, "Tess Ito");
  assert.match(you.textContent, /tess@example\.com·Every bot/);
  const jamie = rowOf(box, "Jamie Lee");
  assert.equal(summaryOf(jamie), "1 bot, read");
  assert.ok(buttonOf(jamie, "Bots"), "a Bots toggle under the name");
  assert.match(you.textContent, /Owner/, "the owner's row says Owner");
  assert.equal(buttonOf(jamie, "Member").getAttribute("aria-checked"), "true", "a Member");
  assert.equal(buttonOf(jamie, "Admin").getAttribute("aria-checked"), "false");
  const alex = rowOf(box, "alex@example.com");
  assert.match(summaryOf(alex), /^Every bot, 1 to write, new bots to read · expires Oct 28$/);
  assert.equal(buttonOf(alex, "Member").getAttribute("aria-checked"), "true", "an invite's role too");
  assert.equal(summaryOf(box.querySelector("form")), "Every bot, read", "an invite starts with every bot there now to read");
  assert.equal(box.querySelector("[data-bot-access]"), null, "no picker open until asked");
  await done();
});

await test("while Bops Cloud doesn't give people their role yet (fullAccess not_yet): Admin isn't offered, and Your Apps says it waits", async () => {
  const fake = bops();
  fake.info.fullAccess = "not_yet";
  const { box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  const jamie = rowOf(box, "Jamie Lee");
  const admin = buttonOf(jamie, "Admin");
  assert.equal(admin.disabled, true, "Admin held back on a person");
  assert.equal(admin.getAttribute("data-tip"), M.WORDS.fullAccessNotYet);
  assert.equal(buttonOf(jamie, "Member").disabled, false);
  assert.equal(buttonOf(box.querySelector("form"), "Admin").disabled, true, "and in the invite form");
  await done();
});

await test("an invite goes out with the bots chosen, and the form starts over after", async () => {
  const fake = bops();
  const { box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  const form = box.querySelector("form");
  await click(buttonOf(form, "Choose bots"));
  const picker = form.querySelector("[data-bot-access]");
  assert.ok(picker, "Choose bots opens the picker in the form");
  assert.equal(buttonOf(form, "Choose bots").getAttribute("aria-expanded"), "true");
  await click(levelButton(picker, "Sam", "Write"));
  assert.equal(summaryOf(form), "Every bot, 1 to write");
  await click(levelButton(picker, "bots you make later", "None"));
  assert.equal(summaryOf(form), "No bots", "Every bot sets each bot too");
  assert.equal(levelButton(picker, "Sam", "None").getAttribute("aria-checked"), "true");
  await click(levelButton(picker, "Boppy", "Read"));
  assert.equal(summaryOf(form), "1 bot, read");
  await type(form.querySelector("input"), "Riley@Example.com");
  await submit(form);
  // (Your Apps rides along at Read, a new invite's default: lib/member-access.ts inviteDefault.)
  assert.deepEqual(fake.sent, [{ method: "POST", body: { email: "riley@example.com", role: "viewer", access: { others: "none", bots: { boppy: "read" }, apps: "read" } } }]);
  assert.equal(summaryOf(box.querySelector("form")), "Every bot, read", "back to the default after it's sent");
  assert.equal(box.querySelector("form [data-bot-access]"), null, "and the picker closed");
  // Not chosen: every bot there now to read, new ones hidden.
  await type(box.querySelector("form input"), "sky@example.com");
  await submit(box.querySelector("form"));
  assert.deepEqual(fake.sent[1].body.access, { others: "none", bots: { boppy: "read", sam: "read" }, apps: "read" });
  await done();
});

await test("a person's bots save at once, one change at a time with the newest last", async () => {
  const fake = bops();
  const { box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  await click(buttonOf(rowOf(box, "Jamie Lee"), "Bots"));
  const picker = () => rowOf(box, "Jamie Lee").querySelector("[data-bot-access]");
  assert.ok(picker(), "Bots opens the picker under the row");
  assert.equal(levelButton(picker(), "Boppy", "Read").getAttribute("aria-checked"), "true");
  await click(levelButton(picker(), "Sam", "Write"));
  assert.deepEqual(fake.sent, [{ method: "PATCH", body: { memberId: "m1", access: { others: "none", bots: { boppy: "read", sam: "write" } } } }]);
  assert.equal(summaryOf(rowOf(box, "Jamie Lee")), "Every bot, 1 to write");
  // Two picks while the first is saving: shown at once, sent one after the other, the newest last.
  let release;
  fake.hold = new Promise((r) => (release = r));
  await click(levelButton(picker(), "Boppy", "Write"));
  await click(levelButton(picker(), "Sam", "None"));
  assert.equal(fake.sent.length, 2, "the second waits for the first");
  assert.equal(summaryOf(rowOf(box, "Jamie Lee")), "1 bot, write", "what was picked shows while it saves");
  await act(async () => {
    release();
    fake.hold = null;
    await settle();
  });
  assert.deepEqual(
    fake.sent.slice(1).map((c) => c.body.access),
    [
      { others: "none", bots: { boppy: "write", sam: "write" } },
      { others: "none", bots: { boppy: "write" } },
    ],
  );
  assert.equal(summaryOf(rowOf(box, "Jamie Lee")), "1 bot, write");
  assert.deepEqual(fake.info.people[0].access, { others: "none", bots: { boppy: "write" } });
  await done();
});

await test("a save queued behind another shows what it saved when the read after it fails", async () => {
  const fake = bops();
  const { box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  await click(buttonOf(rowOf(box, "Jamie Lee"), "Bots"));
  const picker = () => rowOf(box, "Jamie Lee").querySelector("[data-bot-access]");
  let release;
  fake.hold = new Promise((r) => (release = r));
  await click(levelButton(picker(), "Sam", "Write"));
  await click(levelButton(picker(), "Boppy", "Write"));
  // The first save's read comes back; the second's doesn't (the sheet keeps what it read before).
  fake.failReadsAfter = 2;
  await act(async () => {
    release();
    fake.hold = null;
    await settle();
  });
  assert.equal(fake.sent.length, 2);
  assert.deepEqual(fake.info.people[0].access, { others: "none", bots: { boppy: "write", sam: "write" } });
  assert.equal(summaryOf(rowOf(box, "Jamie Lee")), "Every bot, write", "the last save, not the first");
  assert.equal(levelButton(picker(), "Boppy", "Write").getAttribute("aria-checked"), "true");
  await done();
});

await test("a change Bops turns down goes back to what was saved, with why under the row", async () => {
  const fake = bops();
  const { box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  await click(buttonOf(rowOf(box, "Jamie Lee"), "Bots"));
  fake.refuse = true;
  await click(levelButton(rowOf(box, "Jamie Lee").querySelector("[data-bot-access]"), "bots you make later", "Read"));
  assert.equal(fake.sent.length, 1);
  const jamie = rowOf(box, "Jamie Lee");
  assert.equal(summaryOf(jamie), "1 bot, read", "back to what Bops has");
  assert.equal(levelButton(jamie, "bots you make later", "None").getAttribute("aria-checked"), "true");
  assert.equal(jamie.querySelector('[role="alert"]')?.textContent, "Couldn't change their bots. Try again.");
  await done();
});

await test("an invite sent again keeps its bots, from its row or the form", async () => {
  const fake = bops();
  const { box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  await click(buttonOf(rowOf(box, "alex@example.com"), "Resend"));
  assert.deepEqual(fake.sent, [{ method: "POST", body: { email: "alex@example.com", role: "viewer", access: { others: "read", bots: { sam: "write" } } } }]);
  // Typed in the form: Resend invite, with the bots it has shown and sent, never every bot unasked.
  const form = box.querySelector("form");
  await type(form.querySelector("input"), "Alex@Example.com");
  assert.ok(buttonOf(form, "Resend invite"));
  assert.equal(summaryOf(form), "Every bot, 1 to write, new bots to read");
  await click(buttonOf(form, "Choose bots"));
  assert.equal(levelButton(form, "Sam", "Write").getAttribute("aria-checked"), "true", "the picker starts from them");
  await submit(form);
  assert.deepEqual(fake.sent[1].body, { email: "alex@example.com", role: "viewer", access: { others: "read", bots: { sam: "write" } } });
  await done();
});

await test("with a shared workspace open, no bots are offered or sent", async () => {
  const fake = bops();
  const shared = { ...base, shared: { projectId: "p9", name: "Acme", owner: "dana@acme.test", role: "member", wsId: "shared_p9" } };
  const { box, done } = await mount(h(S.Members, { state: shared, onClose: noop, onUpgrade: noop }));
  assert.ok(box.textContent.includes(M.WORDS.sharedOpen));
  assert.equal(summaryOf(rowOf(box, "Jamie Lee")), undefined, "a person says no bots");
  assert.equal(summaryOf(rowOf(box, "alex@example.com")), "expires Oct 28", "nor does an invite");
  assert.equal(buttonOf(box, "Choose bots"), undefined);
  assert.equal(buttonOf(box, "Bots"), undefined);
  assert.match(rowOf(box, "Tess Ito").textContent, /Every bot/, "the owner still has every bot");
  await type(box.querySelector("form input"), "sky@example.com");
  await submit(box.querySelector("form"));
  assert.deepEqual(fake.sent[0].body, { email: "sky@example.com", role: "viewer" });
  await done();
});

/* ---------------- Owner, Admin and Member ---------------- */

await test("an Admin's row says what they have, with no bots to pick; making someone an Admin is one choice, asked first; Member goes at once", async () => {
  const fake = bops();
  fake.info.people.push({ id: "m2", name: "Ada Park", email: "ada@example.com", role: "admin", guest: false, access: { others: "none", bots: {} } });
  const { box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  const ada = () => rowOf(box, "Ada Park");
  assert.equal(summaryOf(ada()), M.ADMIN_WORDS.row, "every bot, its computer and your apps");
  assert.equal(buttonOf(ada(), "Bots"), undefined, "nothing to pick");
  assert.equal(buttonOf(ada(), "Admin").getAttribute("aria-checked"), "true");
  // Jamie made an Admin: asked first, in plain words.
  await click(buttonOf(rowOf(box, "Jamie Lee"), "Admin"));
  assert.equal(fake.sent.length, 0, "nothing sent before the answer");
  assert.ok(rowOf(box, "Jamie Lee").textContent.includes(M.ADMIN_WORDS.confirmTitle("Jamie Lee")));
  assert.ok(rowOf(box, "Jamie Lee").textContent.includes(M.ADMIN_WORDS.confirmBody));
  await click(buttonOf(rowOf(box, "Jamie Lee"), M.ADMIN_WORDS.confirm));
  assert.deepEqual(fake.sent.at(-1), { method: "PATCH", body: { memberId: "m1", role: "admin" } });
  // Ada made a Member: at once, and the row says they keep only the bots they had, and a copied password outlasts it.
  await click(buttonOf(ada(), "Member"));
  assert.deepEqual(fake.sent.at(-1), { method: "PATCH", body: { memberId: "m2", role: "viewer" } });
  assert.ok(ada().textContent.includes(M.ADMIN_WORDS.toMemberTip));
  assert.ok(ada().textContent.includes(M.WORDS.copiedPassword));
  await done();
});

await test("inviting an Admin hides the bots and sends none; an invite's role changes in place, and an orgo-web that can't says so", async () => {
  const fake = bops();
  const { box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  const form = () => box.querySelector("form");
  await click(buttonOf(form(), "Admin"));
  assert.equal(buttonOf(form(), "Choose bots"), undefined, "no bots to choose for an Admin");
  assert.ok(form().textContent.includes(M.ROLE_LINES.admin));
  await type(form().querySelector("input"), "kai@example.com");
  await submit(form());
  assert.deepEqual(fake.sent.at(-1), { method: "POST", body: { email: "kai@example.com", role: "admin" } });
  // The waiting invite made an Admin, without sending it again.
  const alex = () => rowOf(box, "alex@example.com");
  await click(buttonOf(alex(), "Admin"));
  assert.deepEqual(fake.sent.at(-1), { method: "PATCH", body: { invite: "alex@example.com", role: "admin" } });
  assert.match(summaryOf(alex()), new RegExp(`^${M.ADMIN_WORDS.row}`));
  // An orgo-web before that: said, and Resend then sends it with the role picked.
  fake.refuseWith = { status: 409, body: { code: "INVITE_ROLE_NOT_READY", error: M.ADMIN_WORDS.inviteRoleNotReady } };
  await click(buttonOf(alex(), "Member"));
  assert.ok(alex().textContent.includes(M.ADMIN_WORDS.inviteRoleNotReady));
  fake.refuseWith = null;
  await click(buttonOf(alex(), "Resend"));
  assert.deepEqual(fake.sent.at(-1), { method: "POST", body: { email: "alex@example.com", role: "viewer", access: { others: "read", bots: { sam: "write" } } } });
  await done();
});

/* ---------------- The words ---------------- */

await test("no dashes, and the sheet says the bots you pick, never the saved logins or keys", async () => {
  const noDashes = (text) => assert.ok(!/[–—]/.test(text), `no dashes: ${text}`);
  for (const v of [...Object.values(M.ACCESS_TIPS), ...Object.values(M.ROLE_LINES), M.WORDS.sharedOpen, ...Object.values(A.ACCESS_LABELS)]) noDashes(v);
  // What Write lets a member do, and the line a member reads in place of what they can't (lib/shared.ts readOnlyLine): plain words, Knowledge never Orbit.
  const { readOnlyLine } = await import(`${root}/lib/shared.ts`);
  const lines = [readOnlyLine(), readOnlyLine(["boppy"], { boppy: "read" }), readOnlyLine(["boppy", "sam"], { boppy: "write", sam: "read" })];
  for (const v of [...Object.values(M.ACCESS_TIPS), ...lines]) {
    noDashes(v);
    assert.ok(!v.includes(" - ") && !/orbit/i.test(v), v);
  }
  bops();
  const { box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  await click(buttonOf(box.querySelector("form"), "Choose bots"));
  await click(buttonOf(rowOf(box, "Jamie Lee"), "Bots"));
  noDashes(box.textContent);
  assert.match(box.textContent, /In Bops they see everything of the bots you pick, your chats with them too\./);
  assert.match(box.textContent, /Read: sees everything this bot does, including your chats with it\./, "the picker says what Read lets them see");
  assert.match(box.textContent, /On orgo\.ai they see every bot's computer/);
  assert.match(box.textContent, /Never your saved logins or keys\./, "no keys of Bops' on the computers");
  assert.ok(!/Vault/.test(box.textContent), "the Vault is Logins now");
  assert.ok(!/They see everything in the workspace/.test(box.textContent));
  assert.equal(M.ROLE_LINES.viewer, "Sees and does only what you pick for them.");
  await done();
});

await test("Member and None say what people get, and keys on the computers are said whenever anyone else is in", async () => {
  // An Admin's line says what only the owner does; a Member's never promises orgo.ai (a staff owned workspace keeps a Member without Use its computer off there).
  assert.equal(M.ROLE_LINES.admin, "Every bot, its computer and your apps. Only you can add people or delete this workspace.");
  assert.ok(!/orgo\.ai/.test(M.ROLE_LINES.viewer));
  assert.match(M.ACCESS_TIPS.none, /^Can't see this bot in Bops\. On orgo\.ai they still see its computer\.$/);
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Bops' keys on the computers, and only someone with View only in: said, and the footer doesn't promise the keys.
  const held = bops();
  held.info.keysOnComputers = true;
  let { box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  assert.ok(held.info.people.every((p) => p.role === "viewer"));
  assert.match(box.textContent, new RegExp(esc(M.WORDS.keysHeld)), "View only can read them through Orgo's agent");
  assert.match(box.textContent, /can ask Orgo's agent to work on it\. Never your saved logins\./);
  assert.ok(!/Never your saved logins or keys/.test(box.textContent));
  await done();
  // Only an invite out: said too.
  const invited = bops();
  invited.info.keysOnComputers = true;
  invited.info.people = [];
  ({ box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop })));
  assert.match(box.textContent, new RegExp(esc(M.WORDS.keysHeld)));
  await done();
  // Nobody else: nothing to say yet.
  const alone = bops();
  alone.info.keysOnComputers = true;
  alone.info.people = [];
  alone.info.invites = [];
  ({ box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop })));
  assert.ok(!box.textContent.includes(M.WORDS.keysHeld));
  await done();
  // Full access off for them, someone in: that they can still be read is said with it.
  const off = bops();
  off.info.keysOnComputers = true;
  off.info.fullAccess = "off";
  ({ box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop })));
  assert.ok(box.textContent.includes(`${M.WORDS.keysOff} ${M.WORDS.keysOffAnyone}`));
  await done();
});

/* ---------------- The team chart (team-chart.tsx) ---------------- */

const Chart = await import(pathToFileURL(`${root}/components/app/team-chart.tsx`).href);

await test("the sheet links to the team chart, never with a shared workspace open", async () => {
  bops();
  let opened = 0;
  let { box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop, onTeamChart: () => opened++ }));
  const link = box.querySelector("[data-chart-link]");
  assert.equal(link?.textContent, "See the org chart");
  await click(link);
  assert.equal(opened, 1);
  await done();
  ({ box, done } = await mount(h(S.Members, { state: { ...base, shared: { projectId: "p9", name: "Acme", owner: "dana@acme.test", role: "member", wsId: "shared_p9" } }, onClose: noop, onUpgrade: noop, onTeamChart: noop })));
  assert.equal(box.querySelector("[data-chart-link]"), null);
  await done();
  ({ box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop })));
  assert.equal(box.querySelector("[data-chart-link]"), null, "nowhere to go: no link");
  await done();
});

await test("a level changed from the chart goes through the same PATCH /api/members as this sheet", async () => {
  const fake = bops();
  // The chart reads who has access from People (GET /api/members), as this sheet does.
  const { box, done } = await mount(h(Chart.TeamChart, { state: base, focus: "sam", onClose: noop }));
  const row = box.querySelector('[aria-label="What Jamie Lee can do with Sam"]');
  assert.ok(row, "the person is on the bot's sheet, with the sheet's own control");
  await click(buttonOf(row, "Write"));
  assert.deepEqual(fake.sent.at(-1), { method: "PATCH", body: { memberId: "m1", access: { others: "none", bots: { boppy: "read", sam: "write" } } } });
  await done();
});

await test("Your Apps: a row of its own beside the bots under Access, Read for a new invite, Write sent with the bots, in each line; only with a bot; only where apps are open to the owner", async () => {
  // Apps open to the owner (an @orgo.ai account, lib/apps-access.ts).
  const team = { ...base, account: { user: { id: "u1", name: "Tess Ito", email: "tess@orgo.ai" } } };
  const fake = bops();
  fake.info.people[0].access = { others: "none", bots: { boppy: "read" }, apps: "read" };
  let older = false;
  const sheetFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url) === "/api/workspaces?olderBops=1" ? { ok: true, status: 200, json: async () => ({ older }) } : sheetFetch(url, init));
  let m = await mount(h(S.Members, { state: team, onClose: noop, onUpgrade: noop }));
  assert.equal(summaryOf(rowOf(m.box, "Jamie Lee")), "1 bot, read · Your Apps, read", "worded as the bots are");
  assert.match(rowOf(m.box, "Jamie Lee").querySelector("[data-access-summary]").className, /min-w-0 truncate/, "the line gives way, cut with an ellipsis");
  assert.equal(rowOf(m.box, "Jamie Lee").querySelector("[data-access-summary]").getAttribute("title"), "1 bot, read · Your Apps, read", "and says it whole on hover");
  assert.match(summaryOf(rowOf(m.box, "alex@example.com")), /^Every bot, 1 to write, new bots to read · Your Apps not set · expires/, "an invite from before the scope: not set, never None");
  assert.equal(summaryOf(m.box.querySelector("form")), "Every bot, read · Your Apps, read", "a new invite starts at Read");
  await click(buttonOf(rowOf(m.box, "Jamie Lee"), "Access"));
  const picker = () => rowOf(m.box, "Jamie Lee").querySelector("[data-bot-access]");
  const apps = picker().querySelector("[data-apps-access]");
  assert.ok(apps, "the Your Apps row, behind the list's hairline");
  assert.match(apps.textContent, /^Your Apps/);
  assert.equal(levelButton(picker(), "Your Apps", "Read").getAttribute("aria-checked"), "true");
  assert.equal(levelButton(picker(), "Your Apps", "Write").getAttribute("data-tip"), "Also deploys them, goes back to an earlier deploy, changes a site's settings and uses your domains.");
  assert.equal(levelButton(picker(), "Your Apps", "None").getAttribute("data-tip"), "Doesn't see your apps.");
  assert.equal(picker().querySelector("[data-apps-legend]").textContent, "Your Apps never shows them variables or keys, and only you buy domains.");
  assert.equal(picker().querySelector("[data-apps-older]"), null, "no older Macs, no line");
  assert.equal(picker().querySelector("[data-apps-note]"), null, "Bops Cloud shows them now: no line saying it doesn't yet");
  await click(levelButton(picker(), "Your Apps", "Write"));
  assert.deepEqual(fake.sent.at(-1), { method: "PATCH", body: { memberId: "m1", access: { others: "none", bots: { boppy: "read" }, apps: "write" } } });
  assert.equal(summaryOf(rowOf(m.box, "Jamie Lee")), "1 bot, read · Your Apps, write");
  // A bot changed afterwards keeps Your Apps as it is.
  await click(levelButton(picker(), "Sam", "Read"));
  assert.deepEqual(fake.sent.at(-1).body.access, { others: "none", bots: { boppy: "read", sam: "read" }, apps: "write" });
  // The invite form's picker has it too, and sends it.
  const form = m.box.querySelector("form");
  await click(buttonOf(form, "Choose access"));
  await click(levelButton(form.querySelector("[data-bot-access]"), "Your Apps", "None"));
  assert.equal(summaryOf(form), "Every bot, read", "nothing said at None");
  await type(form.querySelector("input"), "riley@example.com");
  await submit(form);
  assert.deepEqual(fake.sent.at(-1).body.access, { others: "none", bots: { boppy: "read", sam: "read" }, apps: "none" });
  await m.done();
  // A Mac on the account on a Bops from before: said under the row.
  older = true;
  m = await mount(h(S.Members, { state: team, onClose: noop, onUpgrade: noop }));
  await click(buttonOf(rowOf(m.box, "Jamie Lee"), "Access"));
  assert.equal(rowOf(m.box, "Jamie Lee").querySelector("[data-apps-older]").textContent, "One of your Macs runs an older Bops. A change made there can hide Your Apps from someone until this Mac is on again.");
  await m.done();
  // Not set yet (someone shared with before the scope): no level picked, and a bot changed sends none.
  fake.info.people[0].access = { others: "none", bots: { boppy: "read" } };
  m = await mount(h(S.Members, { state: team, onClose: noop, onUpgrade: noop }));
  assert.equal(summaryOf(rowOf(m.box, "Jamie Lee")), "1 bot, read · Your Apps not set");
  await click(buttonOf(rowOf(m.box, "Jamie Lee"), "Access"));
  assert.equal(picker().querySelectorAll('[aria-label="What they can do with Your Apps"] [aria-checked="true"]').length, 0, "no level picked");
  await click(levelButton(picker(), "Sam", "Read"));
  assert.deepEqual(fake.sent.at(-1).body.access, { others: "none", bots: { boppy: "read", sam: "read" } }, "never None nobody picked");
  await m.done();
  // Your Apps comes with a bot: with every bot at None, its row is off and says why.
  fake.info.people[0].access = { others: "none", bots: {} };
  m = await mount(h(S.Members, { state: team, onClose: noop, onUpgrade: noop }));
  await click(buttonOf(rowOf(m.box, "Jamie Lee"), "Access"));
  assert.equal(levelButton(picker(), "Your Apps", "Read").disabled, true);
  assert.equal(levelButton(picker(), "Your Apps", "None").getAttribute("aria-checked"), "true");
  assert.equal(picker().querySelector("[data-apps-note]").textContent, "Give them a bot first. Your Apps comes with one.");
  await m.done();
  globalThis.fetch = sheetFetch;
  // Apps not open to the owner: no row, no words.
  bops();
  m = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  await click(buttonOf(rowOf(m.box, "Jamie Lee"), "Bots"));
  assert.equal(m.box.querySelector("[data-apps-access]"), null);
  assert.doesNotMatch(m.box.textContent, /Your Apps/);
  await m.done();
});

await test("Use its computer: off for a new invite, only with Write on a bot, on and off sent with the access, in each line, and said plainly", async () => {
  // Off by default (a new invite's access never has it), and the row says why while there's no Write.
  assert.equal(A.inviteDefault(["boppy"]).computer, undefined);
  const html = renderToStaticMarkup(h(S.BotAccess, { bots: S.sheetBots(base), value: { others: "none", bots: { boppy: "read" } }, onChange: noop }));
  assert.equal(rowsOf(html).at(-1).levels, "[Off] On");
  assert.match(html, /<span data-computer-note[^>]*>Give them Write on a bot first\. Using its computer comes with Write\.<\/span>/);
  assert.match(html, /role="radio" aria-checked="false" disabled=""[^>]*>On</, "off and can't be turned on without Write");
  // Kept "use" by Bops Cloud's own rules: on, off ("none"), and anything else dropped.
  assert.deepEqual(A.cleanAccess({ others: "none", bots: {}, computer: "use" }), { others: "none", bots: {}, computer: "use" });
  assert.deepEqual(A.cleanAccess({ others: "none", bots: {}, computer: "none" }), { others: "none", bots: {}, computer: "none" });
  assert.deepEqual(A.cleanAccess({ others: "none", bots: {}, computer: "root" }), { others: "none", bots: {} });
  assert.equal(A.usesComputer({ computer: "none" }), false);
  assert.equal(A.usesComputer(undefined), false);

  const fake = bops();
  fake.info.people[0].access = { others: "none", bots: { boppy: "write" } };
  const { box, done } = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  await click(buttonOf(rowOf(box, "Jamie Lee"), "Bots"));
  const picker = () => rowOf(box, "Jamie Lee").querySelector("[data-bot-access]");
  const row = () => picker().querySelector('[aria-label="Use its computer"]');
  assert.equal(buttonOf(row(), "Off").getAttribute("aria-checked"), "true");
  assert.equal(buttonOf(row(), "On").disabled, false, "Write on a bot: it can be turned on");
  assert.equal(buttonOf(row(), "On").getAttribute("data-tip"), "What they say can wake the bots' computers and run there as their administrator.");
  assert.equal(buttonOf(row(), "Off").getAttribute("data-tip"), "They can chat, but what they say never wakes a computer or runs on one.");
  assert.equal(picker().querySelector("[data-computer-note]").textContent, "Use its computer lets them wake the bots' computers and run anything there as administrator. Turn it on only for people you trust with those computers.");
  await click(buttonOf(row(), "On"));
  assert.deepEqual(fake.sent.at(-1), { method: "PATCH", body: { memberId: "m1", access: { others: "none", bots: { boppy: "write" }, computer: "use" } } });
  assert.equal(summaryOf(rowOf(box, "Jamie Lee")), "1 bot, write · Uses its computer");
  // A bot changed afterwards keeps it; turning it off sends "none", so the Mac forgets what it kept.
  await click(levelButton(picker(), "Sam", "Read"));
  assert.deepEqual(fake.sent.at(-1).body.access, { others: "none", bots: { boppy: "write", sam: "read" }, computer: "use" });
  await click(buttonOf(row(), "Off"));
  assert.deepEqual(fake.sent.at(-1).body.access, { others: "none", bots: { boppy: "write", sam: "read" }, computer: "none" });
  assert.equal(summaryOf(rowOf(box, "Jamie Lee")), "Every bot, 1 to write");
  await done();

  // On without Write (the bot they wrote to deleted, or orgo-web says so): shown on, so the owner sees it, and it can only be turned off.
  const fake2 = bops();
  fake2.info.people[0].access = { others: "none", bots: { boppy: "read" }, computer: "use" };
  const m2 = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  await click(buttonOf(rowOf(m2.box, "Jamie Lee"), "Bots"));
  const picker2 = () => rowOf(m2.box, "Jamie Lee").querySelector("[data-bot-access]");
  const row2 = () => picker2().querySelector('[aria-label="Use its computer"]');
  assert.equal(buttonOf(row2(), "On").getAttribute("aria-checked"), "true", "shown on");
  assert.equal(buttonOf(row2(), "Off").disabled, false, "it can be turned off");
  assert.equal(picker2().querySelector("[data-computer-note]").textContent, M.COMPUTER_WORDS.onWithoutWrite);
  await click(buttonOf(row2(), "Off"));
  assert.deepEqual(fake2.sent.at(-1), { method: "PATCH", body: { memberId: "m1", access: { others: "none", bots: { boppy: "read" }, computer: "none" } } });
  assert.equal(buttonOf(row2(), "Off").getAttribute("aria-checked"), "true");
  assert.equal(buttonOf(row2(), "On").disabled, true, "and not on again without Write");
  assert.equal(picker2().querySelector("[data-computer-note]").textContent, M.COMPUTER_WORDS.needsWrite);
  await m2.done();

  // What a member reads over the message box in a workspace shared with them (lib/shared.ts computerLine).
  const { computerLine } = await import(`${root}/lib/shared.ts`);
  const shared = (computer) => ({ shared: { projectId: "p9", name: "Acme", owner: "", role: "member", wsId: "shared_p9", ...(computer ? { computer } : {}) } });
  assert.equal(computerLine(shared(true), [{ name: "Max" }]), "You can use Max's computer. What you ask can run there as its administrator.");
  assert.equal(computerLine(shared(false), [{ name: "Max" }]), "The owner hasn't let you use Max's computer, so Max won't answer what you say.");
  assert.equal(computerLine(shared(false), [{ name: "Max" }, { name: "Iris" }]), "The owner hasn't let you use their computers, so they won't answer what you say.");
  assert.equal(computerLine({}, [{ name: "Max" }]), null, "never in the user's own workspace");
  for (const v of [...Object.values(M.COMPUTER_WORDS), computerLine(shared(true), [{ name: "Max" }]), computerLine(shared(false), [{ name: "Max" }])]) {
    assert.ok(!/[–—]/.test(v) && !v.includes(" - ") && !/orbit/i.test(v), v);
  }
});

await test("Use its computer goes to Orgo first: turned down it stays as it was, with why; their last Write taken away turns it off; an invite can't have it until they've joined", async () => {
  const fake = bops();
  fake.info.people[0].access = { others: "none", bots: { boppy: "write" } };
  const m = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  await click(buttonOf(rowOf(m.box, "Jamie Lee"), "Bots"));
  const jamie = () => rowOf(m.box, "Jamie Lee");
  const picker = () => jamie().querySelector("[data-bot-access]");
  const row = () => picker().querySelector('[aria-label="Use its computer"]');
  // Orgo turned it down: sent, then back to Off, with Orgo's reason in the app's words under the row.
  fake.refuseWith = { status: 502, body: { code: "COMPUTER_UNCHANGED", error: M.WORDS.computerUnchanged } };
  await click(buttonOf(row(), "On"));
  assert.equal(fake.sent.at(-1).body.access.computer, "use");
  assert.equal(buttonOf(row(), "Off").getAttribute("aria-checked"), "true", "stays off");
  assert.equal(jamie().querySelector('[role="alert"]')?.textContent, M.WORDS.computerUnchanged);
  assert.equal(summaryOf(jamie()), "1 bot, write");
  // Orgo not answering at all: the row's own line says what didn't change.
  fake.refuseWith = { status: 502, body: { code: "UNREACHABLE", error: M.WORDS.unreachable } };
  await click(buttonOf(row(), "On"));
  assert.equal(jamie().querySelector('[role="alert"]')?.textContent, "Couldn't change Use its computer. Try again.");
  fake.refuseWith = null;
  await click(buttonOf(row(), "On"));
  assert.equal(buttonOf(row(), "On").getAttribute("aria-checked"), "true");
  assert.equal(jamie().querySelector('[role="alert"]'), null);
  assert.equal(summaryOf(jamie()), "1 bot, write · Uses its computer");
  // Their last Write taken away: it goes off with it, sent as off, so Orgo turns it off too.
  await click(levelButton(picker(), "Boppy", "Read"));
  assert.deepEqual(fake.sent.at(-1).body.access, { others: "none", bots: { boppy: "read" }, computer: "none" });
  assert.equal(summaryOf(jamie()), "1 bot, read");
  assert.equal(buttonOf(row(), "On").disabled, true);
  await m.done();

  // An invite: the row is there, off and can't be turned on, even with Write and one kept from before; it says why.
  const html = renderToStaticMarkup(h(S.BotAccess, { bots: S.sheetBots(base), value: { others: "none", bots: { boppy: "write" }, computer: "use" }, onChange: noop, invite: true }));
  assert.equal(rowsOf(html).at(-1).levels, "[Off] On");
  assert.match(html, /<span data-computer-note[^>]*>You can turn on Use its computer once they&#x27;ve joined\.<\/span>/);
  assert.match(html, /role="radio" aria-checked="false" disabled=""[^>]*>On</);
  bops();
  const f = await mount(h(S.Members, { state: base, onClose: noop, onUpgrade: noop }));
  const form = f.box.querySelector("form");
  await click(buttonOf(form, "Choose bots"));
  await click(levelButton(form, "Boppy", "Write"));
  assert.equal(buttonOf(form.querySelector('[aria-label="Use its computer"]'), "On").disabled, true, "Write in the form: still not until they've joined");
  assert.equal(form.querySelector("[data-computer-note]").textContent, M.COMPUTER_WORDS.afterJoin);
  await f.done();
  for (const v of [M.COMPUTER_WORDS.afterJoin, M.WORDS.computerUnchanged, M.WORDS.computerUnreachable, M.WORDS.computerNotReady]) assert.ok(!/[–—]/.test(v) && !v.includes(" - ") && !/orbit/i.test(v), v);
});

console.log(`${passed} passed`);
process.exit(0);
