// Tests for starter routines: the catalog (lib/routine-catalog.ts: every starter has a goal, a when and a
// kind, says writes ask first, and has no dashes), offering, turning on and putting off starters
// (lib/server/routine-suggestions.ts, with the real lib/server/routines.ts), learning a workspace's tags
// from a sample (a fake background turn), the note the bots see, and the routes (app/api/routines/
// suggestions and its dismiss: the Bops window only).
//
// The store, sessions, phone, mail, channels and chat modules are fakes, so nothing reaches a real
// service, a model or the user's own data.
// Usage: node --conditions=react-server scripts/test-routine-suggestions.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

process.env.TZ = "America/New_York";
delete process.env.BOPS_UI_TOKEN;
delete process.env.BOPS_DATABASE_URL;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const FAKES = {
  store: ["addMessage", "bot", "getState", "id", "ownerName", "patchSession", "session", "stateReady", "update"],
  sessions: ["startSession"],
  analytics: ["trackServerEvent"],
  attention: ["pingIfWorthIt"],
  persist: ["onPostgres"],
  phone: ["isOwner", "ownerPhone", "sendText", "textingLine"],
  mail: ["ownerAddresses", "sendEmail"],
  channels: ["postTo"],
  chat: ["backgroundTurn"],
  "workspace-skills": ["findSkill", "skillRefId"],
};
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
    if (!name || !FAKES[name]) return next(url, context);
    return { format: "module", shortCircuit: true, source: FAKES[name].map((n) => `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(name)}].${n}(...a);`).join("\n") };
  },
});

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}
const DASHES = /[‒–—―]| - /;
const noDashes = (text, where) => assert.ok(!DASHES.test(text), `a dash in ${where}: ${text}`);

let seq = 0;
const state = {
  owner: { name: "Sam", timeZone: "America/New_York" },
  bots: [
    { id: "bot_main", name: "Jev", isMain: true },
    { id: "bot_max", name: "Max", workspaceId: "ws_two" },
  ],
  workspaces: [
    { id: "ws_main", name: "Main", createdAt: 0 },
    { id: "ws_two", name: "Two", createdAt: 0, tags: [{ name: "Investors", description: "From or about investors" }] },
  ],
  routines: [],
  watches: [],
  messages: [],
  sessions: [],
  channels: [],
};
let ready = true;
const fake = { jobs: [], answer: async () => ({ text: '{"tags": []}' }) };
globalThis.__fake = {
  "workspace-skills": { findSkill: () => undefined, skillRefId: (r) => r.slug },
  store: {
    getState: () => state,
    update: (fn) => fn(state),
    addMessage: (m) => {
      const msg = { id: `msg_${++seq}`, at: Date.now(), ...m };
      state.messages.push(msg);
      return msg;
    },
    bot: (id) => state.bots.find((b) => b.id === id),
    id: (p) => `${p}_${++seq}`,
    ownerName: () => state.owner?.name || "the user",
    patchSession: () => {},
    session: (id) => state.sessions.find((x) => x.id === id),
    stateReady: () => ready,
  },
  sessions: { startSession: () => ({ id: `ses_${++seq}` }) },
  analytics: { trackServerEvent: () => {} },
  attention: { pingIfWorthIt: () => {} },
  persist: { onPostgres: () => false },
  phone: { isOwner: () => false, ownerPhone: () => undefined, sendText: async () => {}, textingLine: () => undefined },
  mail: { ownerAddresses: () => [], sendEmail: async () => "" },
  channels: { postTo: async () => {} },
  chat: {
    backgroundTurn: async (botId, job) => {
      fake.jobs.push({ botId, job });
      return fake.answer(botId, job);
    },
  },
};

const C = await import("@/lib/routine-catalog");
const S = await import("@/lib/server/routine-suggestions");
const R = await import("@/lib/server/routines");
const settle = () => new Promise((r) => setTimeout(r, 20));

/* ---------------- The catalog ---------------- */

await check("every starter suggests 2 to 4 valid times, its own schedule among them, and the meeting prep runs before each meeting", async () => {
  const Sched = await import("@/cloud/schedule");
  for (const t of C.ROUTINE_TEMPLATES) {
    assert.ok(Array.isArray(t.suggested) && t.suggested.length >= 2 && t.suggested.length <= 4, `${t.id} suggests ${t.suggested?.length}`);
    const own = C.scheduleOf(t);
    assert.ok(t.suggested.some((p) => JSON.stringify(p.schedule) === JSON.stringify(own)), `${t.id}: its schedule isn't one of its suggestions`);
    const labels = new Set();
    const shapes = new Set();
    for (const p of t.suggested) {
      assert.ok(p.label && !labels.has(p.label), `${t.id}: label "${p.label}" empty or twice`);
      labels.add(p.label);
      noDashes(p.label, `${t.id} suggested label`);
      // Valid, and already as kept: normalizing it changes nothing.
      const n = Sched.normalizeSchedule(p.schedule);
      assert.ok(!("error" in n), `${t.id} "${p.label}": ${n.error}`);
      assert.deepEqual(n.schedule, p.schedule, `${t.id} "${p.label}" isn't in its kept shape`);
      assert.ok(!shapes.has(JSON.stringify(p.schedule)), `${t.id}: "${p.label}" is the same as another`);
      shapes.add(JSON.stringify(p.schedule));
      assert.ok(Number.isFinite(Sched.nextRun(p.schedule, Date.parse("2026-10-13T20:30:00Z"), "America/New_York")), `${t.id} "${p.label}" never comes due`);
      noDashes(Sched.describeSchedule(p.schedule, "America/New_York"), `${t.id} "${p.label}" described`);
    }
  }
  const byId = (id) => C.templateById(id);
  assert.deepEqual(byId("gmail-morning-inbox").suggested.map((p) => p.label), ["7:30 AM", "8 AM", "9 AM", "8 AM and 5 PM"]);
  assert.deepEqual(byId("gmail-alerts").suggested.map((p) => p.label), ["Every 15 minutes", "Every 30 minutes", "Every hour", "Every 30 minutes, 8 AM to 8 PM weekdays"]);
  assert.deepEqual(byId("gmail-weekly-follow-ups").suggested.slice(0, 2).map((p) => p.label), ["Monday 9 AM", "Friday 4 PM"]);
  const prep = byId("googlecalendar-meeting-prep");
  assert.deepEqual(prep.schedule, { kind: "before_event", minutes: 15, source: "googlecalendar" });
  assert.deepEqual(prep.suggested.map((p) => p.schedule.minutes), [10, 15, 30]);
  assert.equal(Sched.describeSchedule(prep.schedule), "15 minutes before each meeting");
  assert.equal(Sched.describeSchedule(prep.schedule), prep.when, "its when reads as its schedule");
  assert.equal(C.quietOf(prep), true, "a meeting check is quiet");
});

await check("every starter has an id, an app, a goal, a when and a kind, and no dashes", () => {
  const ids = new Set();
  assert.ok(C.ROUTINE_TEMPLATES.length >= 14, `only ${C.ROUTINE_TEMPLATES.length} starters`);
  for (const t of C.ROUTINE_TEMPLATES) {
    assert.ok(t.id && !ids.has(t.id), `id ${t.id} missing or twice`);
    ids.add(t.id);
    assert.ok(t.app && t.title && t.summary && t.when && t.goal, `${t.id} is missing words`);
    assert.ok(t.kind === "schedule" || t.kind === "monitor", `${t.id} kind ${t.kind}`);
    assert.equal(typeof t.defaultOn, "boolean");
    assert.ok(Array.isArray(t.neverWithoutAsking) && t.neverWithoutAsking.length, `${t.id} says nothing it asks first`);
    for (const [k, v] of Object.entries({ title: t.title, summary: t.summary, when: t.when, goal: t.goal, ...Object.fromEntries(t.neverWithoutAsking.map((x, i) => [`never${i}`, x])) })) noDashes(v, `${t.id} ${k}`);
    // Writes always ask first, and the goal says how it reads.
    assert.match(t.goal, /ask me first|Read only|never create|never (assign|change)/i, `${t.id} doesn't say writes ask first`);
    assert.match(t.goal, /use_app|call_api/, `${t.id} names no tool`);
    for (const tag of t.tags ?? []) assert.ok(C.DEFAULT_TAGS.some((d) => d.name === tag), `${t.id} tag ${tag} isn't a default`);
  }
});

await check("the catalog covers each app the task names, and alerts and monitors are quiet", () => {
  for (const app of ["gmail", "googlecalendar", "slack", "discord", "STRIPE_SECRET_KEY", "PLAIN_API_KEY", "hubspot", "attio"]) assert.ok(C.templatesFor(app).length, `nothing for ${app}`);
  assert.deepEqual(
    C.templatesFor("gmail").map((t) => t.id),
    ["gmail-morning-inbox", "gmail-alerts", "gmail-draft-replies", "gmail-weekly-follow-ups"],
  );
  assert.equal(C.templatesFor("Gmail").length, 4);
  assert.equal(C.templatesFor("STRIPE_API_KEY")[0].id, "stripe-daily-money");
  assert.deepEqual(C.templatesFor("notion"), []);
  for (const t of C.ROUTINE_TEMPLATES) if (t.kind === "monitor" || /alert/i.test(t.id)) assert.equal(C.quietOf(t), true, `${t.id} isn't quiet`);
  assert.equal(C.quietOf(C.templateById("gmail-morning-inbox")), false);
  // Stripe reads only, with GET.
  assert.match(C.templateById("stripe-daily-money").goal, /GET only/);
  assert.deepEqual(C.DEFAULT_TAGS.map((t) => t.name), ["Customer", "Outage", "Bug", "Office", "FYI"]);
  assert.deepEqual(
    C.tagsOf({ tags: [{ name: "customer", description: "x" }, { name: "Investors", description: "y" }] }).map((t) => t.name),
    ["Customer", "Outage", "Bug", "Office", "FYI", "Investors"],
  );
});

/* ---------------- Offering, turning on, putting off ---------------- */

await check("a connect offers the bot it was given to its starters, one at a time", () => {
  S.offerStarters("notion", ["bot_main"]);
  assert.equal(state.suggest, undefined);
  S.offerStarters("gmail", []);
  assert.equal(state.suggest, undefined);
  S.offerStarters("gmail", ["bot_gone", "bot_main"]);
  assert.equal(state.suggest.app, "gmail");
  assert.equal(state.suggest.botId, "bot_main");
  S.offerStarters("slack", ["bot_max"]);
  assert.deepEqual([state.suggest.app, state.suggest.botId], ["slack", "bot_max"]);
  // Clearing another app's leaves this one.
  S.clearSuggest({ app: "gmail", botId: "bot_main" });
  assert.equal(state.suggest.app, "slack");
  S.clearSuggest();
  assert.equal(state.suggest, undefined);
});

await check("turning starters on: routines owned by the bot, with source, tags, chat runs and quiet", async () => {
  S.offerStarters("gmail", ["bot_main"]);
  const out = S.acceptStarters("gmail", "bot_main", [{ id: "gmail-morning-inbox" }, { id: "gmail-alerts" }, { id: "gmail-draft-replies", schedule: { kind: "every", minutes: 20 } }]);
  assert.equal(out.created.length, 3);
  assert.equal(out.error, undefined);
  const made = out.created.map((id) => state.routines.find((r) => r.id === id));
  for (const r of made) {
    assert.equal(r.botId, "bot_main");
    assert.equal(r.run, "chat");
    assert.equal(r.source.app, "gmail");
    assert.equal(r.enabled, true);
    assert.ok(r.nextRunAt > Date.now());
  }
  assert.deepEqual(made.map((r) => r.source.template), ["gmail-morning-inbox", "gmail-alerts", "gmail-draft-replies"]);
  assert.deepEqual(made.map((r) => !!r.quiet), [false, true, true]);
  assert.deepEqual(made[0].schedule, { kind: "daily", time: "08:00" });
  assert.deepEqual(made[2].schedule, { kind: "every", minutes: 20 });
  assert.deepEqual(made[1].tags, ["Outage", "Customer"]);
  assert.equal(made[0].title, "Morning inbox");
  // Answered: the suggestion is gone.
  assert.equal(state.suggest, undefined);
  await settle();
});

await check("idempotent: a starter the bot runs already is offered as already and never made twice", () => {
  const before = state.routines.length;
  const again = S.acceptStarters("gmail", "bot_main", [{ id: "gmail-morning-inbox" }, { id: "gmail-weekly-follow-ups" }, { id: "gmail-weekly-follow-ups" }]);
  assert.equal(again.created.length, 1);
  assert.equal(state.routines.length, before + 1);
  const offers = S.offersFor("gmail", "bot_main");
  assert.deepEqual(offers.templates.map((t) => t.already), [true, true, true, true]);
  // Another bot runs none of them.
  assert.ok(S.offersFor("gmail", "bot_max").templates.every((t) => !t.already));
  // Everything already: nothing is offered after a connect again.
  S.offerStarters("gmail", ["bot_main"]);
  assert.equal(state.suggest, undefined);
  // A watch made from a starter counts too.
  state.watches.push({ id: "w1", botId: "bot_max", source: { app: "slack", template: "slack-support-watch" } });
  assert.equal(S.offersFor("slack", "bot_max").templates.find((t) => t.id === "slack-support-watch").already, true);
  state.watches.length = 0;
});

await check("refused: an unknown bot, an app with no starters, a starter of another app, a bad schedule", () => {
  assert.deepEqual(S.acceptStarters("gmail", "bot_none", [{ id: "gmail-alerts" }]), { created: [], error: "No such bot." });
  assert.equal(S.acceptStarters("notion", "bot_main", [{ id: "x" }]).error, "Bops has no routines for that app yet.");
  const other = S.acceptStarters("hubspot", "bot_main", [{ id: "gmail-alerts" }]);
  assert.deepEqual(other.created, []);
  assert.match(other.errors[0], /No routine called "gmail-alerts"/);
  const badTime = S.acceptStarters("hubspot", "bot_main", [{ id: "hubspot-weekly-deals", schedule: { kind: "daily", time: "99:99" } }]);
  assert.deepEqual(badTime.created, []);
  assert.match(badTime.errors[0], /Quiet deals and CRM cleanup: "99:99" isn't a time of day/);
  assert.deepEqual(S.offersFor("gmail", "bot_none"), { error: "No such bot." });
});

await check("set up for another bot than the one offered: the suggestion is answered all the same", () => {
  S.offerStarters("googlecalendar", ["bot_main"]);
  assert.deepEqual([state.suggest.app, state.suggest.botId], ["googlecalendar", "bot_main"]);
  const out = S.acceptStarters("googlecalendar", "bot_max", [{ id: C.templatesFor("googlecalendar")[0].id }]);
  assert.equal(out.created.length, 1);
  assert.equal(state.suggest, undefined);
});

await check("a Stripe key by its other name: the same starters, already on either way", () => {
  const made = S.acceptStarters("STRIPE_API_KEY", "bot_main", [{ id: "stripe-daily-money" }]);
  assert.equal(made.created.length, 1);
  assert.equal(state.routines.find((r) => r.id === made.created[0]).source.app, "STRIPE_SECRET_KEY");
  assert.equal(S.offersFor("STRIPE_API_KEY", "bot_main").templates[0].already, true);
  assert.equal(S.offersFor("STRIPE_SECRET_KEY", "bot_main").templates[0].already, true);
  assert.equal(C.canonicalApp("STRIPE_API_KEY"), "STRIPE_SECRET_KEY");
  assert.equal(C.appNameFor("STRIPE_API_KEY"), "Stripe");
  assert.equal(C.isKeyApp("PLAIN_API_KEY"), true);
  assert.equal(C.isKeyApp("googlecalendar"), false);
  // A suggestion made under one name is answered under the other.
  state.suggest = { app: "STRIPE_API_KEY", botId: "bot_main", at: Date.now() };
  S.clearSuggest({ app: "STRIPE_SECRET_KEY" });
  assert.equal(state.suggest, undefined);
});

await check("every starter's goal says writes ask first", () => {
  for (const t of C.ROUTINE_TEMPLATES) assert.match(t.goal, /Writes always ask me first\./, t.id);
});

/* ---------------- Learning tags ---------------- */

await check("turning on a Gmail starter learned tags once, from a read only sample, in the background", async () => {
  // The Gmail starters above already ran one sample (the fake answered no new tags).
  assert.equal(fake.jobs.length, 1);
  const { botId, job } = fake.jobs[0];
  assert.equal(botId, "bot_main");
  assert.equal(job.sample, true);
  assert.match(job.goal, /30 most recent emails/);
  assert.match(job.goal, /Read only/);
  assert.match(job.goal, /Customer \(/);
  noDashes(job.goal, "learn goal");
  assert.deepEqual(state.workspaces[0].tagsLearnedFrom, ["gmail"]);
  assert.equal(state.workspaces[0].tags, undefined);
  // Gmail again (another starter): no second sample.
  S.acceptStarters("gmail", "bot_main", []);
  await settle();
  assert.equal(fake.jobs.length, 1);
});

await check("proposed tags join the workspace's: new ones only, cleaned, said once in the chat", async () => {
  fake.answer = async () => ({
    text: '```json\n{"tags": [{"name": "Hiring", "description": "Candidates — interviews and offers"}, {"name": "investors", "description": "dup"}, {"name": "A very long tag name that is too long", "description": "x"}, {"name": "Invoices", "description": "Bills to pay"}, {"name": "Bug", "description": "dup of a default"}]}\n```',
  });
  const out = S.acceptStarters("slack", "bot_max", [{ id: "slack-support-watch" }]);
  assert.equal(out.created.length, 1);
  await settle();
  const ws = state.workspaces.find((w) => w.id === "ws_two");
  assert.deepEqual(ws.tags.map((t) => t.name), ["Investors", "Hiring", "Invoices"]);
  assert.equal(ws.tags[1].description, "Candidates, interviews and offers");
  assert.deepEqual(ws.tagsLearnedFrom, ["slack"]);
  const said = state.messages.find((m) => m.chatId?.includes("bot_max") && /New tags/.test(m.text));
  assert.ok(said, "no line about the tags");
  assert.equal(said.text, "New tags from your Slack: Hiring, Invoices. Your routines sort with them now.");
  // Not a tag learning app: no sample.
  const n = fake.jobs.length;
  S.acceptStarters("hubspot", "bot_max", [{ id: "hubspot-weekly-deals" }]);
  await settle();
  assert.equal(fake.jobs.length, n);
});

await check("a failed sample leaves the tags as they were", async () => {
  fake.answer = async () => ({ text: null, error: "Out of AI credit." });
  S.acceptStarters("discord", "bot_main", [{ id: "discord-support-watch" }]);
  await settle();
  assert.equal(state.workspaces[0].tags, undefined);
  assert.deepEqual(S.tagsFromAnswer("not json", C.DEFAULT_TAGS), []);
  assert.deepEqual(S.tagsFromAnswer('{"tags": "x"}', C.DEFAULT_TAGS), []);
});

/* ---------------- What the bot sees ---------------- */

await check("a bot sees its routines with their starters and tags, and the tags they sort with", () => {
  const note = R.routinesNote(["bot_max"]);
  const lines = note.split("\n");
  const watch = lines.find((l) => l.includes('"Slack support watch"'));
  assert.match(watch, /a starter for Slack/);
  assert.match(watch, /sorts with tags Customer, Bug, Outage, FYI/);
  assert.match(watch, /quiet/);
  assert.match(note, /when asked what you do on your own, say these in plain words/);
  assert.match(note, /Tags your routines sort with: Customer \(.*\); .*Investors \(From or about investors\); Hiring \(Candidates, interviews and offers\)/);
  noDashes(note.replace(/rtn_\w+/g, ""), "routinesNote");
  // A bot whose routines have no tags gets no tags line.
  state.bots.push({ id: "bot_plain", name: "Plain" });
  R.createRoutine("bot_plain", "Water", "Remind me", { kind: "daily", time: "09:00" }, { reminder: "Drink water" });
  assert.doesNotMatch(R.routinesNote(["bot_plain"]), /Tags your routines/);
});

/* ---------------- The routes ---------------- */

const route = await import("@/app/api/routines/suggestions/route");
const dismissRoute = await import("@/app/api/routines/suggestions/dismiss/route");
const get = (q) => new Request(`http://localhost/api/routines/suggestions?${q}`);
const post = (body, url = "http://localhost/api/routines/suggestions") => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

await check("GET lists a bot's starters for an app, with already", async () => {
  const res = await route.GET(get("app=googlecalendar&botId=bot_main"));
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.botId, "bot_main");
  assert.equal(j.app, "googlecalendar");
  assert.deepEqual(j.templates.map((t) => [t.id, t.already]), [["googlecalendar-todays-meetings", false], ["googlecalendar-meeting-prep", false]]);
  assert.ok(j.templates[0].goal && j.templates[0].when);
  assert.equal((await route.GET(get("app=gmail"))).status, 400);
  assert.equal((await route.GET(get("app=gmail&botId=bot_none"))).status, 404);
  assert.deepEqual((await (await route.GET(get("app=notion&botId=bot_main"))).json()).templates, []);
});

await check("POST turns starters on, idempotent; refusals come back as 400", async () => {
  const res = await route.POST(post({ app: "googlecalendar", botId: "bot_main", templates: [{ id: "googlecalendar-todays-meetings", schedule: { kind: "weekdays", time: "07:00" } }, { id: "googlecalendar-meeting-prep" }] }));
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.created.length, 2);
  const r = state.routines.find((x) => x.id === j.created[0]);
  assert.deepEqual(r.source, { app: "googlecalendar", template: "googlecalendar-todays-meetings" });
  assert.deepEqual(r.schedule, { kind: "weekdays", time: "07:00" });
  assert.equal(r.botId, "bot_main");
  assert.equal(state.routines.find((x) => x.id === j.created[1]).quiet, true);
  // Again: nothing new.
  const again = await (await route.POST(post({ app: "googlecalendar", botId: "bot_main", templates: [{ id: "googlecalendar-todays-meetings" }] }))).json();
  assert.deepEqual(again, { created: [] });
  assert.equal((await route.POST(post({ app: "googlecalendar", botId: "bot_main" }))).status, 400);
  assert.equal((await route.POST(post({ app: "googlecalendar", botId: "bot_none", templates: [] }))).status, 400);
  const wrong = await route.POST(post({ app: "googlecalendar", botId: "bot_main", templates: [{ id: "gmail-alerts" }] }));
  assert.equal(wrong.status, 400);
  noDashes((await wrong.json()).error, "route error");
  ready = false;
  assert.equal((await route.POST(post({ app: "googlecalendar", botId: "bot_main", templates: [] }))).status, 409);
  ready = true;
});

await check("dismiss clears the waiting suggestion", async () => {
  S.offerStarters("attio", ["bot_main"]);
  assert.equal(state.suggest.app, "attio");
  const res = await dismissRoute.POST(post({}, "http://localhost/api/routines/suggestions/dismiss"));
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(state.suggest, undefined);
});

await check("the window only: GET, POST and dismiss are refused from anywhere else", async () => {
  process.env.BOPS_UI_TOKEN = "window-token-for-tests";
  try {
    assert.equal((await route.GET(get("app=gmail&botId=bot_main"))).status, 403);
    assert.equal((await route.POST(post({ app: "attio", botId: "bot_main", templates: [{ id: "attio-weekly-deals" }] }))).status, 403);
    S.offerStarters("attio", ["bot_main"]);
    assert.equal((await dismissRoute.POST(post({}, "http://localhost/api/routines/suggestions/dismiss"))).status, 403);
    assert.equal(state.suggest.app, "attio");
    assert.ok(!state.routines.some((r) => r.source?.template === "attio-weekly-deals"));
    // With the window's token it works.
    const ok = new Request("http://localhost/api/routines/suggestions?app=attio&botId=bot_main", { headers: { cookie: "bops_window=window-token-for-tests" } });
    assert.equal((await route.GET(ok)).status, 200);
  } finally {
    delete process.env.BOPS_UI_TOKEN;
  }
});

await check("no dashes in anything the user saw", () => {
  for (const m of state.messages) noDashes(m.text, `message: ${m.text}`);
  for (const w of state.workspaces) for (const t of w.tags ?? []) noDashes(`${t.name} ${t.description}`, "tag");
});

clearInterval(globalThis.__bopsRoutines);
console.log(`${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
