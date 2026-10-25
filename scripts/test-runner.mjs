// Tests for which Bops runs each routine (lib/server/runner.ts): what needs the Mac before a run starts (pinnedToMac;
// never a saved login, nor anything a run meets on the way), the split between the Mac and a computer's runner
// (runsHere: a runner's own routines while it's up, the Mac's the rest, the hand-over after a switch to This Mac),
// where the bots work as Orgo says (the Mac sets the default, Cloud, once, and goes by it only once Orgo took it; a
// runner never sets it and runs nothing on an answer a minute old, or from before a nap), the routines timer
// (routines.ts tick: each Bops its own, a runner only once it's read the state and Orgo again, none once a newer
// Bops wrote the state), making sure it's on its own computer (checkIdentity: a copy of the computer takes its runner
// off, its program and wrapper only, never the computer's Orgo key, which Orgo replaces; on its computer's identity
// its VMM is asked instead, never Orgo, and every minute: watchIdentity), a routine that texts its result run and
// texted from its computer's runner, and the routines mirror (routine-sync.ts: how each runs and whether it needs the
// Mac; a runner sends only its own, never with deleteMissing). A run on a runner runs there start to finish: one that
// waits on the owner's OK or on a sign in waits there, its status saying so, and is never handed to the Mac; a
// computer that's down or asleep with nothing waking it keeps its routines waiting, saying why (the real
// runner-install.ts look, end to end), and its runner runs them once it's up. A runner stopped while a run of its waits on
// the owner's OK (This Mac, its bot moved) keeps that run waiting, and stays on its computer till the run is over.
// Reminders and chat runs are always the Mac's (chat is the backend's; a computer is only for work that needs one): never a runner's, even with no Mac up
// (they run once one is, late), never waking a computer; a chat run that needs a computer starts a task from the Mac.
// A one-off is turned off as it fires, on the one Bops that runs it start to finish, so it never runs twice; a run of
// it that dies shows failed, and Run now runs it again. Move to your Mac finishes that time of a routine once.
//
// The store, Orgo, the nap detector and the modules a run talks to are fakes (below), so nothing reaches a
// real service or the user's data.
// Usage: node --conditions=react-server scripts/test-runner.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { unfaked } from "./fake-exports.mjs";
const { deviceIdOf } = await import(new URL("../cloud/device.ts", import.meta.url).href);

process.env.TZ = "America/New_York";
for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const FAKES = {
  store: ["addMessage", "bot", "flushState", "getState", "id", "ownerName", "ownSession", "patchSession", "pullState", "session", "startLanded", "stateDevice", "stateEpoch", "stateInCloud", "statePulledAt", "stateReady", "stateTooNew", "update"],
  orgo: ["apiKey", "callOrgo", "orgo"],
  awake: ["sleptSince", "awakeSince"],
  sessions: ["computerGone", "endSessionOf", "endSessionsOf", "startSession"],
  // What runner-install.ts (the look at the runners) talks to besides those.
  members: ["othersCanUse", "forgetGoneMembers"],
  "orgo-auth": ["orgoOrigin"],
  "persist-cloud": ["deviceIdFor"],
  analytics: ["trackServerEvent"],
  attention: ["pingIfWorthIt"],
  phone: ["isOwner", "ownerPhone", "sendText", "textingLine"],
  mail: ["ownerAddresses", "sendEmail"],
  channels: ["postTo", "toThemAlone"],
  chat: ["backgroundTurn"],
  "workspace-skills": ["findSkill", "skillRefId"],
  "vm-identity": ["identityHere", "identityVmId", "whoAmI"],
  // Where the Mac would send a routine's runs (where.ts routinePick: the user's app rules, then Jev).
  where: ["routinePick"],
  // What the vault (vault.ts: a saved login on a runner) talks to: no screen to read here, no Keychain.
  screens: ["screenEndpoint"],
  local: ["openPages", "onTab"],
  "screen-watch": ["readScreen"],
  "sign-in": ["submitSignIn"],
  keychain: ["getUserSecret", "setUserSecret", "deleteUserSecret"],
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
    // `orgo` is an object of calls (orgo.bash): each goes to the fake's of the same name.
    const one = (n) =>
      n === "orgo"
        ? `export const orgo = new Proxy({}, { get: (_, k) => (...a) => globalThis.__fake[${JSON.stringify(name)}].orgo[k](...a) });`
        : `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(name)}].${n}(...a);`;
    return { format: "module", shortCircuit: true, source: FAKES[name].map(one).join("\n") + unfaked(name, url, FAKES[name]) };
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DASHES = /[‒–—―]| - /;

const PID = "11111111-2222-4333-8444-555555555555";
const PID2 = "99999999-2222-4333-8444-555555555555";
const C1 = "c1c1c1c1-0000-4000-8000-000000000001";
const C2 = "c2c2c2c2-0000-4000-8000-000000000002";
const NOW = Date.now();
const up = (status, o = {}) => ({ status, version: "0.0.29", buildId: "b1", by: "mac-a", at: NOW, ...o });

let seq = 0;
const state = {};
/** A fresh state: Boppy (main) on C1 with Otto sharing it, Rook on C2 of its own, Penny set to work on the Mac, Nova (another workspace's main) with no computer yet; C1 has a runner up. */
function fresh() {
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, {
    account: { user: { id: "u1" }, signedInAt: 0 },
    owner: { name: "Sam", timeZone: "America/New_York" },
    workspaces: [
      { id: "ws_main", name: "Main", createdAt: 0, orgoProjectId: PID },
      { id: "ws_two", name: "Two", createdAt: 0, orgoProjectId: PID2 },
    ],
    bots: [
      { id: "boppy", name: "Boppy", isMain: true, computerId: C1, computerStatus: "ready" },
      { id: "otto", name: "Otto", isMain: false, computer: "shared", computerStatus: "none" },
      { id: "rook", name: "Rook", isMain: false, computer: "own", computerId: C2, computerStatus: "ready" },
      { id: "penny", name: "Penny", isMain: false, computer: "shared", runsOn: "mac", computerStatus: "none" },
      { id: "nova", name: "Nova", isMain: true, workspaceId: "ws_two", computerStatus: "none" },
    ],
    routines: [],
    sessions: [],
    messages: [],
    runners: { [C1]: up("running") },
  });
}
const routine = (id, botId, o = {}) => ({ id, botId, title: id, goal: "Check the news", schedule: { kind: "daily", time: "09:00" }, enabled: true, nextRunAt: NOW + 3_600_000, ...o });

let pulledAt = 0;
let napped = false;
/** The Mac (or a runner's computer) asleep until this time (awakeSince: awake since any time after it; sleptSince: a nap after any time before it), when set; and whose state is in (stateEpoch). */
let napAt;
/** When this Bops started (awake.ts started: it wasn't running before, quit or restarting), when set; else it ran all along. */
let startedAt;
let epoch = 1;
let tooNew = false;
const fake = { started: [], pulls: 0 };
// Orgo, faked: every call is kept, and `orgo.answer` says what it answers (null: no answer). A command
// on a computer reads back the runner's word from `nonceDir` when it's the computer `orgo.here` (the
// one this runner is really on), and says nothing from any other.
const nonceDir = mkdtempSync(join(tmpdir(), "bops-runner-nonce-"));
const orgo = { calls: [], answer: () => null, here: null, bash: [], status: {} };
const vmId = { here: false, who: null };
/** What the Mac's pick of where a routine's runs go says (where.ts routinePick), faked; null: no answer. */
let pickWhere = () => null;
/** What Bops Cloud does with a run's start a runner saves (startLanded), faked: takes it, unless a test says otherwise. */
let landing = () => true;
globalThis.__fake = {
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
    ownerName: () => "Sam",
    flushState: async () => true,
    // Whether Bops Cloud took a run's start made on a runner (store.ts startLanded): it did, unless a test says otherwise.
    startLanded: async (has) => landing(has),
    // A runner's own device is its computer's (persist-cloud.ts deviceIdFor), as Bops Cloud knows it.
    stateDevice: () => (process.env.BOPS_RUNNER === "1" && process.env.BOPS_RUNNER_COMPUTER ? deviceIdOf(state.account?.user?.id ?? "u", process.env.BOPS_RUNNER_COMPUTER) : "mac-a"),
    stateInCloud: () => true,
    stateEpoch: () => epoch,
    patchSession: (id, p) => {
      const t = state.sessions.find((x) => x.id === id);
      if (t) typeof p === "function" ? p(t) : Object.assign(t, p);
    },
    session: (id) => state.sessions.find((x) => x.id === id),
    stateReady: () => true,
    stateTooNew: () => tooNew,
    // Whether this Bops runs the thread (store.ts ownSession): one it started, or one from before threads said whose (the Mac's).
    ownSession: (s) => (s.by ? s.by === globalThis.__fake.store.stateDevice() : process.env.BOPS_RUNNER !== "1"),
    pullState: async () => {
      fake.pulls++;
      pulledAt = Date.now();
    },
    statePulledAt: () => pulledAt,
  },
  orgo: {
    apiKey: async () => "sk_test",
    callOrgo: async (key, path, init = {}) => {
      const c = { method: init.method ?? "GET", path, body: init.body === undefined ? undefined : JSON.parse(JSON.stringify(init.body)) };
      orgo.calls.push(c);
      if (path.endsWith("/routines")) return { status: 200, json: { routines: init.body.routines.map((r) => ({ id: `orgo-${r.bopsId}`, bopsId: r.bopsId })) } };
      return orgo.answer(c);
    },
    orgo: {
      // Each computer as Orgo has it (runner-install.ts asks before it holds one's routines).
      computer: async (id) => ({ id, status: orgo.status[id] ?? "running" }),
      bash: async (computer, command) => {
        orgo.bash.push({ computer, command });
        if (orgo.here === "down") throw new Error("Orgo didn't answer");
        // The guest's own time limit: Orgo answers 200 with what it said.
        if (orgo.here === "slow") return { output: "Command timed out after 20s", exit_code: 124 };
        let word = "";
        try {
          word = computer === (orgo.here ?? process.env.BOPS_RUNNER_COMPUTER) ? readFileSync(join(nonceDir, "nonce"), "utf8") : "";
        } catch {}
        return { output: `${word}\n${command.includes("echo __BOPS_NONCE_END__") ? "\n__BOPS_NONCE_END__\n" : ""}`, exit_code: 0 };
      },
    },
  },
  // The Mac asleep since (napped): neither awake through a routine's time (routines.ts tick skips what it missed).
  awake: { sleptSince: (t) => napped || (napAt !== undefined && napAt > t), awakeSince: (t) => (startedAt === undefined || startedAt <= t) && (napAt !== undefined ? t > napAt : !napped) },
  sessions: {
    computerGone: () => false,
    // As sessions.ts ends them: never a run paused for the owner's OK (lib/types.ts pausedForOk), unless its computer is gone.
    endSessionsOf: (device, why, opts = {}) => {
      for (const s of state.sessions) if (s.by === device && ["running", "starting", "queued"].includes(s.status) && (opts.gone || !globalThis.__pausedForOk(s, state))) Object.assign(s, { status: "failed", error: why });
    },
    endSessionOf: (id, device, why) => {
      const s = state.sessions.find((x) => x.id === id && x.by === device && ["running", "starting", "queued"].includes(x.status));
      if (s) Object.assign(s, { status: "failed", error: why, by: "mac-a" });
    },
    startSession: (o) => {
      fake.started.push(o);
      // Run by this Bops, as the real one's are (Session.by: a runner's own device).
      const s = { id: `ses_${++seq}`, botId: o.botId, chatId: o.chatId, title: o.title, goal: o.goal, status: "running", routineId: o.routineId, by: globalThis.__fake.store.stateDevice() };
      state.sessions.push(s);
      return s;
    },
  },
  analytics: { trackServerEvent: () => {} },
  attention: { pingIfWorthIt: () => {} },
  phone: { isOwner: () => false, ownerPhone: () => undefined, sendText: async () => {}, textingLine: () => undefined },
  mail: { ownerAddresses: () => [], sendEmail: async () => "" },
  channels: { postTo: async () => {}, toThemAlone: () => true },
  members: { othersCanUse: async () => false, forgetGoneMembers: async () => {} },
  "orgo-auth": { orgoOrigin: () => "https://orgo.example" },
  "persist-cloud": { deviceIdFor: (user, seed) => `device:${user}:${seed}` },
  chat: { backgroundTurn: async () => ({ text: "" }) },
  "workspace-skills": { findSkill: () => undefined, skillRefId: (r) => r.slug },
  // Its computer's identity (vm-identity.ts), faked: off unless a test says it's here, and which computer its VMM names.
  "vm-identity": { identityHere: () => vmId.here, identityVmId: () => "vm-a", whoAmI: async () => vmId.who },
  where: { routinePick: async (botId, goal) => pickWhere(botId, goal) },
  screens: { screenEndpoint: () => null },
  local: { openPages: async () => [], onTab: async () => null },
  "screen-watch": { readScreen: async () => null },
  "sign-in": { submitSignIn: async () => ({}) },
  keychain: { getUserSecret: async () => null, setUserSecret: async () => {}, deleteUserSecret: async () => {} },
};

const R = await import(`${root}/lib/server/runner.ts`);
const I = await import(`${root}/lib/server/runner-install.ts`);
const Sync = await import(`${root}/lib/server/routine-sync.ts`);
const Rt = await import(`${root}/lib/server/routines.ts`);
const V = await import(`${root}/lib/server/vault.ts`);
const { computerWait, DISPLAYS, onceDone, pausedForOk } = await import(`${root}/lib/types.ts`);
globalThis.__pausedForOk = pausedForOk;
const tick = () => globalThis.__bopsRoutineTick();
const T = Sync.routineSyncForTests;

const asMac = () => {
  delete process.env.BOPS_RUNNER;
  delete process.env.BOPS_RUNNER_COMPUTER;
};
const asRunner = (computer = C1) => {
  process.env.BOPS_RUNNER = "1";
  process.env.BOPS_RUNNER_COMPUTER = computer;
};
/** The runner on its computer's Orgo identity (vm-identity.ts): its VMM names `computer`, so its look before a run is no command on the computer. */
const onIdentity = (computer = C1) => {
  vmId.here = true;
  vmId.who = { desktopId: computer, vmId: "vm-a" };
};
let left = 0;
function reset() {
  asMac();
  fresh();
  R.runnerForTests.reset();
  I.runnerInstallForTests.reset();
  // What a copy takes off, in a folder of the test's (never the real paths).
  R.runnerForTests.identity({ nonceDir, leave: () => void left++, copyFiles: [join(nonceDir, "bops-runner.conf"), join(nonceDir, "run.sh")] });
  left = 0;
  vmId.here = false;
  vmId.who = null;
  orgo.here = null;
  orgo.bash.length = 0;
  orgo.status = {};
  T.reset();
  orgo.calls.length = 0;
  orgo.answer = () => null;
  pulledAt = 0;
  napped = false;
  napAt = undefined;
  startedAt = undefined;
  tooNew = false;
  // The routines timer ran this account's routines all along (routines.ts noteTick), unless a test says otherwise.
  Object.assign(globalThis, { __bopsTickedAt: Date.now(), __bopsTickingFrom: 0, __bopsTickEpoch: epoch });
  fake.started.length = 0;
  fake.pulls = 0;
  landing = () => true;
}
const byId = (id) => state.routines.find((r) => r.id === id);
/** Whether this Bops runs it (one that came to the Mac from a runner, with since when it's the Mac's: true). */
const here = (id) => {
  const x = R.runsHere(byId(id));
  return typeof x === "object" ? true : x;
};
/** Since when it's the Mac's, for one that was a runner's at its time (runner.ts CameHere); else what runsHere said. */
const cameHere = (id) => {
  const x = R.runsHere(byId(id));
  return typeof x === "object" ? x.since : x;
};

const settingsCloud = (c) => (c.path === "/api/bops/settings" ? { status: 200, json: { runsOn: "cloud" } } : null);
/** Orgo's copy of a routine of the main workspace as last sent. */
const lastSent = (id) => orgo.calls.filter((c) => c.method === "PUT" && c.path === `/api/projects/${PID}/routines`).at(-1)?.body.routines.find((x) => x.bopsId === id);
/** A one-off of Otto's (or `botId`'s) due at `at`. */
const once = (id, at, o = {}, botId = "otto") => routine(id, botId, { schedule: { kind: "once", at }, nextRunAt: at, ...o });

/* ---------------- What needs the Mac ---------------- */

await check("pinnedToMac: set to the Mac, or left to Bops with a bot on the Mac or Mac words; a result to Slack, Telegram or Discord, or a skill it follows; a reminder or a chat run always, set to the cloud or not", () => {
  const pin = (r, b = {}) => R.pinnedToMac({ goal: "Check the news", ...r }, b);
  assert.equal(pin({ where: "mac" }), true, "set to the Mac");
  assert.equal(pin({}), false, "left to Bops, nothing about the Mac");
  assert.equal(pin({ where: "auto" }, { runsOn: "mac" }), true, "its bot works on the Mac");
  assert.equal(pin({}, { runsOn: "cloud" }), false);
  assert.equal(pin({ goal: "Tidy the Downloads folder on my Mac" }), true, "Mac words");
  assert.equal(pin({ goal: "Back up my photos locally" }), true);
  assert.equal(pin({ where: "cloud", goal: "Tidy the files on my Mac" }, { runsOn: "mac" }), false, "set to the cloud: the cloud, whatever the bot or the words");
  // Chat is the backend's, and a bot's computer is only for work that needs one: a reminder or a chat run is the Mac's, always.
  assert.equal(pin({ reminder: "Stretch" }), true, "a reminder");
  assert.equal(pin({ where: "cloud", reminder: "Stretch" }, { runsOn: "cloud" }), true, "a reminder set to the cloud");
  assert.equal(pin({ run: "chat" }), true, "a chat run with nothing about the Mac");
  assert.equal(pin({ run: "chat", where: "cloud", goal: "Summarize the notes on my Mac" }, { runsOn: "cloud" }), true, "a chat run set to the cloud, its bot too");
  assert.equal(pin({ run: "chat", fromOutside: "an email from desk@hotel.example", where: "cloud" }), false, "someone else's is never a chat run: a task in the cloud");
  assert.equal(pin({ where: "mac" }, undefined), true, "its bot gone: as the routine says");
  // A runner can't post to a channel (the Mac's Keychain, no raw Composio calls) nor read a skill (synced to the Mac alone).
  const channel = { kind: "channel", linkId: "ch_tg", chat: "777" };
  assert.equal(pin({ where: "cloud", deliverTo: channel }, { runsOn: "cloud" }), true, "a result to Telegram, Slack or Discord");
  assert.equal(pin({ run: "chat", deliverTo: channel }), true, "a chat run's too");
  assert.equal(pin({ reminder: "Stretch", deliverTo: channel }), true, "and a reminder's");
  assert.equal(pin({ where: "cloud", deliverTo: { kind: "email" } }), false, "an email needs no Mac");
  assert.equal(pin({ where: "cloud", procedure: "invoice-export" }), true, "one that follows a skill");
  assert.equal(pin({ run: "chat", procedure: "invoice-export" }), true);
});

await check("pinnedToMac: a saved login no longer keeps a task on the Mac: its computer's runner runs it, and Orgo wakes that computer for it (a chat run is the Mac's anyway, for now)", () => {
  reset();
  const shop = "Every morning open my Shopify admin and tell me yesterday's orders";
  state.routines = [routine("r_shop", "boppy", { goal: shop }), routine("r_rook", "rook", { goal: shop }), routine("r_chat", "boppy", { goal: shop, run: "chat" })];
  state.vault = [{ id: "login1", site: "shopify.com", username: "ava@example.com", hasPassword: true, hasTotp: false, bots: "all", auto: true, addedAt: 0 }];
  const pin = (id) => R.pinnedToMac(byId(id), state.bots.find((b) => b.id === byId(id).botId));
  assert.equal(pin("r_shop"), false, "a login every bot may use: still its computer's");
  assert.equal(R.runnerRuns(byId("r_shop")), true, "C1's runner runs it");
  assert.equal(here("r_shop"), false, "not the Mac");
  assert.equal(Sync.routinePayload(byId("r_shop")).onMac, false, "Orgo wakes C1 for it");
  state.vault[0].bots = ["rook"];
  assert.equal(pin("r_rook"), false, "Rook's login: Rook's task isn't the Mac's for it either");
  assert.equal(pin("r_chat"), true, "a chat run: the Mac's anyway, for now");
  delete state.vault;
});

await check("pinnedToMac: a task whose bot has published skills of its workspace stays on the Mac, which alone has their files; a draft or another bot's doesn't", () => {
  reset();
  state.routines = [routine("r_report", "boppy", { goal: "Every Monday write the weekly report" }), routine("r_chat", "boppy", { run: "chat" }), routine("r_stretch", "boppy", { reminder: "Stretch" }), routine("r_rook", "rook")];
  const skill = { kind: "skill", slug: "weekly-report", name: "Weekly report", description: "How the report is written", status: "published", version: "1.0.0", botIds: [] };
  state.workspaces[0].skills = [{ ...skill, status: "draft" }];
  assert.equal(here("r_report"), false, "a draft: C1's runner runs it");
  state.workspaces[0].skills = [skill];
  const pin = (id) => R.pinnedToMac(byId(id), state.bots.find((b) => b.id === byId(id).botId));
  assert.equal(pin("r_report"), true, "a skill every bot has");
  assert.equal(pin("r_chat"), true, "a chat run: the Mac's anyway");
  assert.equal(pin("r_stretch"), true, "a reminder: the Mac's anyway");
  assert.equal(R.runnerRuns(byId("r_report")), false, "C1's runner doesn't run it");
  state.workspaces[0].skills = [{ ...skill, botIds: ["rook"] }];
  assert.equal(pin("r_report"), false, "only Rook's");
  assert.equal(pin("r_rook"), true);
  state.workspaces[0].skills = [];
  state.workspaces[0].apps = [{ ...skill, kind: "app", slug: "invoices", botIds: [] }];
  assert.equal(pin("r_report"), true, "an app it runs is a folder on the Mac too");
  state.workspaces[0].skills = [{ ...skill, botIds: [] }];
  state.workspaces[0].apps = [];
  assert.equal(R.pinnedToMac(routine("r_two", "nova"), state.bots.find((b) => b.id === "nova")), false, "another workspace's skill");
  delete state.workspaces[0].skills;
  delete state.workspaces[0].apps;
});

await check("in Cloud the Mac works out ahead of its runs where a task left to Bops would run: one it'd send to the Mac stays the Mac's and no runner takes it; worked out again for a new goal", async () => {
  reset();
  R.runnerForTests.hear("u1", "cloud");
  const msgs = "Every morning read my unread iMessages in Messages and summarize them";
  state.bots.push({ id: "cora", name: "Cora", isMain: false, computer: "shared", runsOn: "cloud", computerStatus: "none" });
  state.routines = [
    routine("r_msgs", "boppy", { goal: msgs }),
    routine("r_news", "boppy"),
    routine("r_set", "boppy", { where: "cloud", goal: msgs }),
    routine("r_nova", "nova", { goal: msgs }),
    routine("r_remind", "boppy", { reminder: "Stretch", goal: msgs }),
    routine("r_cora", "cora", { goal: msgs }),
    routine("r_chat_msgs", "boppy", { goal: msgs, run: "chat" }),
  ];
  const asked = [];
  pickWhere = (botId, goal) => (asked.push(goal), /iMessages/.test(goal) ? "mac" : "cloud");
  const until = async (ok) => {
    for (let i = 0; i < 100 && !ok(); i++) await sleep(5);
    assert.ok(ok(), "waited too long");
  };
  assert.equal(R.runnerRuns(byId("r_msgs")), true, "before the Mac's pick: C1's runner's");
  tick();
  await until(() => byId("r_msgs").macPick && byId("r_news").macPick);
  assert.deepEqual(byId("r_msgs").macPick, { goal: msgs, where: "mac" });
  assert.equal(R.runnerRuns(byId("r_chat_msgs")), false, "a chat run: the Mac's anyway");
  assert.deepEqual(byId("r_news").macPick, { goal: "Check the news", where: "cloud" });
  assert.deepEqual(
    ["r_set", "r_nova", "r_remind", "r_cora", "r_chat_msgs"].map((id) => byId(id).macPick),
    [undefined, undefined, undefined, undefined, undefined],
    "set to the cloud, no computer, a reminder, a bot set to work in the cloud, a chat run (the Mac's anyway): nothing to pick",
  );
  assert.equal(R.runnerRuns(byId("r_cora")), true, "Cora's runs on C1's runner");
  assert.equal(R.runnerRuns(byId("r_msgs")), false, "C1's runner doesn't run it");
  assert.equal(R.runnerRuns(byId("r_news")), true, "the news stays the runner's");
  asRunner();
  assert.equal(R.runnerRoutine(byId("r_msgs")), false, "the runner reads the same in the state");
  asMac();
  await T.flushAll();
  const put = orgo.calls.filter((c) => c.method === "PUT" && c.path === `/api/projects/${PID}/routines`).at(-1);
  assert.equal(put?.body.routines.find((r) => r.bopsId === "r_msgs")?.onMac, true, "Orgo hears the Mac runs it");
  // The same goal isn't worked out again; a new goal is, and a pick for another goal doesn't stand.
  asked.length = 0;
  tick();
  await sleep(30);
  assert.deepEqual(asked, [], "not asked again");
  byId("r_msgs").goal = "Every morning check the weather";
  assert.equal(R.runnerRuns(byId("r_msgs")), true, "its old pick doesn't stand");
  tick();
  await until(() => byId("r_msgs").macPick.goal === "Every morning check the weather");
  assert.equal(byId("r_msgs").macPick.where, "cloud");
  // No answer (no Mac Bops can use yet, Jev didn't answer): nothing kept, and not asked again for a while.
  pickWhere = (botId, goal) => (asked.push(goal), null);
  byId("r_msgs").goal = "Every morning read my Notes";
  asked.length = 0;
  tick();
  await until(() => asked.length === 1);
  await sleep(30);
  tick();
  await sleep(30);
  assert.deepEqual(asked, ["Every morning read my Notes"], "asked once");
  assert.equal(byId("r_msgs").macPick.goal, "Every morning check the weather", "nothing kept for it");
  // In This Mac the Mac runs them all: nothing to pick.
  R.runnerForTests.hear("u1", "mac");
  byId("r_news").goal = "Check the scores";
  asked.length = 0;
  tick();
  await sleep(30);
  assert.deepEqual(asked, []);
  pickWhere = () => null;
});

await check("a pick the Mac made while a bot was left to Bops stops counting once that bot is set to work in the cloud: its computer's runner runs it, and Orgo wakes the computer for it", () => {
  reset();
  R.runnerForTests.hear("u1", "cloud");
  const msgs = "Every morning read my unread iMessages in Messages and summarize them";
  state.routines = [routine("r_msgs", "boppy", { goal: msgs, macPick: { goal: msgs, where: "mac" } })];
  const boppy = state.bots.find((b) => b.id === "boppy");
  assert.equal(R.runnerRuns(byId("r_msgs")), false, "left to Bops: the Mac's pick keeps it the Mac's");
  boppy.runsOn = "cloud";
  assert.equal(R.pinnedToMac(byId("r_msgs"), boppy), false, "set to work in the cloud: its tasks go there whatever the Mac picked (where.ts chooseWhere)");
  assert.equal(R.runnerRuns(byId("r_msgs")), true, "C1's runner runs it");
  assert.equal(here("r_msgs"), false, "the Mac leaves it to that runner");
  assert.equal(Sync.routinePayload(byId("r_msgs")).onMac, false, "Orgo wakes C1 for it");
  asRunner();
  assert.equal(R.runnerRoutine(byId("r_msgs")), true, "the runner reads the same in the state");
  asMac();
  boppy.runsOn = "mac";
  assert.equal(R.runnerRuns(byId("r_msgs")), false, "set to work on the Mac: the Mac's");
  boppy.runsOn = "auto";
  assert.equal(R.runnerRuns(byId("r_msgs")), false, "left to Bops again: the pick for its goal stands");
  delete boppy.runsOn;
});

await check("a run on a computer's runner that reaches something needing the owner's OK waits there for their answer: its routine stays the runner's (the Mac's timer runs nothing for it, again or otherwise), Orgo keeps waking that computer for it, a next time due meanwhile is skipped as still going there, and the owner's Allow carries that run on to its end there", async () => {
  reset();
  seedRoutines();
  R.runnerForTests.hear("u1", "cloud");
  const runner = deviceIdOf("u1", C1);
  const now = Date.now();
  const r = byId("r_otto_task");
  // Its run going on C1, waiting on Sam's OK for an email (composio.ts askOwner): its thread's status, and the ask in the state.
  state.sessions.push({ id: "ses_ok", botId: "otto", chatId: "bot:otto", title: r.title, goal: r.goal, status: "running", routineId: r.id, by: runner, blocker: "approval", createdAt: now - 20 * 60_000, startedAt: now - 20 * 60_000, steps: [{ at: now - 15 * 60_000, tool: "computer", detail: "clicked (1, 1)" }], replies: [] });
  Object.assign(r, { nextRunAt: now + 3_600_000, lastRunAt: now - 20 * 60_000, last: { at: now - 20 * 60_000, status: "running", sessionId: "ses_ok", by: runner } });
  state.appApprovals = [{ id: "apr_ok", botId: "otto", sessionId: "ses_ok", routineId: r.id, by: runner, app: "email", action: "send_email", title: "Email Dana the summary", detail: "to: dana@acme.example", at: now - 15 * 60_000, status: "waiting" }];
  try {
    assert.equal(R.pinnedToMac(r, state.bots.find((b) => b.id === "otto")), false, "never the Mac's for it");
    assert.equal(R.runnerRuns(r), true, "C1's runner's still");
    assert.equal(here(r.id), false, "not the Mac's");
    tick();
    await sleep(20);
    assert.deepEqual(fake.started, [], "the Mac runs nothing for it");
    assert.deepEqual([r.last.sessionId, r.last.status, r.last.by], ["ses_ok", "running", runner], "its run is the one waiting");
    Sync.routineChanged("otto");
    await T.flushAll();
    assert.equal(lastSent(r.id)?.onMac, false, "Orgo keeps waking C1 for it");
    // Its next time comes while the run still waits: skipped there as still going, never moved.
    r.nextRunAt = Date.now() - 1000;
    asRunner(C1);
    onIdentity(C1);
    // (Seen with C1's runner on the Mac just now: in one process, not a hand-over.)
    R.runnerForTests.seen(r.id);
    orgo.answer = settingsCloud;
    tick();
    for (let i = 0; i < 50 && r.last.status !== "skipped"; i++) await sleep(10);
    assert.deepEqual([r.last.status, r.last.error, r.last.sessionId], ["skipped", "The last run was still going.", "ses_ok"]);
    assert.deepEqual(fake.started, [], "no second run");
    // Sam allows it on the Mac (state-merge.ts brings the answer in): the thread goes on and ends there, that run's end.
    Object.assign(state.appApprovals[0], { status: "allowed", answeredAt: Date.now(), answeredBy: "mac-a" });
    delete state.sessions.find((x) => x.id === "ses_ok").blocker;
    await threadEnds("ses_ok", "Sent Dana the summary.");
    assert.deepEqual([r.last.status, r.last.sessionId, r.last.by], ["ok", "ses_ok", runner], "one run, ended on the runner");
  } finally {
    asMac();
    delete state.appApprovals;
    T.reset();
  }
});

/* ---------------- The split, on the Mac ---------------- */

function seedRoutines() {
  state.routines = [
    routine("r_boppy", "boppy"),
    routine("r_boppy_mac", "boppy", { where: "mac" }),
    routine("r_boppy_words", "boppy", { goal: "Clean up the desktop on my Mac" }),
    routine("r_otto_reminder", "otto", { reminder: "Stand up" }),
    routine("r_otto_chat", "otto", { run: "chat" }),
    routine("r_otto_task", "otto", { goal: "Check the orders" }),
    routine("r_rook", "rook"),
    routine("r_penny", "penny"),
    routine("r_nova", "nova"),
  ];
}

await check("the Mac leaves a computer's tasks to its runner while it's up, and runs the rest", () => {
  reset();
  seedRoutines();
  assert.equal(here("r_boppy"), false, "C1's runner is up");
  assert.equal(here("r_otto_task"), false, "a bot sharing C1: its runner's");
  // A reminder or a chat run needs no computer: always the Mac's, waiting on nothing.
  assert.equal(here("r_otto_reminder"), true, "a reminder: the Mac's");
  assert.equal(here("r_otto_chat"), true, "a chat run: the Mac's");
  assert.equal(here("r_boppy_mac"), true, "set to the Mac");
  assert.equal(here("r_boppy_words"), true, "Mac words");
  assert.equal(here("r_penny"), true, "its bot works on the Mac");
  assert.equal(here("r_rook"), true, "C2 has no runner");
  assert.equal(here("r_nova"), true, "no computer yet");
  assert.equal(R.runsHere(routine("r_gone", "nobody")), true, "its bot gone: the Mac says so when it comes due");
  for (const status of ["installing", "failed"]) {
    R.runnerForTests.seen("r_boppy");
    state.runners[C1] = up(status);
    assert.equal(here("r_boppy"), true, `a runner ${status} the Mac never saw up: the Mac's`);
  }
  state.runners[C1] = up("stopping", { at: Date.now() - 10_000 });
  assert.equal(here("r_boppy"), false, "being stopped, not confirmed: still the runner's");
  state.runners[C1] = up("stopping", { at: Date.now() - R.HANDOVER_MS - 1000 });
  R.runnerForTests.seen("r_boppy", R.HANDOVER_MS + 1000);
  assert.equal(here("r_boppy"), true, "not confirmed after the hand-over time: the Mac's");
  delete state.runners[C1];
  assert.equal(here("r_boppy"), true, "stopped (no runner): the Mac's");
});

/* ---------------- Reminders and chat runs: always the Mac's ---------------- */

/** Orgo's copy of each routine of the main workspace as last sent: whether the Mac runs it (so Orgo never wakes a computer for it). */
const lastOnMac = () => Object.fromEntries((orgo.calls.filter((c) => c.method === "PUT" && c.path === `/api/projects/${PID}/routines`).at(-1)?.body.routines ?? []).map((x) => [x.bopsId, x.onMac]));

await check("a reminder and a chat run are always the Mac's: a runner never runs one, even due with no Mac up and its computer up anyway, and has no work for it; the Mac runs them as before runners, and Orgo is told so (onMac), so it never wakes or keeps up a computer for them; a task of the same bot goes to Orgo onMac false and its runner runs it", async () => {
  reset();
  seedRoutines();
  R.runnerForTests.hear("u1", "cloud");
  const turns = [];
  const was = globalThis.__fake.chat.backgroundTurn;
  globalThis.__fake.chat.backgroundTurn = async (botId, o) => (turns.push([process.env.BOPS_RUNNER === "1" ? "runner" : "mac", o.routineId]), { text: "Two new emails from Dana." });
  try {
    for (const r of state.routines) r.nextRunAt = Date.now() + 3_600_000;
    for (const id of ["r_otto_reminder", "r_otto_chat", "r_otto_task"]) byId(id).nextRunAt = Date.now() - 1000;
    // C1's runner, up, on its identity, with no Mac of the user's up: only the task is its own.
    asRunner(C1);
    onIdentity(C1);
    orgo.answer = settingsCloud;
    for (const id of ["r_otto_reminder", "r_otto_chat"]) assert.equal(R.runnerRoutine(byId(id)), false, `${id}: never C1's runner's`);
    assert.equal(R.runnerRoutine(byId("r_otto_task")), true, "a task: C1's runner's");
    tick();
    for (let i = 0; i < 50 && !fake.started.length; i++) await sleep(10);
    await sleep(20);
    assert.deepEqual(fake.started.map((o) => [o.routineId, o.where]), [["r_otto_task", "cloud"]], "the runner ran the task, on its computer");
    assert.deepEqual(turns, [], "no chat run there");
    assert.ok(!state.messages.some((m) => m.text === "Stand up"), "nor the reminder");
    assert.deepEqual([byId("r_otto_chat").last, byId("r_otto_reminder").last], [undefined, undefined], "nothing recorded for them");
    assert.equal(R.runnerHasWork(), false, "a reminder and a chat run due are no work of the runner's: nothing to look at its computer for");
    // Its own copy to Orgo has only its own routines: the Mac sends the rest.
    orgo.calls.length = 0;
    Sync.routineChanged("otto");
    await T.flushAll();
    assert.deepEqual(Object.keys(lastOnMac()).sort(), ["r_boppy", "r_otto_task"]);
    asMac();
    fake.started.length = 0;
    // One process plays both here: what the runner noted of them as not its own isn't the Mac's.
    for (const id of ["r_otto_reminder", "r_otto_chat"]) R.runnerForTests.seen(id);
    // The Mac runs them, waiting on nothing (no word to wait for, no hand-over: they were never a runner's).
    tick();
    for (let i = 0; i < 50 && !turns.length; i++) await sleep(10);
    assert.ok(state.messages.some((m) => m.role === "bot" && m.botId === "otto" && m.text === "Stand up"), "the reminder, posted by the Mac");
    assert.deepEqual(turns, [["mac", "r_otto_chat"]], "the chat run's turn, on the Mac");
    assert.deepEqual(fake.started, [], "no thread on a computer for them");
    assert.deepEqual([byId("r_otto_chat").last?.by, byId("r_otto_reminder").last?.by], [undefined, undefined], "the Mac's runs");
    // The mirror: both the Mac's, so Orgo's waker never wakes C1 for them, nor does its idle suspend wait on them; the task is C1's.
    orgo.calls.length = 0;
    Sync.routineChanged("otto");
    await T.flushAll();
    const onMac = lastOnMac();
    assert.deepEqual(
      ["r_otto_reminder", "r_otto_chat", "r_otto_task", "r_boppy"].map((id) => [id, onMac[id]]),
      [
        ["r_otto_reminder", true],
        ["r_otto_chat", true],
        ["r_otto_task", false],
        ["r_boppy", false],
      ],
    );
  } finally {
    globalThis.__fake.chat.backgroundTurn = was;
    asMac();
    T.reset();
  }
});

await check("while no Mac is up a reminder or a chat run waits for one, as in v0.0.29: a runner whose computer is up anyway for a task runs neither; the Mac up again runs each once, late, and says so", async () => {
  reset();
  seedRoutines();
  R.runnerForTests.hear("u1", "cloud");
  const turns = [];
  const was = globalThis.__fake.chat.backgroundTurn;
  globalThis.__fake.chat.backgroundTurn = async (botId, o) => (turns.push([process.env.BOPS_RUNNER === "1" ? "runner" : "mac", o.routineId]), { text: "Nothing new from Dana." });
  try {
    // Daily, due half an hour ago (its next time tomorrow: a missed run runs late).
    const nowNY = new Date().toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
    const hm = (m) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, "0")}:${String((((m % 1440) + 1440) % 1440) % 60).padStart(2, "0")}`;
    const mins = Number(nowNY.slice(0, 2)) * 60 + Number(nowNY.slice(3, 5));
    const due = Date.now() - 30 * 60_000;
    for (const r of state.routines) r.nextRunAt = Date.now() + 3_600_000;
    for (const id of ["r_otto_reminder", "r_otto_chat"]) Object.assign(byId(id), { schedule: { kind: "daily", times: [hm(mins - 30)] }, nextRunAt: due });
    // The Mac asleep since before their time (or quit); C1 up for a task of its own, its runner ticking.
    state.sessions.push({ id: "ses_c1", botId: "boppy", chatId: "bot:boppy", title: "The user's own", goal: "x", status: "running", by: deviceIdOf("u1", C1) });
    asRunner(C1);
    onIdentity(C1);
    orgo.answer = settingsCloud;
    for (let i = 0; i < 3; i++) {
      tick();
      await sleep(20);
    }
    assert.deepEqual(turns, [], "no chat run on the runner");
    assert.ok(!state.messages.some((m) => m.text === "Stand up"), "nor the reminder");
    assert.deepEqual([byId("r_otto_chat").nextRunAt, byId("r_otto_reminder").nextRunAt], [due, due], "both still due, for the Mac");
    asMac();
    for (const id of ["r_otto_reminder", "r_otto_chat"]) R.runnerForTests.seen(id);
    // The Mac up again after sleeping through their time: each runs once, late, as before runners.
    napAt = due + 60_000;
    tick();
    for (let i = 0; i < 50 && !turns.length; i++) await sleep(10);
    assert.deepEqual(turns, [["mac", "r_otto_chat"]]);
    const said = state.messages.filter((m) => m.botId === "otto" || m.chatId === "bot:otto").map((m) => m.text);
    assert.ok(said.includes("Stand up") && said.includes("Nothing new from Dana."), said.join(" | "));
    assert.equal(said.filter((t) => /^Routine · .* · late, it was due /.test(t)).length, 2, "each said late");
    assert.ok(byId("r_otto_chat").nextRunAt > Date.now() && byId("r_otto_reminder").nextRunAt > Date.now(), "their next times moved on");
    turns.length = 0;
    tick();
    await sleep(20);
    assert.deepEqual(turns, [], "once");
  } finally {
    globalThis.__fake.chat.backgroundTurn = was;
    asMac();
    T.reset();
  }
});

await check("a chat run is the Mac's with a saved login or without; one whose turn needs a computer starts the routine's task from the Mac, which runs it on its bot's computer as any task it starts (where.ts), recorded as the run", async () => {
  reset();
  R.runnerForTests.hear("u1", "cloud");
  state.routines = [routine("r_orders", "boppy", { run: "chat", goal: "Check yesterday's Shopify orders", nextRunAt: Date.now() - 1000 })];
  asRunner(C1);
  onIdentity(C1);
  assert.equal(R.runnerRoutine(byId("r_orders")), false, "no saved login: still not C1's runner's");
  state.vault = [{ id: "login1", site: "shopify.com", username: "ava@example.com", hasPassword: true, hasTotp: false, bots: "all", auto: true, addedAt: 0 }];
  assert.equal(R.runnerRoutine(byId("r_orders")), false, "a saved login Boppy may use: the Mac's too");
  asMac();
  assert.equal(R.pinnedToMac(byId("r_orders"), state.bots[0]), true);
  assert.equal(here("r_orders"), true, "the Mac runs it, waiting on nothing");
  assert.equal(Sync.routinePayload(byId("r_orders")).onMac, true);
  const was = globalThis.__fake.chat.backgroundTurn;
  // Its turn needs a screen: it starts the routine's own task (chat.ts start_task in a routine's run: where the routine runs, else left to Bops).
  globalThis.__fake.chat.backgroundTurn = async (botId, o) => {
    const s = globalThis.__fake.sessions.startSession({ botId, goal: "Open the Shopify admin and list yesterday's orders.", title: "Shopify orders", chatId: `bot:${botId}`, sentVia: "routine", where: byId(o.routineId).where ?? "auto", fresh: true, routineId: o.routineId });
    return { text: "Checking Shopify.", sessionId: s.id };
  };
  try {
    tick();
    for (let i = 0; i < 50 && byId("r_orders").last?.sessionId === undefined; i++) await sleep(10);
    assert.deepEqual(fake.started.map((o) => [o.routineId, o.where]), [["r_orders", "auto"]], "started from the Mac, left to Bops: in Cloud a task of a bot with a computer goes to it");
    const t = state.sessions.find((x) => x.id === byId("r_orders").last.sessionId);
    assert.equal(t?.by, "mac-a", "the Mac runs the thread, as v0.0.29 did");
    assert.deepEqual([byId("r_orders").last.status, byId("r_orders").last.by], ["running", undefined], "the thread is the run");
  } finally {
    globalThis.__fake.chat.backgroundTurn = was;
    delete state.vault;
    T.reset();
  }
});

await check("on a computer's runner, a routine's thread that hits a sign in waits there, Needs you to sign in (with the way to its computer's screen): its run is never handed to the Mac, nothing is said of the Mac, and the bot is told to wait for the user", async () => {
  reset();
  R.runnerForTests.hear("u1", "cloud");
  const runner = deviceIdOf("u1", C1);
  // A task of Boppy's going on C1's runner; a Shopify login saved on the Mac (its password in the Mac's Keychain alone).
  state.routines = [routine("r_shop", "boppy", { title: "Shopify orders", goal: "Check yesterday's Shopify orders", last: { at: Date.now() - 60_000, status: "running", sessionId: "ses_shop", by: runner } })];
  state.sessions.push({ id: "ses_shop", botId: "boppy", chatId: "bot:boppy", title: "Shopify orders", goal: "Check yesterday's Shopify orders", status: "running", routineId: "r_shop", by: runner });
  state.vault = [{ id: "login1", site: "shopify.com", username: "ava@example.com", hasPassword: true, hasTotp: false, bots: "all", auto: true, addedAt: 0 }];
  const t = state.sessions.find((x) => x.id === "ses_shop");
  asRunner(C1);
  try {
    const said = await V.vaultSignIn("boppy", DISPLAYS[0], "ses_shop");
    assert.equal(said, "Sam's saved logins sign in only from Bops on their Mac, not here. Say in one short line that you need Sam to sign in on your screen, and stop there: once they have, you carry on.");
    assert.ok(!DASHES.test(said), "no dashes");
    assert.equal(t.blocker, "sign_in", "Needs you to sign in");
    assert.deepEqual(state.messages.filter((m) => /Mac/.test(m.text ?? "")), [], "nothing said of the Mac");
    assert.equal(R.runnerRoutine(byId("r_shop")), true, "still the runner's");
    // The bot says so and its turn ends: the thread waits on Sam, and the run's end is recorded there.
    t.status = "done";
    await Rt.onRoutineTaskEnd(t, "I need you to sign in to Shopify on my screen.");
    assert.deepEqual([byId("r_shop").last.status, byId("r_shop").last.by], ["ok", runner]);
  } finally {
    asMac();
  }
  tick();
  await sleep(10);
  assert.deepEqual(fake.started, [], "the Mac runs nothing again for it");
  assert.equal(here("r_shop"), false, "its runner's");
  delete state.vault;
  T.reset();
});

/* ---------------- One-offs: done as they fire, on the one Bops that runs them ---------------- */

/** Thread `sessionId` ends with `answer` (a failure when `failure`), as sessions.ts tells its routine. */
async function threadEnds(sessionId, answer, failure) {
  const t = state.sessions.find((x) => x.id === sessionId);
  t.status = failure ? "failed" : "done";
  t.endedAt = Date.now();
  await Rt.onRoutineTaskEnd(t, answer, failure);
}

await check("a one-off is done as it fires, on the one Bops that runs it start to finish: its runner runs its task once, even while that run waits on the owner's OK, and nothing runs it again (the runner, the Mac, Orgo's waker); a chat run's and a reminder's on the Mac alike", async () => {
  reset();
  R.runnerForTests.hear("u1", "cloud");
  const runner = deviceIdOf("u1", C1);
  const at = Date.now() - 1000;
  state.routines = [once("r_task", at, { title: "Send the proposal", goal: "Email Dana the proposal" }), once("r_chat", at, { title: "Price check", run: "chat" }), once("r_remind", at, { title: "Call Max", reminder: "Call Max" })];
  const turns = [];
  const was = globalThis.__fake.chat.backgroundTurn;
  globalThis.__fake.chat.backgroundTurn = async (botId, o) => (turns.push(o.routineId), { text: "It's $40, under your $50." });
  try {
    // The task, on C1's runner.
    asRunner(C1);
    onIdentity(C1);
    orgo.answer = settingsCloud;
    tick();
    for (let i = 0; i < 50 && !fake.started.length; i++) await sleep(10);
    const task = byId("r_task");
    assert.deepEqual(fake.started.map((o) => o.routineId), ["r_task"], "only the task on the runner");
    assert.deepEqual([task.enabled, task.nextRunAt, task.last.status, task.last.by], [false, undefined, "running", runner], "off as it fires, its run going");
    assert.ok(onceDone(task), "Done in the app");
    // That run waits on Sam's OK there (composio.ts askOwner): its thread's status, and the ask in the state.
    const t = state.sessions.find((x) => x.id === task.last.sessionId);
    t.blocker = "approval";
    state.appApprovals = [{ id: "apr_once", botId: "otto", sessionId: t.id, routineId: "r_task", by: runner, app: "email", action: "send_email", title: "Email Dana the proposal", detail: "to: dana@acme.example", at: Date.now(), status: "waiting" }];
    orgo.calls.length = 0;
    Sync.routineChanged("otto");
    await T.flushAll();
    assert.deepEqual([lastSent("r_task")?.enabled, lastSent("r_task")?.nextRunAt], [false, undefined], "Orgo is sent no next time: it wakes nothing for it again");
    // Ticks on the runner and on the Mac meanwhile: nothing runs it again, nothing hands it anywhere.
    for (let i = 0; i < 2; i++) {
      tick();
      asMac();
      tick();
      asRunner(C1);
      await sleep(20);
    }
    assert.equal(fake.started.length, 1, "never run twice");
    // Allowed: the same run goes on and ends.
    state.appApprovals[0].status = "allowed";
    delete t.blocker;
    await threadEnds(t.id, "Sent it to Dana.");
    assert.deepEqual([task.enabled, task.nextRunAt, task.last.status, task.last.sessionId], [false, undefined, "ok", t.id], "one run, start to finish");
    tick();
    asMac();
    tick();
    await sleep(20);
    assert.equal(fake.started.length, 1, "and never again");
  } finally {
    asMac();
    delete state.appApprovals;
  }
  try {
    // The chat run and the reminder, on the Mac: off as each fires too.
    for (const id of ["r_chat", "r_remind"]) R.runnerForTests.seen(id);
    tick();
    for (let i = 0; i < 50 && byId("r_chat").last?.status !== "ok"; i++) await sleep(10);
    for (const id of ["r_chat", "r_remind"]) assert.deepEqual([byId(id).enabled, byId(id).nextRunAt, byId(id).last.status], [false, undefined, "ok"], id);
    tick();
    await sleep(20);
    assert.deepEqual(turns, ["r_chat"], "never run twice");
    assert.equal(state.messages.filter((m) => m.text === "Call Max").length, 1, "the reminder once");
  } finally {
    globalThis.__fake.chat.backgroundTurn = was;
    T.reset();
  }
});

await check("a one-off's run that dies (its computer stopped, Bops restarted mid-run) shows failed, and stays done: nothing runs it again by itself, and Run now runs it again when Sam asks", async () => {
  reset();
  R.runnerForTests.hear("u1", "cloud");
  const at = Date.now() - 1000;
  state.routines = [once("r_once", at, { title: "Send the proposal", goal: "Email Dana the proposal" })];
  asRunner(C1);
  onIdentity(C1);
  orgo.answer = settingsCloud;
  try {
    tick();
    for (let i = 0; i < 50 && !fake.started.length; i++) await sleep(10);
  } finally {
    asMac();
  }
  const r = byId("r_once");
  // Its computer was stopped mid-run (runner-install.ts ends that thread, saying why).
  await threadEnds(r.last.sessionId, undefined, "Stopped: its computer was stopped.");
  assert.deepEqual([r.enabled, r.last.status, r.last.error], [false, "failed", "Stopped: its computer was stopped."], "failed, and why");
  assert.ok(onceDone(r));
  fake.started.length = 0;
  tick();
  asRunner(C1);
  tick();
  asMac();
  await sleep(20);
  assert.deepEqual(fake.started, [], "never run again by itself");
  await Rt.runRoutine("r_once", { manual: "app" });
  assert.deepEqual(fake.started.map((o) => o.routineId), ["r_once"], "Run now runs it again");
  T.reset();
});

await check("Move to your Mac on a computer's run of a routine finishes that time of it once: the run follows the Mac's thread, the computer's thread's end is no end of it, the Mac thread's end is, and it's never due again for the move (a one-off stays done)", async () => {
  for (const kind of ["daily", "once"]) {
    reset();
    R.runnerForTests.hear("u1", "cloud");
    const runner = deviceIdOf("u1", C1);
    const now = Date.now();
    const next = now + 20 * 3_600_000;
    state.routines = [
      kind === "once" ? once("r_move", now - 60_000, { enabled: false, nextRunAt: undefined, lastRunAt: now - 60_000 }) : routine("r_move", "boppy", { nextRunAt: next, lastRunAt: now - 60_000 }),
    ];
    const r = byId("r_move");
    state.sessions.push({ id: "ses_cloud", botId: r.botId, chatId: `bot:${r.botId}`, title: r.title, goal: r.goal, status: "running", routineId: r.id, by: runner });
    r.last = { at: now - 60_000, status: "running", sessionId: "ses_cloud", by: runner };
    // sessions.ts moveToMac: the run follows the Mac's new thread, the Mac's now; the cloud one is asked to stop.
    state.sessions.push({ id: "ses_mac", botId: r.botId, chatId: `bot:${r.botId}`, title: r.title, goal: r.goal, status: "running", routineId: r.id, by: "mac-a", runsOn: "mac", movedFrom: "ses_cloud" });
    r.last.sessionId = "ses_mac";
    delete r.last.by;
    // The runner stops its thread: no end of the routine's run, and nothing recorded over the Mac's.
    asRunner(C1);
    try {
      await threadEnds("ses_cloud", undefined, "Moved to your Mac");
      assert.deepEqual([r.last.sessionId, r.last.status, r.last.by], ["ses_mac", "running", undefined], `${kind}: the Mac's run, untouched`);
    } finally {
      asMac();
    }
    await threadEnds("ses_mac", "Booked the table for 4 at 8.");
    assert.deepEqual([r.last.sessionId, r.last.status], ["ses_mac", "ok"], `${kind}: that time of it done, on the Mac`);
    assert.equal(r.nextRunAt, kind === "once" ? undefined : next, `${kind}: never due again for the move`);
    assert.equal(r.enabled, kind !== "once", `${kind}: a one-off stays done`);
    tick();
    asRunner(C1);
    onIdentity(C1);
    orgo.answer = settingsCloud;
    tick();
    await sleep(20);
    asMac();
    assert.deepEqual(fake.started, [], `${kind}: run nowhere again`);
  }
  T.reset();
});

await check("a runner's routine whose computer is stopped, frozen or broken, or asleep with nothing waking it, waits for it: the Mac's look keeps why in the state (\"Boppy's computer is stopped\"), never takes it over or runs it, and once a look finds the computer up, its runner runs it", async () => {
  for (const status of ["stopped", "frozen", "error", "suspended"]) {
    reset();
    seedRoutines();
    // Set up by another Mac (this one has no bundle to set one up with); the map lists C1 alone.
    state.runners[C1] = up("running", { by: "mac-b" });
    R.runnerForTests.hear("u1", "cloud");
    orgo.answer = (c) => (c.path.endsWith("/bops") ? { status: 200, json: { bots: [{ desktopId: C1 }] } } : null);
    orgo.status[C1] = status;
    const r = byId("r_boppy");
    r.nextRunAt = Date.now() - 11 * 60_000;
    await I.lookAtRunners();
    const words = `Boppy's computer is ${status === "error" ? "broken" : status === "suspended" ? "asleep" : status}`;
    assert.equal(state.runners[C1].down?.status, status, `${status}: kept in the state`);
    assert.equal(computerWait(state, r), words, `${status}: why it waits`);
    assert.equal(computerWait(state, byId("r_otto_task")), words, `${status}: Otto works on Boppy's computer: his wait says so too`);
    assert.equal(computerWait(state, byId("r_rook")), undefined, "another computer's routine doesn't wait for it");
    assert.equal(computerWait(state, byId("r_otto_chat")), undefined, "nor one the Mac runs");
    assert.equal(state.runners[C1].status, "running", `${status}: its runner is still its runner`);
    assert.equal(here("r_boppy"), false, `${status}: never the Mac's`);
    tick();
    await sleep(10);
    assert.ok(!fake.started.some((x) => x.routineId === "r_boppy" || x.routineId === "r_otto_task"), `${status}: the Mac runs none of its routines`);
    assert.ok(r.nextRunAt < Date.now(), `${status}: it waits, due`);
    // Up again (Orgo's waker, or Sam starting it): a look clears why, and its runner runs it, late.
    orgo.status[C1] = "running";
    await I.lookAtRunners();
    assert.equal(state.runners[C1].down, undefined, `${status}: up again`);
    assert.equal(computerWait(state, r), undefined);
    asRunner(C1);
    onIdentity(C1);
    // (Seen with C1's runner on the Mac just now: in one process, not a hand-over.)
    R.runnerForTests.seen("r_boppy");
    orgo.answer = settingsCloud;
    tick();
    for (let i = 0; i < 50 && !fake.started.some((x) => x.routineId === "r_boppy"); i++) await sleep(10);
    assert.ok(fake.started.some((x) => x.routineId === "r_boppy"), `${status}: its runner ran it once the computer was up`);
    asMac();
  }
  // Asleep with nothing overdue: nothing to say (Orgo's waker wakes it for its next time).
  reset();
  seedRoutines();
  state.runners[C1] = up("running", { by: "mac-b" });
  R.runnerForTests.hear("u1", "cloud");
  orgo.answer = (c) => (c.path.endsWith("/bops") ? { status: 200, json: { bots: [{ desktopId: C1 }] } } : null);
  orgo.status[C1] = "suspended";
  await I.lookAtRunners();
  assert.equal(state.runners[C1].down, undefined);
  T.reset();
});

await check("a thread its runner was running when its computer went down that way (stopped, frozen, broken) is over, saying why, so it never holds its routine's next run; the user's own threads on a computer asleep wait for it", async () => {
  reset();
  seedRoutines();
  state.runners[C1] = up("running", { by: "mac-b" });
  R.runnerForTests.hear("u1", "cloud");
  orgo.answer = (c) => (c.path.endsWith("/bops") ? { status: 200, json: { bots: [{ desktopId: C1 }] } } : null);
  const device = `device:u1:${C1}`;
  state.sessions.push({ id: "ses_runner", botId: "boppy", chatId: "bot:boppy", title: "r_boppy", goal: "Check the news", status: "running", routineId: "r_boppy", by: device });
  state.sessions.push({ id: "ses_user", botId: "boppy", chatId: "bot:boppy", title: "The user's own", goal: "x", status: "running", by: device });
  Object.assign(byId("r_boppy"), { last: { at: Date.now() - 10 * 60_000, status: "running", sessionId: "ses_runner" } });
  orgo.status[C1] = "suspended";
  await I.lookAtRunners();
  assert.deepEqual(state.sessions.map((x) => x.status), ["running", "running"], "asleep: both wait for it (its runner goes on when it wakes)");
  orgo.status[C1] = "stopped";
  await I.lookAtRunners();
  const ended = state.sessions.find((x) => x.id === "ses_runner");
  assert.deepEqual([ended.status, ended.error], ["failed", "Stopped: its computer was stopped."]);
  assert.equal(state.runners[C1].down?.status, "stopped");
  T.reset();
});

await check("a routine late while the Mac was awake runs, late, even when its next time is close or its hours ended since: one handed back by a runner that stopped", async () => {
  // Every 15 minutes handed back 12 minutes late (its next beat 3 minutes off), every 30 handed back 17 late,
  // and a weekday check whose hours ended since it was due: each run, late, as the Mac was awake all along.
  const nowNY = new Date(Date.now()).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
  const hm = (m) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, "0")}:${String((((m % 1440) + 1440) % 1440) % 60).padStart(2, "0")}`;
  const mins = Number(nowNY.slice(0, 2)) * 60 + Number(nowNY.slice(3, 5));
  const cases = [
    ["every 15", { kind: "every", minutes: 15 }, 12],
    ["every 30", { kind: "every", minutes: 30 }, 17],
    ["its hours ended since", { kind: "every", minutes: 15, hours: { from: hm(mins - 120), to: hm(mins - 5) } }, 12],
  ];
  const how = [
    // Its runner stopped on its computer (runner-install.ts stillRuns marks it failed): the Mac's after the hand-over time.
    ["handed back by a runner that stopped", (id) => ((state.runners[C1] = up("failed", { error: "it stopped on its computer" })), R.runnerForTests.seen(id, R.HANDOVER_MS + 1000))],
  ];
  for (const [what, schedule, late] of cases)
    for (const [way, back] of how)
      // A task of Otto's (sharing C1) and one of Boppy's, both C1's runner's, its last run fine.
      for (const id of ["r_otto_task", "r_boppy"]) {
        reset();
        seedRoutines();
        const r = byId(id);
        const due = Date.now() - late * 60_000;
        Object.assign(r, { schedule, nextRunAt: due, lastRunAt: due - 15 * 60_000, last: { at: due - 15 * 60_000, status: "ok" } });
        back(id);
        tick();
        // The run's own end (a chat run's turn) settles before the next case.
        await sleep(10);
        assert.notEqual(r.last?.status, "skipped", `${what}, ${way}, ${id}: run, not skipped (${r.last?.error ?? ""})`);
        assert.equal(r.lastRunAt > due, true, `${what}, ${way}, ${id}: it ran now`);
        assert.ok(r.nextRunAt > Date.now(), `${what}, ${way}, ${id}: its next time moved on`);
        assert.deepEqual(fake.started.map((x) => x.routineId), [id], `${what}, ${way}: the Mac started its task`);
      }
  T.reset();
});

await check("a routine handed back by a runner that stopped, after a nap of the Mac's between its time and the hand-back: run, late, never skipped (it was the runner's then)", async () => {
  for (const id of ["r_otto_task", "r_boppy"]) {
    reset();
    seedRoutines();
    const r = byId(id);
    const due = Date.now() - 14 * 60_000;
    Object.assign(r, { schedule: { kind: "every", minutes: 15 }, nextRunAt: due, lastRunAt: due - 15 * 60_000, last: { at: due - 15 * 60_000, status: "ok" } });
    // The Mac's tick 2 minutes after its time left it to C1's runner; the Mac then slept until 7 after; the
    // runner was marked failed after that (stillRuns, at a look), the hand-over time ago.
    assert.equal(R.runsHere(r, due + 2 * 60_000), false);
    napAt = due + 7 * 60_000;
    state.runners[C1] = up("failed", { error: "it stopped on its computer", at: Date.now() - R.HANDOVER_MS - 1000 });
    tick();
    await sleep(10);
    assert.notEqual(r.last?.status, "skipped", `${id}: ${r.last?.error ?? ""}`);
    assert.ok(r.lastRunAt > due, `${id}: it ran`);
  }
  // The same nap with the runner marked failed before it: the Mac slept through the time it had it, a missed run.
  reset();
  seedRoutines();
  const r = byId("r_otto_task");
  const due = Date.now() - 14 * 60_000;
  Object.assign(r, { schedule: { kind: "every", minutes: 15 }, nextRunAt: due, lastRunAt: due - 15 * 60_000, last: { at: due - 15 * 60_000, status: "ok" } });
  assert.equal(R.runsHere(r, due + 60_000), false);
  napAt = due + 7 * 60_000;
  state.runners[C1] = up("failed", { error: "it stopped on its computer", at: due + 90_000 });
  tick();
  await sleep(10);
  assert.equal(r.last?.status, "skipped", r.last?.error);
  assert.match(r.last.error, /^Missed while Bops was off or this Mac was asleep/);
  T.reset();
});

await check("the first time this Bops has an account's state (signed in late, or Bops Cloud reached after a while): its routines that came due before are missed runs, not run as if it was awake for them", async () => {
  reset();
  seedRoutines();
  // The timer never ran with a state in this process: it waited while there was none.
  for (const k of ["__bopsTickedAt", "__bopsTickingFrom", "__bopsTickEpoch"]) delete globalThis[k];
  const r = byId("r_rook");
  const due = Date.now() - 12 * 60_000;
  Object.assign(r, { schedule: { kind: "every", minutes: 15 }, nextRunAt: due, lastRunAt: due - 15 * 60_000, last: { at: due - 15 * 60_000, status: "ok" } });
  tick();
  await sleep(10);
  assert.equal(r.last?.status, "skipped", r.last?.error);
  assert.match(r.last.error, /^Missed while Bops was off or this Mac was asleep/);
  // From then on it's been running them: one late since (another Bops had it) runs.
  const later = Date.now() - 1000;
  Object.assign(r, { nextRunAt: later, last: { at: later - 60_000, status: "ok" } });
  globalThis.__bopsTickingFrom = later - 1000;
  tick();
  await sleep(10);
  assert.notEqual(r.last?.status, "skipped", r.last?.error);
  T.reset();
});

await check("a runner's timer counts as running its routines while none is due, or once it's sure enough to run one; never while it isn't", async () => {
  reset();
  seedRoutines();
  asRunner(C1);
  const r = byId("r_boppy");
  globalThis.__bopsTickedAt = Date.now() - 60_000;
  tick();
  assert.ok(Date.now() - globalThis.__bopsTickedAt < 1000, "nothing due: counted");
  // One due, and no word from Orgo yet: it can't run it, and that time isn't counted.
  r.nextRunAt = Date.now() - 1000;
  globalThis.__bopsTickedAt = Date.now() - 60_000;
  const before = globalThis.__bopsTickedAt;
  tick();
  assert.equal(globalThis.__bopsTickedAt, before, "unsure: not counted");
  await sleep(20);
  T.reset();
});

await check("a run another computer's runner left going of a routine it no longer runs, quiet for a while, never holds that routine on the computer its bot moved to while the Mac isn't looking", async () => {
  for (const quietFor of [20, 2]) {
    reset();
    seedRoutines();
    state.runners[C1] = up("running", { by: "mac-b" });
    state.runners[C2] = up("running", { by: "mac-b" });
    const b = byId("r_otto_task");
    // Otto moved to C2, whose runner is up; C1's runner had a run of it going, its last sign of work `quietFor` minutes ago (C1 asleep since: Free hours used up).
    Object.assign(state.bots.find((x) => x.id === "otto"), { computer: "own", computerId: C2 });
    const left = Date.now() - quietFor * 60_000;
    state.sessions.push({ id: "ses_left", botId: "otto", chatId: "bot:otto", title: "r_otto_task", goal: "Check the news", status: "running", routineId: "r_otto_task", by: deviceIdOf("u1", C1), createdAt: left - 5 * 60_000, startedAt: left - 5 * 60_000, steps: [{ at: left, tool: "computer", detail: "clicked (1, 1)" }], replies: [] });
    Object.assign(b, { schedule: { kind: "every", minutes: 15 }, nextRunAt: Date.now() - 1000, last: { at: left - 5 * 60_000, status: "running", sessionId: "ses_left" } });
    asRunner(C2);
    onIdentity(C2);
    R.runnerForTests.hear("u1", "cloud");
    assert.equal(R.runsHere(b), true, "(C2's runner runs it now)");
    tick();
    await sleep(10);
    if (quietFor === 20) {
      assert.notEqual(b.last?.error, "The last run was still going.", `quiet ${quietFor} minutes: ${b.last?.status} ${b.last?.error ?? ""}`);
      assert.notEqual(b.last?.sessionId, "ses_left", "its run is this one now");
    } else assert.equal(b.last?.error, "The last run was still going.", "working 2 minutes ago: still its run");
    asMac();
  }
  T.reset();
});

await check("a run the Mac left going (a Run now), quiet since the Mac closed or quit, never holds the routine on its computer's runner; one still at work does, and on the Mac its own always does", async () => {
  /** A thread of the routine's that Bops `by` has going, its last sign of work `quietFor` minutes ago. */
  const going = (b, by, quietFor, id = "ses_left") => {
    const at = Date.now() - quietFor * 60_000;
    state.sessions.push({ id, botId: b.botId, chatId: `bot:${b.botId}`, title: b.id, goal: "Check the news", status: "running", routineId: b.id, by, createdAt: at - 60_000, startedAt: at - 60_000, steps: [{ at, tool: "computer", detail: "clicked (1, 1)" }], replies: [] });
    Object.assign(b, { schedule: { kind: "every", minutes: 15 }, nextRunAt: Date.now() - 1000, last: { at: at - 60_000, status: "running", sessionId: id } });
  };
  // A Run now in the Mac app (its thread the Mac's), then the lid closes or Bops quits: C1's runner has the routine, Boppy's task and Otto's (sharing C1).
  for (const id of ["r_boppy", "r_otto_task"])
    for (const quietFor of [180, 2]) {
      reset();
      seedRoutines();
      const b = byId(id);
      going(b, "mac-a", quietFor);
      asRunner(C1);
      onIdentity(C1);
      R.runnerForTests.hear("u1", "cloud");
      assert.equal(R.runsHere(b), true, "(C1's runner runs it)");
      tick();
      await sleep(10);
      if (quietFor === 180) {
        assert.notEqual(b.last?.error, "The last run was still going.", `${id}, the Mac's run quiet 3 hours: ${b.last?.status} ${b.last?.error ?? ""}`);
        assert.notEqual(b.last?.sessionId, "ses_left", `${id}: its run is this one now`);
        assert.ok(fake.started.some((x) => x.routineId === id), "a new thread on C1");
      } else assert.equal(b.last?.error, "The last run was still going.", `${id}: the Mac at work on it 2 minutes ago: still its run`);
      asMac();
    }
  // On the Mac: its own run, however quiet, is still its run (it knows it's going); another Mac's quiet one isn't.
  for (const by of ["mac-a", "mac-b"]) {
    reset();
    seedRoutines();
    const p = byId("r_penny");
    going(p, by, 180);
    assert.equal(R.runsHere(p), true, "(the Mac's routine)");
    tick();
    await sleep(10);
    if (by === "mac-a") assert.equal(p.last?.error, "The last run was still going.", "its own");
    else assert.notEqual(p.last?.error, "The last run was still going.", `another Mac's, quiet 3 hours: ${p.last?.status} ${p.last?.error ?? ""}`);
  }
  T.reset();
});

await check("a run the Mac has queued behind Boppy's busy screens, quiet 12 minutes while the Mac works on another thread on C1, still holds the routine on C1's runner (never a second run of it); with the Mac quiet on all its threads, it doesn't", async () => {
  for (const macQuietSec of [20, 3 * 3600]) {
    reset();
    seedRoutines();
    const b = byId("r_boppy");
    const queuedAt = Date.now() - 12 * 60_000;
    // The Mac's Run now, queued: nothing on it but when it was made.
    state.sessions.push({ id: "ses_queued", botId: "boppy", chatId: "bot:boppy", title: "r_boppy", goal: "Check the news", status: "queued", routineId: "r_boppy", by: "mac-a", createdAt: queuedAt });
    // The Mac at work on C1 for Boppy: a step `macQuietSec` seconds ago.
    const busy = Date.now() - macQuietSec * 1000;
    state.sessions.push({ id: "ses_busy", botId: "boppy", chatId: "bot:boppy", title: "Book flights", goal: "Book flights", status: "running", by: "mac-a", createdAt: queuedAt - 60_000, startedAt: queuedAt - 60_000, steps: [{ at: busy, tool: "computer", detail: "clicked (1, 1)" }], replies: [] });
    Object.assign(b, { schedule: { kind: "every", minutes: 15 }, nextRunAt: Date.now() - 1000, last: { at: queuedAt, status: "running", sessionId: "ses_queued" } });
    asRunner(C1);
    R.runnerForTests.hear("u1", "cloud");
    assert.equal(R.runsHere(b), true, "(C1's runner runs it)");
    tick();
    await sleep(10);
    const runs = state.sessions.filter((x) => x.routineId === "r_boppy" && ["queued", "starting", "running"].includes(x.status));
    if (macQuietSec === 20) {
      assert.equal(b.last?.error, "The last run was still going.", `the Mac working 20 seconds ago: still its run (${b.last?.status} ${b.last?.sessionId})`);
      assert.equal(b.last?.sessionId, "ses_queued");
      assert.equal(fake.started.filter((x) => x.routineId === "r_boppy").length, 0, "no second run on C1");
      assert.deepEqual(runs.map((x) => x.id), ["ses_queued"]);
    } else {
      assert.notEqual(b.last?.error, "The last run was still going.", `the Mac quiet 3 hours on all its threads: ${b.last?.status} ${b.last?.error ?? ""}`);
      assert.notEqual(b.last?.sessionId, "ses_queued", "its run is this one now");
    }
    asMac();
  }
  T.reset();
});

/** A request its runner's run paused at (lib/types.ts AppApproval): unanswered, and what resumes it. */
const waitingAsk = (botId, routineId, device) => ({
  id: "apr_wait",
  botId,
  threadId: "ses_wait",
  routineId,
  askedBy: device,
  action: "Send an email",
  resources: ["dana@acme.example"],
  preview: "to: dana@acme.example",
  at: Date.now() - 15 * 60_000,
  resume: { engine: "responses", responseId: "resp_wait", callId: "call_wait", call: { name: "use_app", arguments: "{}" } },
});

await check("a run its runner left going of a routine it no longer runs, on a computer asleep (nothing its runner runs there overdue): it ends within a minute of the change, and the routine runs on its time; with the computer up, it's still going", async () => {
  for (const how of ["mac", "slack", "moved", "shared", "awake"]) {
    reset();
    seedRoutines();
    state.runners[C1] = up("running", { by: "mac-b" });
    R.runnerForTests.hear("u1", "cloud");
    orgo.answer = (c) => (c.path.endsWith("/bops") ? { status: 200, json: { bots: [{ desktopId: C1 }] } } : null);
    orgo.status[C1] = how === "awake" ? "running" : "suspended";
    const device = `device:u1:${C1}`;
    const id = how === "moved" ? "r_otto_task" : "r_boppy";
    // The routine named is the only one of C1's its runner runs (moved: Boppy's one there runs on the Mac);
    // shared: a task of Otto's there too, due in 30 minutes.
    const keep = new Set([id, "r_rook", "r_penny", "r_nova", ...(how === "moved" ? ["r_boppy_mac"] : []), ...(how === "shared" ? ["r_otto_task"] : [])]);
    state.routines = state.routines.filter((x) => keep.has(x.id));
    if (how === "shared") byId("r_otto_task").nextRunAt = Date.now() + 30 * 60_000;
    const b = byId(id);
    // At work a minute ago (a step), as a run on a computer that's up is.
    state.sessions.push({ id: "ses_runner", botId: b.botId, chatId: `bot:${b.botId}`, title: id, goal: "Check the news", status: "running", routineId: id, by: device, createdAt: Date.now() - 10 * 60_000, startedAt: Date.now() - 10 * 60_000, steps: [{ at: Date.now() - 60_000, tool: "computer", detail: "clicked (1, 1)" }], replies: [] });
    Object.assign(b, { schedule: { kind: "every", minutes: 15 }, nextRunAt: Date.now() + 5 * 60_000, last: { at: Date.now() - 10 * 60_000, status: "running", sessionId: "ses_runner" } });
    const ses = state.sessions.find((x) => x.id === "ses_runner");
    // While it's still its runner's routine, a look leaves its run going (its runner runs it when the computer wakes).
    await I.lookAtRunners();
    assert.equal(ses.status, "running", `${how}: its runner's run, before the change`);
    I.runnerInstallForTests.check(30_000);
    if (how === "mac" || how === "shared" || how === "awake") b.where = "mac";
    if (how === "slack") b.deliverTo = { kind: "channel", linkId: "lnk_1", chat: "C0SALES" };
    if (how === "moved") Object.assign(state.bots.find((x) => x.id === "otto"), { computer: "own", computerId: C2 });
    // The minute timer sees the change and looks.
    const { looking } = I.runnerInstallForTests.check();
    assert.ok(looking, `${how}: looked at within a minute`);
    await looking;
    assert.equal(state.runners[C1].down, undefined, `${how}: nothing of C1's waits on it (none overdue)`);
    b.nextRunAt = Date.now() - 1000;
    tick();
    await sleep(10);
    if (how === "awake") {
      assert.equal(ses.status, "running", "awake: its runner is still running it");
      assert.equal(b.last?.error, "The last run was still going.", "awake: so the run waits for it");
      continue;
    }
    assert.equal(ses.status, "failed", `${how}: its last run there is over`);
    assert.match(ses.error, /^Stopped: its computer was asleep, and its routine doesn't run there anymore\.$/);
    assert.doesNotMatch(ses.error, DASHES);
    assert.notEqual(b.last?.error, "The last run was still going.", `${how}: ${b.last?.status} ${b.last?.error ?? ""}`);
    assert.ok(fake.started.some((x) => x.routineId === id) || ["ok", "quiet", "running"].includes(b.last?.status), `${how}: it ran (${b.last?.status} ${b.last?.error ?? ""})`);
  }
  T.reset();
});

await check("a run its runner left paused for the owner's OK, on a computer asleep through the wait, is no stray: its routine changed meanwhile (to the Mac, results to a channel, its bot moved) and a look at its runner leave it waiting there, its request untouched, and the routine's next run waits for it", async () => {
  for (const how of ["mac", "slack", "moved"]) {
    reset();
    seedRoutines();
    state.runners[C1] = up("running", { by: "mac-b" });
    R.runnerForTests.hear("u1", "cloud");
    orgo.answer = (c) => (c.path.endsWith("/bops") ? { status: 200, json: { bots: [{ desktopId: C1 }] } } : null);
    // Asleep 15 minutes into the wait: a wait keeps no computer up (free-hours.ts inUse).
    orgo.status[C1] = "suspended";
    const device = `device:u1:${C1}`;
    const id = how === "moved" ? "r_otto_task" : "r_boppy";
    const keep = new Set([id, "r_rook", "r_penny", "r_nova", ...(how === "moved" ? ["r_boppy_mac"] : [])]);
    state.routines = state.routines.filter((x) => keep.has(x.id));
    const b = byId(id);
    state.sessions.push({ id: "ses_wait", botId: b.botId, chatId: `bot:${b.botId}`, title: id, goal: "Email Dana the summary", status: "queued", routineId: id, by: device, createdAt: Date.now() - 20 * 60_000, startedAt: Date.now() - 20 * 60_000, steps: [{ at: Date.now() - 15 * 60_000, tool: "computer", detail: "clicked (1, 1)" }], replies: [] });
    state.appApprovals = [waitingAsk(b.botId, id, device)];
    const asked = structuredClone(state.appApprovals[0]);
    Object.assign(b, { schedule: { kind: "every", minutes: 15 }, nextRunAt: Date.now() + 5 * 60_000, last: { at: Date.now() - 20 * 60_000, status: "running", sessionId: "ses_wait", by: device } });
    const ses = state.sessions.find((x) => x.id === "ses_wait");
    if (how === "mac") b.where = "mac";
    if (how === "slack") b.deliverTo = { kind: "channel", linkId: "lnk_1", chat: "C0SALES" };
    if (how === "moved") Object.assign(state.bots.find((x) => x.id === "otto"), { computer: "own", computerId: C2 });
    // A look at C1 (asleep, a thread of its runner's live) after the change.
    await I.lookAtRunners();
    assert.deepEqual([ses.status, ses.error, ses.by], ["queued", undefined, device], `${how}: still waiting there, its runner's`);
    assert.deepEqual(state.appApprovals[0], asked, `${how}: its request untouched, for the owner's reply`);
    b.nextRunAt = Date.now() - 1000;
    tick();
    await sleep(10);
    assert.deepEqual([b.last?.sessionId, b.last?.error], ["ses_wait", "The last run was still going."], `${how}: the routine's next run waits for it`);
    assert.equal(fake.started.filter((x) => x.routineId === id).length, 0, `${how}: no second run`);
    delete state.appApprovals;
  }
  T.reset();
});

await check("a run its runner has paused for the owner's OK doesn't end when that runner is stopped (routines set to run on This Mac, no bot on its computer any more, its computer stopped): it waits on there, its request untouched, and the runner stays on its computer with its key, running nothing else, till that run is over; a run of it at work ends as before; switched back meanwhile, it's up again as it was; its computer deleted, the run ends with it", async () => {
  const realComputer = globalThis.__fake.orgo.orgo.computer;
  const realGone = globalThis.__fake.sessions.computerGone;
  try {
    for (const how of ["mac", "moved", "back", "deleted", "stopped"]) {
      globalThis.__fake.orgo.orgo.computer = realComputer;
      globalThis.__fake.sessions.computerGone = realGone;
      reset();
      seedRoutines();
      const device = `device:u1:${C1}`;
      state.runners[C1] = up("running", { by: "mac-b", keyMade: true, keyId: "key-c1" });
      R.runnerForTests.hear("u1", how === "mac" || how === "back" ? "mac" : "cloud");
      // No bot on it any more as Orgo's map says (moved, or the computer deleted or stopped and its bots moved off).
      orgo.answer = (c) => (c.path.endsWith("/bops") ? { status: 200, json: { bots: how === "mac" || how === "back" ? [{ desktopId: C1 }] : [] } } : null);
      // Up (woken for something else), so a runner taken off would be taken off now; deleted or stopped as Orgo says.
      orgo.status[C1] = how === "stopped" ? "stopped" : "running";
      if (how === "deleted") {
        globalThis.__fake.orgo.orgo.computer = async () => {
          throw new Error("gone");
        };
        globalThis.__fake.sessions.computerGone = () => true;
      }
      const b = byId("r_boppy");
      state.sessions.push(
        { id: "ses_wait", botId: "boppy", chatId: "bot:boppy", title: "r_boppy", goal: "Email Dana the summary", status: "queued", routineId: "r_boppy", by: device, createdAt: Date.now() - 20 * 60_000, startedAt: Date.now() - 20 * 60_000, steps: [], replies: [] },
        { id: "ses_work", botId: "otto", chatId: "bot:otto", title: "Orders", goal: "Check the orders", status: "running", by: device, createdAt: Date.now() - 60_000, startedAt: Date.now() - 60_000, steps: [], replies: [] },
      );
      state.appApprovals = [waitingAsk("boppy", "r_boppy", device)];
      const asked = structuredClone(state.appApprovals[0]);
      b.last = { at: Date.now() - 20 * 60_000, status: "running", sessionId: "ses_wait", by: device };
      const wait = state.sessions.find((x) => x.id === "ses_wait");
      const work = state.sessions.find((x) => x.id === "ses_work");
      const takenOff = () => orgo.bash.some((x) => x.command.includes("__BOPS_OFF__"));
      const revoked = () => orgo.calls.some((c) => c.method === "DELETE" && c.path === `/api/computers/${C1}/orgo-key`);
      await I.lookAtRunners();
      if (how === "deleted") {
        assert.equal(wait.status, "failed", `${how}: the run is gone with its computer`);
        assert.equal(wait.error, "Stopped: its computer was deleted.");
        assert.equal(work.status, "failed");
        continue;
      }
      const why = how === "moved" ? "Stopped: no bot works on this computer anymore." : how === "stopped" ? "Stopped: its computer was stopped." : "Stopped: routines run on your Mac now.";
      assert.deepEqual([wait.status, wait.error, wait.by], ["queued", undefined, device], `${how}: still waiting there, its runner's (a stopped computer is a wait too)`);
      assert.deepEqual(state.appApprovals[0], asked, `${how}: its request untouched, for the owner's reply`);
      assert.deepEqual([work.status, work.error], ["failed", why], `${how}: the run at work ends, saying why`);
      assert.equal(state.runners[C1].status, "stopping", `${how}: it runs nothing else`);
      assert.ok(!takenOff(), `${how}: the runner left on its computer for the run`);
      assert.ok(!revoked(), `${how}: and its key`);
      assert.equal(state.runners[C1].keyMade, true);
      // A look a minute later, still waiting: nothing more.
      await I.lookAtRunners();
      assert.deepEqual([wait.status, takenOff(), revoked()], ["queued", false, false], `${how}: kept while it waits`);
      if (how === "back" || how === "stopped") {
        if (how === "stopped") continue;
        // Switched back to the Cloud while it waits: the runner is up as it was, nothing set up again (that would end the run).
        R.runnerForTests.hear("u1", "cloud");
        orgo.bash.length = 0;
        await I.lookAtRunners();
        assert.equal(state.runners[C1].status, "running", "back: up again as it was");
        assert.equal(wait.status, "queued", "back: its run still waiting there");
        assert.equal(orgo.bash.length, 0, "back: nothing set up again on its computer");
        continue;
      }
      // Sam's Allow, and the run goes on there to its end: within a minute the runner is taken off, and its key revoked.
      I.runnerInstallForTests.check(30_000);
      state.appApprovals = [];
      Object.assign(wait, { status: "done" });
      const { looking } = I.runnerInstallForTests.check();
      assert.ok(looking, `${how}: looked at within a minute of the run's end`);
      await looking;
      assert.ok(takenOff(), `${how}: the runner taken off once its run is over`);
      assert.ok(revoked(), `${how}: its key revoked`);
    }
  } finally {
    globalThis.__fake.orgo.orgo.computer = realComputer;
    globalThis.__fake.sessions.computerGone = realGone;
    delete state.appApprovals;
    T.reset();
  }
});

await check("Orgo's map or the members check not answering: nothing is set up or stopped, but a computer down is still looked at, so its routines say why they wait (and stay its runner's)", async () => {
  for (const what of ["map", "members"]) {
    reset();
    seedRoutines();
    state.runners[C1] = up("running", { by: "mac-b" });
    R.runnerForTests.hear("u1", "cloud");
    orgo.answer = (c) => (c.path.endsWith("/bops") ? (what === "map" ? { status: 403, json: {} } : { status: 200, json: { bots: [{ desktopId: C1 }] } }) : null);
    globalThis.__fake.members.othersCanUse = async () => (what === "members" ? null : false);
    orgo.status[C1] = "frozen";
    byId("r_boppy").nextRunAt = Date.now() - 11 * 60_000;
    await I.lookAtRunners();
    assert.equal(computerWait(state, byId("r_boppy")), "Boppy's computer is frozen", `${what}: why it waits`);
    assert.equal(here("r_boppy"), false, `${what}: still its runner's`);
    assert.equal(state.runners[C1].status, "running", `${what}: nothing set up or stopped`);
  }
  globalThis.__fake.members.othersCanUse = async () => false;
  T.reset();
});


await check("a quick switch to another account: its routines that came due while it was signed out are missed runs, not run as if this Bops was awake for them", async () => {
  reset();
  seedRoutines();
  // Ticking all along (another account's state in).
  tick();
  const r = byId("r_rook");
  const due = Date.now() - 12 * 60_000;
  Object.assign(r, { schedule: { kind: "every", minutes: 15 }, nextRunAt: due, lastRunAt: due - 15 * 60_000, last: { at: due - 15 * 60_000, status: "ok" } });
  epoch++;
  tick();
  await sleep(10);
  assert.equal(r.last?.status, "skipped", r.last?.error);
  assert.match(r.last.error, /^Missed while Bops was off or this Mac was asleep/);
  T.reset();
});

await check("a routine its runner's computer slept through is a missed run there, said so, never \"this Mac\"; one whose runner was up but couldn't run routines says that instead", async () => {
  // On a runner whose computer slept through it (suspended from its time until a minute after, its routine
  // timer last ran minutes ago): said so, never "this Mac"; and one that was up but couldn't run routines
  // all that while (unsure of Orgo's word, the state or its computer: runnerReady) says that instead.
  for (const [slept, said] of [
    [true, /^Missed while its computer was asleep \(it was due /],
    [false, /^Missed while its computer's runner couldn't run routines \(it was due /],
  ]) {
    reset();
    seedRoutines();
    asRunner(C1);
    onIdentity(C1);
    const r = byId("r_otto_task");
    const due = Date.now() - 12 * 60_000;
    if (slept) napAt = due + 60_000;
    orgo.answer = () => ({ status: 200, json: { runsOn: "cloud" } });
    R.runnerForTests.hear("u1", "cloud");
    R.runnerReady();
    await sleep(20);
    assert.equal(R.runnerReady(), true);
    Object.assign(r, { schedule: { kind: "every", minutes: 15 }, nextRunAt: due, lastRunAt: due - 15 * 60_000, last: { at: due - 15 * 60_000, status: "ok" } });
    globalThis.__bopsTickedAt = Date.now() - 5 * 60_000;
    tick();
    assert.equal(r.last?.status, "skipped", r.last?.error);
    assert.match(r.last.error, said);
  }
  T.reset();
});

await check("a routine that leaves a runner waits the hand-over time on the Mac, while that runner hears of it", () => {
  reset();
  seedRoutines();
  const moves = [
    ["the runner set up again", () => (state.runners[C1] = up("installing"))],
    ["the runner couldn't start", () => (state.runners[C1] = up("failed", { error: "it didn't answer on its computer" }))],
    ["its bot moved to a computer with no runner", () => Object.assign(state.bots[0], { computerId: C2 })],
    ["the routine set to run on the Mac", () => (byId("r_boppy").where = "mac")],
    ["its bot set to work on the Mac", () => (state.bots[0].runsOn = "mac")],
  ];
  for (const [what, move] of moves) {
    reset();
    seedRoutines();
    assert.equal(here("r_boppy"), false, "the runner's, as the Mac last saw it");
    move();
    assert.equal(here("r_boppy"), false, `${what}: not the Mac's at once`);
    R.runnerForTests.seen("r_boppy", R.HANDOVER_MS + 1000);
    assert.equal(here("r_boppy"), true, `${what}: the Mac's after the hand-over time`);
  }
  // Never with a runner (as this Mac saw it): the Mac's at once.
  reset();
  seedRoutines();
  assert.equal(here("r_rook"), true);
});

await check("a routine due on both sides during a hand-over runs on one: the Mac waits, the runner on its last copy runs it", async () => {
  reset();
  seedRoutines();
  // As the Mac sees it: C1's runner up, then being set up again (an upgrade that marks it so) as the routine comes due.
  assert.equal(here("r_boppy"), false);
  state.runners[C1] = up("installing");
  byId("r_boppy").nextRunAt = Date.now() - 1000;
  tick();
  assert.ok(!fake.started.some((x) => x.routineId === "r_boppy"), "the Mac leaves it to the runner, which hasn't heard");
  assert.ok(byId("r_boppy").nextRunAt < Date.now(), "not advanced here");
  T.reset();
});

await check("on a runner, a routine that comes from another computer's runner waits the hand-over time", () => {
  reset();
  seedRoutines();
  asRunner(C2);
  state.runners[C2] = up("running");
  R.runnerForTests.hear("u1", "cloud");
  assert.equal(here("r_rook"), true, "its own from the start");
  // Boppy moves from C1 (its runner up) to C2.
  R.runnerHasWork();
  state.bots[0].computerId = C2;
  assert.equal(here("r_boppy"), false, "just came here: C1's runner may not have heard");
  R.runnerForTests.seen("r_boppy", R.HANDOVER_MS + 1000);
  assert.equal(here("r_boppy"), true, "after the hand-over time: this runner's");
});

await check("after a switch to This Mac the Mac waits for the runner's stop, at most the hand-over time", () => {
  reset();
  seedRoutines();
  R.runnerForTests.hear("u1", "cloud");
  assert.equal(here("r_boppy"), false, "Cloud: the runner's");
  R.runnerForTests.hear("u1", "mac");
  assert.equal(R.runsOn(), "mac");
  assert.equal(here("r_boppy"), false, "just switched, its stop not confirmed: still the runner's");
  assert.equal(here("r_rook"), true);
  R.runnerForTests.hear("u1", "mac", { macAgo: R.HANDOVER_MS + 1000 });
  R.runnerForTests.seen("r_boppy", R.HANDOVER_MS + 1000);
  assert.equal(here("r_boppy"), true, "after the hand-over time: the Mac's");
  R.runnerForTests.hear("u1", "mac", { macAgo: 5_000 });
  assert.equal(here("r_boppy"), false);
  delete state.runners[C1];
  assert.equal(here("r_boppy"), true, "its stop confirmed (the runner's gone): the Mac's at once");
});

await check("what Orgo said is the signed-in user's only", () => {
  reset();
  seedRoutines();
  R.runnerForTests.hear("u1", "mac", { macAgo: R.HANDOVER_MS + 1000 });
  assert.equal(here("r_boppy"), true);
  state.account = { user: { id: "u2" }, signedInAt: 0 };
  assert.equal(R.runsOn(), "mac", "nothing heard for them: the Mac");
  assert.equal(here("r_boppy"), false, "and until Orgo answers, a runner that's up keeps its routines");
});

/* ---------------- The split, on a runner ---------------- */

await check("a runner runs its own computer's routines while the bots work in the Cloud and it's marked up", () => {
  reset();
  seedRoutines();
  asRunner(C1);
  onIdentity(C1);
  assert.equal(here("r_boppy"), false, "nothing heard from Orgo: nothing");
  R.runnerForTests.hear("u1", "cloud");
  assert.equal(here("r_boppy"), true);
  assert.equal(here("r_otto_task"), true, "a bot sharing its computer");
  assert.equal(here("r_otto_reminder"), false, "a reminder: never a runner's (the Mac's)");
  assert.equal(here("r_otto_chat"), false, "a chat run: never a runner's (the Mac's)");
  assert.equal(here("r_boppy_mac"), false, "set to the Mac");
  assert.equal(here("r_boppy_words"), false, "Mac words");
  assert.equal(here("r_penny"), false, "a bot that works on the Mac");
  assert.equal(here("r_rook"), false, "another computer's");
  assert.equal(here("r_nova"), false, "no computer");
  state.runners[C1] = up("installing");
  assert.equal(here("r_boppy"), false, "not marked up yet: the Mac still has them");
  state.runners[C1] = up("stopping");
  assert.equal(here("r_boppy"), false, "being stopped");
  state.runners[C1] = up("running");
  R.runnerForTests.hear("u1", "mac");
  assert.equal(here("r_boppy"), false, "the bots work on This Mac");
  R.runnerForTests.hear("u1", "cloud", { ago: 61_000 });
  assert.equal(here("r_boppy"), false, "Orgo's word over a minute old");
  R.runnerForTests.hear("u1", "cloud");
  napped = true;
  assert.equal(here("r_boppy"), false, "its computer slept since");
  napped = false;
  asRunner(C2);
  onIdentity(C2);
  state.runners[C2] = up("running");
  assert.equal(here("r_rook"), true, "C2's runner: Rook's");
  assert.equal(here("r_boppy"), false);
});

/* ---------------- Where the bots work, as Orgo says ---------------- */

await check("the Mac sets the default, Cloud, once, and goes by it only once Orgo took it", async () => {
  reset();
  orgo.answer = (c) => (c.method === "GET" ? { status: 200, json: { runsOn: null } } : { status: 200, json: { runsOn: "cloud" } });
  assert.equal(R.runsOn(), "mac", "never heard: the Mac");
  await R.askRunsOn();
  assert.deepEqual(orgo.calls.map((c) => `${c.method} ${c.path}`), ["GET /api/bops/settings", "PUT /api/bops/settings"]);
  assert.deepEqual(orgo.calls[1].body, { runsOn: "cloud" });
  assert.equal(R.runsOn(), "cloud");
  // Refused: the Mac until it's set, and not asked again.
  reset();
  orgo.answer = (c) => (c.method === "GET" ? { status: 200, json: { runsOn: null } } : { status: 403, json: {} });
  await R.askRunsOn();
  assert.equal(R.runsOn(), "mac");
  orgo.calls.length = 0;
  await R.askRunsOn();
  assert.deepEqual(orgo.calls.map((c) => c.method), ["GET"], "set once: not again");
  // No answer to the PUT: tried again next time.
  reset();
  let putAnswer = null;
  orgo.answer = (c) => (c.method === "GET" ? { status: 200, json: { runsOn: null } } : putAnswer);
  await R.askRunsOn();
  assert.equal(R.runsOn(), "mac");
  putAnswer = { status: 200, json: {} };
  await R.askRunsOn();
  assert.equal(R.runsOn(), "cloud");
  assert.deepEqual(orgo.calls.map((c) => c.method), ["GET", "PUT", "GET", "PUT"]);
});

await check("Orgo's answers: the user's pick, an Orgo without the setting, no answer", async () => {
  reset();
  orgo.answer = () => ({ status: 200, json: { runsOn: "mac" } });
  await R.askRunsOn();
  assert.equal(R.runsOn(), "mac");
  assert.equal(orgo.calls.length, 1, "set: never set again");
  orgo.answer = () => ({ status: 200, json: { runsOn: "cloud" } });
  await R.askRunsOn();
  assert.equal(R.runsOn(), "cloud");
  orgo.answer = () => null;
  await R.askRunsOn();
  assert.equal(R.runsOn(), "cloud", "the Mac keeps what it heard last");
  reset();
  orgo.answer = () => ({ status: 404, json: {} });
  await R.askRunsOn();
  assert.equal(R.runsOn(), "mac");
  assert.equal(R.runsOnMissing(), true);
  orgo.calls.length = 0;
  await R.askRunsOn();
  assert.equal(orgo.calls.length, 0, "an Orgo without the setting isn't asked again for a while");
});

await check("a runner never sets it, and runs nothing on what it didn't hear", async () => {
  reset();
  seedRoutines();
  asRunner(C1);
  orgo.answer = () => ({ status: 200, json: { runsOn: null } });
  await R.askRunsOn();
  assert.deepEqual(orgo.calls.map((c) => c.method), ["GET"], "no PUT from a runner");
  assert.equal(R.runsOn(), "mac");
  assert.equal(here("r_boppy"), false);
  orgo.answer = () => null;
  await R.askRunsOn();
  assert.equal(here("r_boppy"), false, "no answer: still nothing");
  assert.deepEqual(await R.setRunsOn("cloud"), { error: "Sign in to Bops first." }, "a runner never writes it");
});

await check("Settings: where the bots work from now on", async () => {
  reset();
  orgo.answer = () => ({ status: 200, json: { runsOn: "mac" } });
  assert.deepEqual(await R.setRunsOn("mac"), {});
  assert.deepEqual(orgo.calls.at(-1), { method: "PUT", path: "/api/bops/settings", body: { runsOn: "mac" } });
  assert.equal(R.runsOn(), "mac");
  orgo.answer = () => ({ status: 405, json: {} });
  const missing = await R.setRunsOn("cloud");
  assert.deepEqual(missing, { error: "Cloud isn't available yet.", missing: true });
  orgo.answer = () => null;
  const off = await R.setRunsOn("cloud");
  assert.match(off.error, /Couldn't reach Orgo/);
  for (const e of [missing.error, off.error]) assert.ok(!DASHES.test(e), e);
});

await check("a runner reads the state and asks Orgo again before it runs, and then runs", async () => {
  reset();
  asRunner(C1);
  orgo.answer = () => ({ status: 200, json: { runsOn: "cloud" } });
  let again = 0;
  assert.equal(R.runnerReady(() => again++), false, "never read: not yet");
  await sleep(20);
  assert.equal(fake.pulls, 1, "the state read again");
  assert.ok(orgo.calls.some((c) => c.path === "/api/bops/settings"), "Orgo asked");
  assert.equal(again, 1, "and the timer goes again once both are fresh");
  assert.equal(R.runnerReady(), true);
  // A nap since: both again.
  napped = true;
  assert.equal(R.runnerReady(), false);
  await sleep(20);
  assert.equal(fake.pulls, 2);
  napped = false;
  // The state not read for 40 seconds (a read failed): not ready, and read again.
  pulledAt = Date.now() - 41_000;
  globalThis.__fake.store.pullState = async () => void fake.pulls++;
  again = 0;
  assert.equal(R.runnerReady(() => again++), false);
  await sleep(20);
  assert.equal(again, 0, "still old: the timer waits for its next turn");
  R.runnerForTests.reset();
});
globalThis.__fake.store.pullState = async () => {
  fake.pulls++;
  pulledAt = Date.now();
};

/* ---------------- The routines timer ---------------- */

await check("the Mac's timer runs its own routines and leaves the runner's", async () => {
  reset();
  seedRoutines();
  for (const r of state.routines) r.nextRunAt = Date.now() - 1000;
  tick();
  const ran = new Set(fake.started.map((s) => s.routineId));
  assert.deepEqual([...ran].sort(), ["r_boppy_mac", "r_boppy_words", "r_nova", "r_penny", "r_rook"]);
  assert.ok(byId("r_boppy").nextRunAt < Date.now() && byId("r_otto_task").nextRunAt < Date.now(), "the runner's routines aren't advanced here");
  assert.ok(byId("r_rook").nextRunAt > Date.now(), "its own advanced");
  await sleep(10);
  // A reminder and a chat run of a bot on C1: the Mac's own.
  assert.ok(state.messages.some((m) => m.text === "Stand up"), "the reminder sent");
  assert.equal(byId("r_otto_chat").last?.status, "quiet", "the chat run run (nothing to say)");
  T.reset();
});

await check("a next time that's a skipped one (a skip and a run on two Bops put together) is moved past it before it's due", async () => {
  reset();
  const at = Date.now() + 3_600_000;
  state.routines = [routine("r_rook", "rook", { schedule: { kind: "every", minutes: 60 }, nextRunAt: at, lastRunAt: at - 3_600_000, skips: [at] }), routine("r_boppy", "boppy", { schedule: { kind: "every", minutes: 60 }, nextRunAt: at, lastRunAt: at - 3_600_000, skips: [at] })];
  tick();
  assert.equal(byId("r_rook").nextRunAt, at + 3_600_000, "the Mac's own: the time after");
  assert.equal(byId("r_boppy").nextRunAt, at + 3_600_000, "a runner's too, so Orgo doesn't wake its computer for nothing");
  assert.equal(fake.started.length, 0, "nothing run");
  await sleep(10);
  T.reset();
});

await check("a newer Bops wrote the state: no routine runs", () => {
  reset();
  seedRoutines();
  for (const r of state.routines) r.nextRunAt = Date.now() - 1000;
  tooNew = true;
  tick();
  assert.equal(fake.started.length, 0);
  assert.ok(state.routines.every((r) => r.nextRunAt < Date.now()), "nothing advanced");
  T.reset();
});

await check("a runner's timer waits until it's sure, then runs its own in the cloud, and Orgo hears the next time", async () => {
  reset();
  seedRoutines();
  asRunner(C1);
  onIdentity(C1);
  orgo.answer = (c) => (c.path === "/api/bops/settings" ? { status: 200, json: { runsOn: "cloud" } } : null);
  for (const r of state.routines) r.nextRunAt = Date.now() - 1000;
  tick();
  assert.equal(fake.started.length, 0, "nothing before the state is read and Orgo asked");
  assert.ok(!state.messages.length);
  await sleep(30);
  const ran = fake.started.map((s) => s.routineId).sort();
  assert.deepEqual(ran, ["r_boppy", "r_otto_task"], "its own tasks, once sure");
  assert.equal(fake.started[0].where, "cloud", "on its computer");
  assert.ok(!state.messages.some((m) => m.text === "Stand up"), "never a reminder (the Mac's), even with no Mac up");
  assert.ok(byId("r_otto_reminder").nextRunAt < Date.now() && byId("r_otto_chat").nextRunAt < Date.now(), "a reminder and a chat run stay due, for the Mac");
  assert.ok(byId("r_rook").nextRunAt < Date.now(), "another computer's isn't touched");
  orgo.calls.length = 0;
  await T.flushAll();
  const puts = orgo.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/routines"));
  assert.equal(puts.length, 1, "the main workspace's, its own routines");
  assert.deepEqual(puts[0].body.routines.map((r) => r.bopsId).sort(), ["r_boppy", "r_otto_task"]);
  assert.equal(puts[0].body.deleteMissing, undefined, "a runner never sends deleteMissing");
  assert.ok(Date.parse(puts[0].body.routines.find((r) => r.bopsId === "r_boppy").nextRunAt) > Date.now(), "the next time");
  R.runnerForTests.reset();
  T.reset();
});

await check("a routine that texts its result runs on its computer's runner and texts from there (Bops Cloud takes that text: cloud/test/core-computer-scope.test.ts), never left to the Mac", async () => {
  reset();
  const texts = [];
  const was = { ...globalThis.__fake.phone, ...{ backgroundTurn: globalThis.__fake.chat.backgroundTurn } };
  Object.assign(globalThis.__fake.phone, {
    ownerPhone: () => "+14155550199",
    isOwner: (n) => n === "+14155550199",
    textingLine: (b) => ({ from: b, line: { numberId: "num-main", agentId: "agent-main", phone: "+14155550100", type: "sms" } }),
    sendText: async (...a) => void texts.push(a),
  });
  try {
    const r = routine("r_text", "boppy", { deliverTo: { kind: "text" } });
    state.routines = [r];
    assert.equal(R.pinnedToMac(r, state.bots[0]), false, "a text needs no Mac");
    state.runners = { [C1]: up("running") };
    asRunner(C1);
    onIdentity(C1);
    assert.equal(R.runnerRoutine(r), true, "its runner's");
    orgo.answer = (c) => (c.path === "/api/bops/settings" ? { status: 200, json: { runsOn: "cloud" } } : null);
    r.nextRunAt = Date.now() - 1000;
    tick();
    for (let i = 0; i < 50 && !fake.started.length; i++) await sleep(10);
    // Its thread on C1 ends with its answer.
    const t = state.sessions.find((x) => x.id === byId("r_text").last.sessionId);
    t.status = "done";
    await Rt.onRoutineTaskEnd(t, "Three new orders today.");
    for (let i = 0; i < 50 && !texts.length; i++) await sleep(10);
    assert.deepEqual(texts.map((t) => [t[0], t[1], t[2]]), [["boppy", "+14155550199", "Three new orders today."]], "texted from the runner");
    for (let i = 0; i < 50 && !byId("r_text").last?.delivery; i++) await sleep(10);
    assert.equal(byId("r_text").last?.delivery?.status, "sent");
    // The Mac leaves it to the runner.
    asMac();
    assert.equal(R.runsHere(byId("r_text")), false);
  } finally {
    Object.assign(globalThis.__fake.phone, { ownerPhone: was.ownerPhone, isOwner: was.isOwner, textingLine: was.textingLine, sendText: was.sendText });
    globalThis.__fake.chat.backgroundTurn = was.backgroundTurn;
    R.runnerForTests.reset();
    T.reset();
  }
});

await check("a run on a computer's runner reaches nothing past it until Bops Cloud took its start: one whose bot the Mac moved off that computer first texts nothing, posts nothing, and stays due for the Bops that has the bot now; a reminder or a chat run there isn't even begun", async () => {
  reset();
  const texts = [];
  let turns = 0;
  const was = { ...globalThis.__fake.phone, backgroundTurn: globalThis.__fake.chat.backgroundTurn };
  Object.assign(globalThis.__fake.phone, {
    ownerPhone: () => "+14155550199",
    isOwner: (n) => n === "+14155550199",
    textingLine: (b) => ({ from: b, line: { numberId: "num-main", agentId: "agent-main", phone: "+14155550100", type: "sms" } }),
    sendText: async (...a) => void texts.push(a),
  });
  globalThis.__fake.chat.backgroundTurn = async () => {
    turns++;
    return { text: "Three new orders today." };
  };
  try {
    const due = Date.now() - 1000;
    // Each ran here yesterday (RoutineRun.by this runner), so Bops Cloud would take a word of theirs posted since (computer-scope.ts runsBy).
    const yesterday = { at: due - 86_400_000, status: "ok", by: deviceIdOf("u1", C1) };
    // A Gmail check (as a task) whose account is gone: its run fails, said in the chat and texted, once its start lands.
    const check = { source: { template: "check", app: "gmail", account: "acc_gone" }, deliverTo: { kind: "text" }, nextRunAt: due, last: yesterday };
    state.routines = [
      routine("r_check", "otto", check),
      routine("r_remind", "otto", { reminder: "Stand up", deliverTo: { kind: "text" }, nextRunAt: due }),
      routine("r_chat", "otto", { run: "chat", deliverTo: { kind: "text" }, nextRunAt: due }),
    ];
    const before = structuredClone(state.routines);
    asRunner(C1);
    onIdentity(C1);
    orgo.answer = (c) => (c.path === "/api/bops/settings" ? { status: 200, json: { runsOn: "cloud" } } : null);
    // The Mac gave Otto a computer of his own before this start reached Bops Cloud: it refuses it, and the
    // merge puts Otto and his routines back here as Bops Cloud has them (persist-cloud.ts mergeIn).
    const asked = [];
    landing = async (has) => {
      asked.push(has(state));
      await sleep(5);
      Object.assign(state.bots.find((b) => b.id === "otto"), { computer: "own", computerId: C2 });
      state.routines = structuredClone(before);
      return false;
    };
    tick();
    for (let i = 0; i < 50 && asked.length < 1; i++) await sleep(10);
    await sleep(30);
    assert.deepEqual(texts, [], "no text from the runner");
    assert.equal(turns, 0, "no turn on the model");
    assert.deepEqual(asked, [true], "the check's run asks once its start is made here; the reminder and the chat run, the Mac's, never begin");
    assert.deepEqual(state.messages.filter((m) => m.chatId === "bot:otto").map((m) => [m.routine?.id, m.text]), [], "nothing posted in Otto's chat for a run that never landed: the Mac posts it once");
    assert.deepEqual(
      state.routines.map((r) => [r.id, r.nextRunAt, r.last]),
      [
        ["r_check", due, yesterday],
        ["r_remind", due, undefined],
        ["r_chat", due, undefined],
      ],
      "still due in Bops Cloud: the Mac runs them, once",
    );
    // A task's thread waits for Bops Cloud the same way before it does anything (sessions.ts route).
    assert.match(readFileSync(`${root}/lib/server/sessions.ts`, "utf8"), /if \(onRunner\(\) && !\(await startLanded\(\(st\) => Array\.isArray\(st\.sessions\) && st\.sessions\.some\(/);
    // Its start taken: the check's failure is said and texted from the runner, as before.
    reset();
    state.routines = [routine("r_check", "otto", { ...check, nextRunAt: Date.now() - 1000 })];
    asRunner(C1);
    onIdentity(C1);
    orgo.answer = (c) => (c.path === "/api/bops/settings" ? { status: 200, json: { runsOn: "cloud" } } : null);
    tick();
    for (let i = 0; i < 50 && !texts.length; i++) await sleep(10);
    assert.deepEqual(
      texts.map((t) => [t[0], t[1]]),
      [["otto", "+14155550199"]],
    );
    assert.match(texts[0][2], /^"r_check" didn't run: That Gmail account isn't connected anymore/);
  } finally {
    Object.assign(globalThis.__fake.phone, { ownerPhone: was.ownerPhone, isOwner: was.isOwner, textingLine: was.textingLine, sendText: was.sendText });
    globalThis.__fake.chat.backgroundTurn = was.backgroundTurn;
    R.runnerForTests.reset();
    T.reset();
  }
});

await check("a task run on a computer's runner is recorded as that runner's from its start to its end (Bops Cloud takes its end from there if its bot moves off the computer meanwhile); on the Mac a run is its own, no runner said", async () => {
  reset();
  try {
    // Due 10 minutes ago, and this runner was up all along: it runs late, said first in the chat.
    state.routines = [routine("r_task", "otto", { nextRunAt: Date.now() - 10 * 60_000 })];
    asRunner(C1);
    onIdentity(C1);
    orgo.answer = (c) => (c.path === "/api/bops/settings" ? { status: 200, json: { runsOn: "cloud" } } : null);
    const me = globalThis.__fake.store.stateDevice();
    tick();
    for (let i = 0; i < 50 && !fake.started.length; i++) await sleep(10);
    const r = state.routines[0];
    assert.deepEqual([r.last.status, r.last.by], ["running", me], "begun as this runner's");
    const chip = state.messages.find((m) => m.chatId === "bot:otto" && m.sessionIds?.includes(r.last.sessionId));
    assert.match(chip?.text ?? "", /late, it was due/, "its late chip, on its thread");
    const t = state.sessions.find((x) => x.id === r.last.sessionId);
    t.status = "done";
    await Rt.onRoutineTaskEnd(t, "Three new orders today.");
    assert.deepEqual([r.last.status, r.last.by], ["ok", me], "and ended as its");
    // On the Mac, a run is its own anyway: no runner to say.
    reset();
    state.routines = [routine("r_task", "penny", { nextRunAt: Date.now() - 1000 })];
    tick();
    assert.deepEqual([state.routines[0].last?.status, state.routines[0].last?.by], ["running", undefined]);
  } finally {
    R.runnerForTests.reset();
    T.reset();
  }
});

/* ---------------- The routines mirror ---------------- */

await check("a computer's runner follows the user's time zone as the Mac keeps it (they travel) before it runs anything, so its bots are told the time where the user is now; a zone that isn't one is left alone", async () => {
  reset();
  const tzWas = process.env.TZ;
  const was = globalThis.__fake.sessions.startSession;
  const zones = [];
  // The zone its task starts in: what the bot is told the time in (chat.ts nowLines).
  globalThis.__fake.sessions.startSession = (o) => (zones.push(Intl.DateTimeFormat().resolvedOptions().timeZone), was(o));
  try {
    // Set up in New York (its wrapper's TZ); the Mac has since moved the user to London.
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "America/New_York");
    state.owner.timeZone = "Europe/London";
    state.routines = [routine("r_cal", "otto", { nextRunAt: Date.now() - 1000 })];
    asRunner(C1);
    onIdentity(C1);
    orgo.answer = (c) => (c.path === "/api/bops/settings" ? { status: 200, json: { runsOn: "cloud" } } : null);
    tick();
    for (let i = 0; i < 50 && !zones.length; i++) await sleep(10);
    assert.deepEqual(zones, ["Europe/London"], "the run's task is told London time");
    assert.equal(process.env.TZ, "Europe/London");
    // Something that isn't a zone in the state: the runner keeps the one it has.
    state.owner.timeZone = "Mars/Olympus";
    state.sessions.find((x) => x.id === byId("r_cal").last.sessionId).status = "done";
    byId("r_cal").nextRunAt = Date.now() - 1000;
    tick();
    for (let i = 0; i < 50 && zones.length < 2; i++) await sleep(10);
    assert.deepEqual(zones, ["Europe/London", "Europe/London"]);
  } finally {
    process.env.TZ = tzWas;
    globalThis.__fake.sessions.startSession = was;
    R.runnerForTests.reset();
    T.reset();
  }
});

await check("the mirror says how each routine runs and whether it needs the Mac", () => {
  reset();
  const p = (r) => Sync.routinePayload(r);
  assert.deepEqual([p(routine("a", "boppy")).run, p(routine("a", "boppy")).onMac], ["task", false]);
  // A reminder or a chat run needs no computer: Orgo never wakes one for it, nor keeps one up (always the Mac's).
  assert.deepEqual([p(routine("a", "otto", { reminder: "Stand up", where: "mac" })).run, p(routine("a", "otto", { reminder: "Stand up", where: "mac" })).onMac], ["reminder", true]);
  assert.deepEqual([p(routine("a", "otto", { run: "chat" })).run, p(routine("a", "otto", { run: "chat" })).onMac], ["chat", true]);
  assert.equal(p(routine("a", "otto")).onMac, false, "a task of a bot sharing C1: its runner's");
  assert.equal(p(routine("a", "otto", { run: "chat", fromOutside: "an email from desk@hotel.example", where: "cloud" })).run, "task", "someone else's is never a chat run");
  assert.equal(p(routine("a", "boppy", { where: "mac" })).onMac, true);
  assert.equal(p(routine("a", "penny")).onMac, true, "its bot works on the Mac");
  assert.equal(p(routine("a", "boppy", { goal: "Sort my files locally" })).onMac, true);
  // The Mac runs it when its computer has no runner up: Orgo wakes nothing for it, a reminder or a chat run neither.
  assert.equal(p(routine("a", "rook")).onMac, true, "C2 has no runner");
  assert.equal(p(routine("a", "nova", { reminder: "Stand up" })).onMac, true, "no computer");
  for (const status of ["installing", "failed", "stopping"]) {
    state.runners[C1] = up(status);
    assert.equal(p(routine("a", "otto", { reminder: "Stand up" })).onMac, true, `C1's runner ${status}`);
  }
  // A one-off: its time while it waits; none once it fired (off then: Orgo wakes nothing for it again).
  state.runners[C1] = up("running");
  const at = Date.now() - 60_000;
  const one = (o) => p(routine("a", "otto", { schedule: { kind: "once", at }, nextRunAt: at, ...o }));
  assert.deepEqual([one({}).nextRunAt, one({}).onMac], [new Date(at).toISOString(), false], "due: C1 is woken for it");
  assert.deepEqual([one({ enabled: false, nextRunAt: undefined, lastRunAt: at + 1000 }).nextRunAt, one({ enabled: false, nextRunAt: undefined, lastRunAt: at + 1000 }).enabled], [undefined, false], "fired: off, no next time");
  // A run waiting on the owner's OK there, or a saved login its bot may use: still C1's, so Orgo keeps waking it.
  state.vault = [{ id: "login1", site: "shopify.com", username: "ava@example.com", hasPassword: true, hasTotp: false, bots: "all", auto: true, addedAt: 0 }];
  assert.equal(p(routine("a", "otto", { last: { at, status: "running", sessionId: "ses_waits" } })).onMac, false);
  delete state.vault;
});

await check("a runner sends only its own routines, never deleteMissing; the Mac the whole set", async () => {
  reset();
  seedRoutines();
  asRunner(C1);
  onIdentity(C1);
  Sync.routineChanged("boppy", { deleted: true });
  Sync.syncRoutinesOnStart();
  await T.flushAll();
  const puts = orgo.calls.filter((c) => c.method === "PUT");
  assert.deepEqual(puts.map((c) => c.path), [`/api/projects/${PID}/routines`], "nothing for a workspace with none of its routines");
  assert.deepEqual(puts[0].body.routines.map((r) => r.bopsId).sort(), ["r_boppy", "r_otto_task"], "a reminder and a chat run of its bots are the Mac's to send");
  assert.equal(puts[0].body.deleteMissing, undefined);
  reset();
  seedRoutines();
  Sync.routineChanged("boppy", { deleted: true });
  await T.flushAll();
  const mac = orgo.calls.filter((c) => c.method === "PUT");
  assert.equal(mac.length, 1);
  assert.equal(mac[0].body.deleteMissing, true);
  assert.equal(mac[0].body.routines.length, 8, "every routine of the workspace");
});

/* ---------------- Which computer it's on ---------------- */

await check("a runner makes sure it's on its own computer: the same word back runs, another (a copy) takes it off, no answer waits", async () => {
  reset();
  asRunner(C1);
  assert.equal(await R.checkIdentity(), "same", "the word it wrote, read back from its computer");
  assert.match(orgo.bash[0].command, /cat \/run\/bops-runner\/nonce/);
  assert.equal(orgo.bash[0].computer, C1, "read from the computer it was set up on");
  assert.equal(left, 0);
  // A copy: the computer it names has another word (its own runner's), or none.
  orgo.here = C2;
  assert.equal(await R.checkIdentity(), "copy");
  assert.equal(left, 1, "a copy takes its runner off");
  orgo.here = "down";
  assert.equal(await R.checkIdentity(), "unknown", "no answer proves nothing");
  assert.equal(left, 1, "and takes nothing off");
  // A slow computer: the command timed out there (Orgo answers 200, exit 124, no word): proves nothing either.
  orgo.here = "slow";
  assert.equal(await R.checkIdentity(), "unknown");
  assert.equal(left, 1, "the real runner stays");
  assert.match(orgo.bash.at(-1).command, /echo __BOPS_NONCE_END__/, "a read that ran to its end says so");
});

await check("on its computer's identity, a runner asks its VMM which computer it's on, never Orgo: another is a copy; no answer is the look through Orgo", async () => {
  reset();
  asRunner(C1);
  vmId.here = true;
  vmId.who = { desktopId: C1.toUpperCase(), vmId: "vm-a" };
  assert.equal(await R.checkIdentity(), "same");
  assert.equal(orgo.bash.length, 0, "no command on its computer: the look doesn't count as using it");
  assert.equal(R.runnerReady(), false, "and it counts as sure (the rest isn't fresh yet)");
  vmId.who = { desktopId: C2, vmId: "vm-c" };
  assert.equal(await R.checkIdentity(), "copy");
  assert.equal(left, 1, "a copy leaves");
  assert.equal(orgo.bash.length, 0);
  // Its VMM doesn't say (restarting): the word through Orgo, as on a key file.
  vmId.who = null;
  assert.equal(await R.checkIdentity(), "same");
  assert.match(orgo.bash[0].command, /cat \/run\/bops-runner\/nonce/);
  // On its key file (no identity here): through Orgo only, as before.
  vmId.here = false;
  vmId.who = { desktopId: C2, vmId: "vm-c" };
  assert.equal(await R.checkIdentity(), "same", "the VMM isn't asked");
  assert.equal(left, 1);
  // The minute's watch: a copy leaves; its own computer stays.
  vmId.here = true;
  vmId.who = { desktopId: C1, vmId: "vm-a" };
  await R.watchIdentity();
  assert.equal(left, 1);
  vmId.who = { desktopId: C2, vmId: "vm-c" };
  await R.watchIdentity();
  assert.equal(left, 2);
});

await check("a copy takes off only its runner's program and the script that starts it, never the computer's Orgo key", async () => {
  reset();
  asRunner(C1);
  const [conf, wrapper, secrets, env] = ["bops-runner.conf", "run.sh", ".orgo-secrets.env", ".env"].map((f) => join(nonceDir, f));
  for (const f of [conf, wrapper, secrets, env]) writeFileSync(f, f === secrets || f === env ? "export ORGO_API_KEY=sk_the_computers_own\n" : "x");
  orgo.here = C2;
  assert.equal(await R.checkIdentity(), "copy");
  assert.equal(left, 1, "and it's gone");
  assert.ok(!existsSync(conf) && !existsSync(wrapper), "its program and its script taken off");
  assert.ok(existsSync(secrets) && existsSync(env), "the key files stay: Orgo gives a copy its own key, or takes it off");
  assert.deepEqual(R.COPY_TAKES_OFF, ["/etc/supervisor/conf.d/bops-runner.conf", "/opt/bops/runner/run.sh"]);
  // The first command on a new copy (sessions.ts ensureComputer): the same, and shell that parses.
  assert.match(R.RUNNER_SCRUB, /rm -f \/etc\/supervisor\/conf\.d\/bops-runner\.conf \/opt\/bops\/runner\/run\.sh;/);
  assert.ok(!/orgo-secrets|\/root\/\.env|ORGO_API_KEY|\/root\/\.bops\/runner\/key/.test(R.RUNNER_SCRUB), R.RUNNER_SCRUB);
  assert.equal(spawnSync("bash", ["-n"], { input: R.RUNNER_SCRUB }).status, 0);
  for (const f of [secrets, env]) rmSync(f, { force: true });
});

await check("a runner runs nothing until it's sure which computer it's on, and looks again after a nap", async () => {
  reset();
  asRunner(C1);
  orgo.answer = () => ({ status: 200, json: { runsOn: "cloud" } });
  pulledAt = Date.now();
  R.runnerForTests.hear("u1", "cloud");
  orgo.here = "down";
  let again = 0;
  assert.equal(R.runnerReady(() => again++), false, "not sure yet");
  await sleep(20);
  assert.equal(again, 0, "Orgo didn't answer: still not");
  orgo.here = null;
  assert.equal(R.runnerReady(() => again++), false);
  await sleep(20);
  assert.equal(again, 1, "sure now: the timer goes again");
  assert.equal(R.runnerReady(), true);
  // A look stands under a minute for starting a run: a live copy (a fork) carrying on from the same memory looks again first.
  R.runnerForTests.sure(Date.now() - 50_000);
  assert.equal(R.runnerReady(), false, "a look 50 seconds old: not sure enough to start a run");
  await sleep(20);
  assert.equal(R.runnerReady(), true);
  const looks = orgo.bash.length;
  napped = true;
  assert.equal(R.runnerReady(), false, "a nap since: not sure any more");
  await sleep(20);
  assert.equal(orgo.bash.length, looks + 1, "and it looks again");
  napped = false;
  R.runnerForTests.reset();
});

await check("an idle runner's timer asks nothing: no command on its computer (that would keep it up), no read of the state or Orgo", async () => {
  reset();
  asRunner(C1);
  state.routines = [routine("r_boppy", "boppy", { nextRunAt: Date.now() + 3_600_000 }), routine("r_rook", "rook", { nextRunAt: Date.now() - 1000 })];
  napped = true;
  tick();
  await sleep(20);
  assert.equal(orgo.bash.length, 0, "no look at its computer");
  assert.equal(fake.pulls, 0);
  assert.ok(!orgo.calls.some((c) => c.path === "/api/bops/settings"), "Orgo not asked");
  // One of its own comes due: then it makes sure of all three.
  byId("r_boppy").nextRunAt = Date.now() - 1000;
  napped = false;
  tick();
  await sleep(20);
  assert.equal(orgo.bash.length, 1, "its computer looked at");
  assert.equal(fake.pulls, 1);
  R.runnerForTests.reset();
});

rmSync(nonceDir, { recursive: true, force: true });
console.log(`runner: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
