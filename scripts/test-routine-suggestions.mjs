// Tests for starter routines: the catalog (lib/routine-catalog.ts: every starter has a goal, a when and a
// kind, says writes ask first, and has no dashes), offering, turning on and putting off starters
// (lib/server/routine-suggestions.ts, with the real lib/server/routines.ts), learning a workspace's tags
// from a sample (a fake background turn), the note the bots see, and the routes (app/api/routines/
// suggestions and its dismiss: the Bops window only; and DELETE /api/routines, where deleting a Connected
// App's check is its How often back at Only when asked).
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

/* ---------------- A Connected App's check (How often, picked when connecting) ---------------- */

const Sched = await import("@/cloud/schedule");
const hourly = { kind: "every", minutes: 60 };
const quarter = { kind: "every", minutes: 15 };
const morning = { kind: "daily", time: "08:00" };
const checksOf = (accountId) => state.routines.filter((r) => r.source?.template === "check" && r.source.account === accountId);

await check("How often's times are valid as kept, and say how many checks a day they are", () => {
  assert.deepEqual(C.CHECK_TIMES.map((t) => t.label), ["Every morning", "Every hour", "Every 15 minutes"]);
  assert.deepEqual(C.CHECK_TIMES.map((t) => t.schedule), [morning, hourly, quarter]);
  for (const t of C.CHECK_TIMES) {
    assert.deepEqual(Sched.normalizeSchedule(t.schedule).schedule, t.schedule, `${t.label} isn't in its kept shape`);
    noDashes(t.label, "a How often label");
  }
  assert.deepEqual(C.CHECK_TIMES.map((t) => Sched.runsADay(t.schedule)), [1, 24, 96], "all day: 24 and 96");
  assert.equal(Sched.runsADay({ kind: "every", minutes: 60, hours: { from: "08:00", to: "20:00" } }), 13, "both ends count, as nextRun runs them");
  assert.equal(Sched.runsADay({ kind: "every", minutes: 30, hours: { from: "08:00", to: "20:00" }, days: [1, 2, 3, 4, 5] }), 25);
  assert.equal(Sched.runsADay({ kind: "every", minutes: 60, hours: { from: "22:00", to: "06:00" } }), 9, "hours across midnight");
  assert.equal(Sched.runsADay({ kind: "every", minutes: 90 }), 16);
  assert.equal(Sched.runsADay({ kind: "daily", time: "08:00", times: ["08:00", "17:00"] }), 2);
  // Every 8 AM to 8 PM hour really does run 13 times on a weekday.
  const day = Date.parse("2026-10-13T04:00:00Z");
  let n = 0;
  for (let t = Sched.nextRun({ kind: "every", minutes: 60, hours: { from: "08:00", to: "20:00" } }, day, "America/New_York"); t < day + 86_400_000; t = Sched.nextRun({ kind: "every", minutes: 60, hours: { from: "08:00", to: "20:00" } }, t, "America/New_York", t)) n++;
  assert.equal(n, 13);
});

await check("who checks: the main bot when it was picked, else the first picked; nobody when none was", () => {
  const bots = [{ id: "a" }, { id: "m", isMain: true }, { id: "b" }];
  assert.equal(C.checkerOf(["a", "m"], bots).id, "m");
  assert.equal(C.checkerOf(["b", "a"], bots).id, "b");
  assert.equal(C.checkerOf(["gone", "a"], bots).id, "a");
  assert.equal(C.checkerOf([], bots), undefined);
});

await check("each How often makes one routine on the right bot: its schedule, a chat run, quiet through the day, its goal worded for the access", () => {
  state.bots.push({ id: "bot_iris", name: "Iris" }, { id: "bot_otto", name: "Otto" });
  state.accounts = [
    { id: "ca_work", app: "gmail", appName: "Gmail", label: "Work", name: "sam@acme.com", status: "active", at: 1, workspaceId: "ws_main" },
    { id: "ca_notion", app: "notion", appName: "Notion", name: "Acme wiki", status: "active", at: 1, workspaceId: "ws_main" },
    { id: "open:hackernews", app: "hackernews", appName: "Hacker News", status: "active", at: 1, workspaceId: "ws_main" },
  ];
  // What composio.ts gave when it connected: Read only for the bots picked.
  for (const id of ["bot_main", "bot_iris"]) (state.bots.find((b) => b.id === id).access ??= {}).ca_work = "read";
  const before = state.routines.length;

  // Every hour, Read only, Iris and the main bot picked: the main bot's.
  const work = S.makeCheck("ca_work", { bots: ["bot_iris", "bot_main"], level: "read", check: hourly }).routine;
  assert.equal(work.botId, "bot_main");
  assert.equal(work.title, "Check Gmail (Work)", "the account the user named");
  assert.deepEqual(work.schedule, hourly);
  assert.deepEqual([work.run, work.quiet, work.enabled], ["chat", true, true]);
  assert.deepEqual(work.source, { app: "gmail", template: "check", account: "ca_work" });
  assert.match(work.goal, /^Check my Gmail account "Work" for what's new since the last check/);
  assert.match(work.goal, /use_app with account "Work"/);
  assert.match(work.goal, /Tell me only what matters/);
  assert.match(work.goal, /Read only: don't send, post, reply, change or delete anything in Gmail\./);
  assert.match(work.goal, /If nothing new matters, answer NOTHING\.$/);
  assert.doesNotMatch(work.goal, /Handle/);

  // Every 15 minutes, Read & act, no main bot picked: the first picked; its account by its own name.
  const wiki = S.makeCheck("ca_notion", { bots: ["bot_iris", "bot_otto"], level: "act", check: quarter }).routine;
  assert.equal(wiki.botId, "bot_iris");
  assert.equal(wiki.title, "Check Notion");
  assert.deepEqual([wiki.schedule, wiki.quiet], [quarter, true]);
  assert.match(wiki.goal, /^Check my Notion account "Acme wiki"/);
  assert.match(wiki.goal, /Handle what's new that you can within your access/);
  assert.match(wiki.goal, /Anything that sends, posts, deletes or pays asks me first \(use_app asks me\)/);
  assert.match(wiki.goal, /If you're set to "Just do it", use_app won't ask, so don't do those here: say what you'd do\./, "asks before it sends on Just do it too");
  assert.match(wiki.goal, /Then tell me what you did and what still needs me\./);
  assert.doesNotMatch(wiki.goal, /Read only/);

  // Every morning, an app with no sign-in: 8 AM in the owner's zone, not quiet, a line when there's nothing.
  const hn = S.makeCheck("open:hackernews", { bots: ["bot_otto"], level: "read", check: morning }).routine;
  assert.equal(hn.botId, "bot_otto");
  assert.equal(hn.title, "Check Hacker News");
  assert.deepEqual([hn.schedule, hn.quiet, hn.timeZone], [morning, undefined, undefined]);
  assert.match(hn.goal, /^Check Hacker News for what's new .*\(find_app_actions, then use_app\)\./);
  assert.match(hn.goal, /If nothing new matters, say so in one line\.$/);
  const at = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(new Date(hn.nextRunAt));
  assert.equal(at, "08:00");

  assert.equal(state.routines.length, before + 3, "one routine each");
  for (const r of [work, wiki, hn]) noDashes(`${r.title} ${r.goal}`, r.title);
});

await check("no How often, no bot that can use it: nothing is made; connecting the same account again doesn't make a second", () => {
  const before = state.routines.length;
  assert.deepEqual(S.makeCheck("ca_work", { bots: ["bot_main"], level: "read" }), {}, "Only when asked");
  assert.deepEqual(S.makeCheck("ca_work", undefined), {});
  assert.match(S.makeCheck("ca_work", { bots: [], level: "read", check: hourly }).error, /No bot that can use it/);
  assert.match(S.makeCheck("ca_work", { bots: ["bot_max"], level: "read", check: hourly }).error, /No bot that can use it/, "another workspace's bot can't use it");
  assert.match(S.makeCheck("ca_gone", { bots: ["bot_main"], level: "read", check: hourly }).error, /No bot that can use it/);
  assert.equal(state.routines.length, before);
  // Again (connected again, or added again): the one it has.
  const first = checksOf("ca_work")[0];
  assert.equal(S.makeCheck("ca_work", { bots: ["bot_main"], level: "read", check: quarter }).routine.id, first.id);
  assert.equal(state.routines.length, before);
  assert.deepEqual(first.schedule, hourly, "left as it was");
  // Another bot picked for it later has a check of its own.
  const otto = S.makeCheck("ca_work", { bots: ["bot_otto"], level: "act", check: quarter }).routine;
  assert.equal(otto.botId, "bot_otto");
  assert.equal(checksOf("ca_work").length, 2);
});

await check("starters after a check: the same job isn't offered (a check through the day covers the watches and alerts, a morning check the once a day reads), the rest are", () => {
  // Otto checks Gmail every 15 minutes (above): the alerts and the draft replies are its job already.
  assert.deepEqual(S.offersFor("gmail", "bot_otto").templates.map((t) => t.id), ["gmail-morning-inbox", "gmail-weekly-follow-ups"]);
  // Iris has none: all four.
  assert.equal(S.offersFor("gmail", "bot_iris").templates.length, 4);
  // A morning check of Google Calendar: today's meetings is its job, the meeting prep isn't.
  state.accounts.push({ id: "ca_cal", app: "googlecalendar", appName: "Google Calendar", status: "active", at: 1, workspaceId: "ws_main" });
  S.makeCheck("ca_cal", { bots: ["bot_otto"], level: "read", check: morning });
  assert.deepEqual(S.offersFor("googlecalendar", "bot_otto").templates.map((t) => t.id), ["googlecalendar-meeting-prep"]);
  S.offerStarters("googlecalendar", ["bot_otto"]);
  assert.deepEqual([state.suggest.app, state.suggest.botId], ["googlecalendar", "bot_otto"], "what's left is still offered after the connect");
  S.clearSuggest();
  // Discord checked every 15 minutes and each morning: both starters are its job, so nothing is offered.
  state.accounts.push(
    { id: "ca_dc1", app: "discord", appName: "Discord", status: "active", at: 1, workspaceId: "ws_main" },
    { id: "ca_dc2", app: "discord", appName: "Discord", label: "Community", status: "active", at: 1, workspaceId: "ws_main" },
  );
  S.makeCheck("ca_dc1", { bots: ["bot_otto"], level: "read", check: quarter });
  S.makeCheck("ca_dc2", { bots: ["bot_otto"], level: "read", check: morning });
  assert.deepEqual(S.offersFor("discord", "bot_otto").templates, []);
  S.offerStarters("discord", ["bot_otto"]);
  assert.equal(state.suggest, undefined, "nothing left to offer");
  // The check removed: the starters are offered again.
  R.deleteRoutine(checksOf("ca_dc1")[0].id);
  assert.deepEqual(S.offersFor("discord", "bot_otto").templates.map((t) => t.id), ["discord-support-watch"]);
});

await check("a check is a routine like any other: the bot sees it with its account, and disconnecting drops it", () => {
  const note = R.routinesNote(["bot_main"]);
  const line = note.split("\n").find((l) => l.includes('"Check Gmail (Work)"'));
  assert.match(line, /Every hour/);
  assert.match(line, /chat run/);
  assert.match(line, /quiet/);
  assert.match(line, /checks Gmail \(Work · sam@acme\.com\), as Sam picked when connecting it/);
  noDashes(line.replace(/rtn_\w+/g, ""), "routinesNote");
  const others = state.routines.length - checksOf("ca_work").length;
  S.dropChecks("ca_work");
  assert.deepEqual(checksOf("ca_work"), []);
  assert.equal(state.routines.length, others, "only that account's");
  assert.equal(checksOf("ca_notion").length, 1);
});

await check("a check whose account went, is signed out or its bot can't use now doesn't run (use_app would take another account of the app), and says why once", async () => {
  const work = state.accounts.find((a) => a.id === "ca_work");
  state.accounts.push({ id: "ca_home", app: "gmail", appName: "Gmail", label: "Personal", status: "active", at: 1, workspaceId: "ws_main" });
  const r = S.makeCheck("ca_work", { bots: ["bot_main"], level: "read", check: hourly }).routine;
  const answer = fake.answer;
  fake.answer = async () => ({ text: "NOTHING" });
  const jobs = fake.jobs.length;
  const said = () => state.messages.filter((m) => m.role === "system" && m.text.startsWith('"Check Gmail (Work)" didn\'t run:')).map((m) => m.text);
  try {
    assert.equal((await R.runRoutine(r.id)).status, "quiet", "runs while it can");
    assert.equal(fake.jobs.length, jobs + 1);
    work.status = "expired";
    let run = await R.runRoutine(r.id);
    assert.deepEqual([run.status, run.error], ["failed", "Gmail (Work · sam@acme.com) is signed out. Sign in again in the Vault."]);
    await R.runRoutine(r.id);
    assert.equal(said().length, 1, "said once, not every hour");
    work.status = "active";
    state.bots.find((b) => b.id === "bot_main").access.ca_work = "none";
    run = await R.runRoutine(r.id);
    assert.equal(run.error, "Jev can't use Gmail (Work · sam@acme.com) now. Give it access in the Vault, or delete this routine.");
    state.accounts = state.accounts.filter((a) => a.id !== "ca_work");
    run = await R.runRoutine(r.id);
    assert.equal(run.error, "That Gmail account isn't connected anymore. Delete this routine, or connect it again in the Vault.");
    assert.equal(fake.jobs.length, jobs + 1, "never run on Personal instead");
    for (const t of said()) noDashes(t, "a check that can't run");
  } finally {
    fake.answer = answer;
    if (!state.accounts.includes(work)) state.accounts.push(work);
    state.accounts = state.accounts.filter((a) => a.id !== "ca_home");
    state.bots.find((b) => b.id === "bot_main").access.ca_work = "read";
    R.deleteRoutine(r.id);
  }
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

await check("a check deleted in the app (DELETE /api/routines) is its account back at Only when asked: no check left, the bot no longer told of it, its starters offered again; only from the Bops window", async () => {
  const routinesRoute = await import("@/app/api/routines/route");
  const del = (id, headers = {}) => new Request("http://localhost/api/routines", { method: "DELETE", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ id }) });
  // How often keeps nothing but the check itself (routine-catalog.ts CHECK_TEMPLATE): Iris checks Gmail every 15 minutes.
  const r = S.makeCheck("ca_work", { bots: ["bot_iris"], level: "read", check: quarter }).routine;
  assert.equal(r.botId, "bot_iris");
  assert.deepEqual(S.offersFor("gmail", "bot_iris").templates.map((t) => t.id), ["gmail-morning-inbox", "gmail-weekly-follow-ups"], "the check does the alerts and replies");
  assert.match(R.routinesNote(["bot_iris"]), /"Check Gmail \(Work\)"/);

  // From anywhere but the window: refused, and it stays.
  process.env.BOPS_UI_TOKEN = "window-token-for-tests";
  try {
    const no = await routinesRoute.DELETE(del(r.id));
    assert.equal(no.status, 403);
    assert.match((await no.json()).error, /only be changed in the Bops app/);
    assert.equal(checksOf("ca_work").length, 1);
    const ok = await routinesRoute.DELETE(del(r.id, { cookie: "bops_window=window-token-for-tests" }));
    assert.deepEqual([ok.status, await ok.json()], [200, { ok: true }]);
  } finally {
    delete process.env.BOPS_UI_TOKEN;
  }
  assert.deepEqual(checksOf("ca_work"), [], "Only when asked: nothing checks it");
  assert.doesNotMatch(R.routinesNote(["bot_iris"]), /Check Gmail/, "the bot isn't told of it anymore");
  assert.equal(S.offersFor("gmail", "bot_iris").templates.length, 4, "what the check did is offered again");
  // Deleted again, or one that's gone: still fine.
  assert.equal((await routinesRoute.DELETE(del(r.id))).status, 200);
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
