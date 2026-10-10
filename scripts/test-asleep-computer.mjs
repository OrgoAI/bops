// Tests for a computer that's asleep (Free's Bops computer, suspended after 15 minutes nobody used it):
// nothing the app does to look at it wakes it, and nothing takes it for gone. The computer view reads the
// computer's status only, never its screens (app/api/computer); a screenshot Orgo
// answers with 409 computer_asleep is asleep, never gone (app/api/screen, healIfGone); how often the app
// looks again (lib/types.ts computerCheckMs): never while the window is hidden, every minute while it's
// asleep with nothing on it, and sooner while a task or the user wakes it; taking over says it's in use,
// then wakes it (free-hours.ts wakeForUser, sessions.ts takeOver), even when its status couldn't be read,
// and hands control back with Orgo's words when it can't (kept for the asleep panel); and getting a screen
// ready never makes another on a computer Orgo answered for from its record, nor wakes one that's up. And a
// computer asleep in storage (orgo-web's High Performance suspend): an action waits while it wakes (409
// computer_waking, 503 wake_failed, with Retry-After) and is made once it's up, a read is never held, a
// resume never waits, and none of it is ever taken for gone. Every call says the app's version.
// Orgo is a fake fetch on a made-up origin that keeps orgo-web's rules for an idle Free computer, and the
// state a throwaway file store in a temporary folder: nothing reaches Orgo.
// Usage: node --conditions=react-server scripts/test-asleep-computer.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A file store, loaded at once and always ready (lib/server/persist.ts); the Mac app's ways (cloud.ts cloudOn,
// so Bops says when its computer is in use) once it's loaded, below.
process.env.BOPS_SELF_HOSTED = "1";
for (const k of ["ORGO_API_KEY", "BOPS_ORGO_WORKSPACE", "BOPS_ORGO_TEMPLATE", "BOPS_DATABASE_URL", "AGENTMAIL_API_KEY", "BOPS_MAIL_DOMAIN", "OPENAI_API_KEY", "TAILSCALE_AUTH_KEY", "BOPS_WEBRTC", "BOPS_SCREEN_STREAM"])
  delete process.env[k];
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
// The app's version, which every call to Orgo says (lib/server/app-version.ts orgoHeaders).
process.env.BOPS_APP_VERSION = "9.9.9";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Modules that would start processes when loaded, or that Node can't load, are stand-ins whose exports do nothing (as in test-plan.mjs).
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
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
const scratch = mkdtempSync(join(tmpdir(), "bops-test-asleep-"));
process.chdir(scratch);
// Signed in already: the key is in memory, so the Keychain is never asked (lib/server/orgo-auth.ts).
globalThis.bopsOrgoKey = "sk_test_asleep";

/* ---------------- A fake Orgo, with orgo-web's rules for an idle Free computer ---------------- */

const PC = "c-free-1";
const IDLE_MS = 15 * 60_000;
/**
 * The computer: its status, and when the app last said it's in use (null: never, so Orgo never puts it to
 * sleep for want of use). `screens409`: the next list of its screens says it's asleep (409) instead, as
 * orgo-web does with no size on record. `recorded`: the extra screens on Orgo's record, which it lists an
 * asleep computer from. `refuse`: what its resume answers instead of waking it. `statusDown`: its status
 * read fails (5xx) this many times. `answers`: what Orgo says, in turn, to the next calls about it other
 * than its status read (a computer waking from storage), before it answers as usual.
 */
const pc = { status: "running", activeAt: null, woken: 0, screens409: false, recorded: [], refuse: null, statusDown: 0, answers: [] };
// orgo-web's freeIdleAsleep: suspended, and said to be in use once but not for 15 minutes.
const idleAsleep = () => pc.status === "suspended" && pc.activeAt !== null && Date.now() - pc.activeAt > IDLE_MS;
const wake = () => {
  pc.status = "running";
  pc.woken++;
};
const asleepFor = (ms = IDLE_MS + 60_000) => Object.assign(pc, { status: "suspended", activeAt: Date.now() - ms });
// As orgo-web lists them: the computer's own list has its ports; one answered from the record (asleep) has none.
const listed = (d, ports) => ({ id: d === 99 ? "default" : `screen-${d}`, display: `:${d}`, width: 1280, height: 960, vnc_port: ports ? 5900 + d : null, ws_port: ports ? 5981 + d : null, default: d === 99 });
const SCREENS = [99, 100, 101, 102].map((d) => listed(d, true));
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const calls = [];
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin !== "https://orgo.test") throw new TypeError(`fetch failed (not the fake Orgo: ${url})`);
  const body = req.body ? await req.text() : "";
  const call = { method: req.method, path: url.pathname, body: body ? JSON.parse(body) : undefined, auth: req.headers.get("authorization"), version: req.headers.get("x-bops-version") };
  calls.push(call);
  const at = `${call.method} ${call.path}`;
  if (pc.answers.length && call.path.startsWith(`/api/computers/${PC}/`)) return pc.answers.shift()(call);
  if (at === "POST /api/bops/computer/active") {
    pc.activeAt = Date.now();
    return json(200, { ok: true });
  }
  if (at === `GET /api/computers/${PC}` && pc.statusDown > 0) {
    pc.statusDown--;
    return json(503, { error: "Service unavailable" });
  }
  if (at === `GET /api/computers/${PC}`) return json(200, { id: PC, name: "boppy", status: pc.status, cpu: 4, ram: 16, os: "linux", vnc_password: "pw" });
  if (at === `GET /api/computers/${PC}/screens`) {
    if (pc.screens409) {
      pc.screens409 = false;
      return json(409, { error: "This computer is asleep.", code: "computer_asleep" });
    }
    // Asleep for want of use: answered from what Orgo has on record (its boot screen and the screens it
    // recorded, orgo-web screensFromRecord), not woken.
    if (idleAsleep()) return json(200, { screens: [99, ...pc.recorded].map((d) => listed(d, false)) });
    // Any other suspended computer wakes for a read, as Orgo always did.
    if (pc.status === "suspended") wake();
    return json(200, { screens: SCREENS });
  }
  if (at === `GET /api/computers/${PC}/screenshot`) {
    if (idleAsleep()) return json(409, { error: "This computer is asleep.", code: "computer_asleep" });
    if (pc.status === "suspended") wake();
    return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
  }
  // An action wakes it, asleep or not.
  if (at === `POST /api/computers/${PC}/bash`) {
    if (pc.status === "suspended") wake();
    return json(200, { output: "", exit_code: 0 });
  }
  // So does adding a screen, which the computer turns down once it has its four.
  if (at === `POST /api/computers/${PC}/screens`) {
    if (pc.status === "suspended") wake();
    return json(409, { error: "This computer already has the most screens it can.", code: "screen_limit" });
  }
  if (at === `POST /api/computers/${PC}/resume`) {
    if (pc.refuse) return pc.refuse();
    if (pc.status === "suspended") wake();
    return json(200, { success: true });
  }
  return json(404, { error: "Not found" });
};
const asked = (method, path, since = 0) => calls.slice(since).filter((c) => c.method === method && c.path === path).length;
const later = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const noDashes = (text) => assert.ok(!/[–—]/.test(text), `no dashes: ${text}`);

const T = await import(`${root}/lib/types.ts`);
const O = await import(`${root}/lib/server/orgo.ts`);
const S = await import(`${root}/lib/server/store.ts`);
const X = await import(`${root}/lib/server/sessions.ts`);
const C = await import(`${root}/app/api/computer/route.ts`);
const SR = await import(`${root}/app/api/screen/route.ts`);
// Loaded: now it's the Mac app, which says when its computer is in use (free-hours.ts sayInUse).
delete process.env.BOPS_SELF_HOSTED;

S.update((s) => {
  s.host = "orgo";
  Object.assign(s.bots.find((b) => b.isMain), { computerId: PC, computerStatus: "ready", freeComputer: true, tailnet: undefined });
});
const main = () => S.bot("boppy");
const computerView = async () => {
  const res = await C.GET(new Request("http://localhost:3210/api/computer?bot=boppy"));
  return { status: res.status, ...(await res.json()) };
};
const shot = (display = 100) => SR.GET(new Request(`http://localhost:3210/api/screen?bot=boppy&display=${display}`));
const saidInChat = () => S.getState().messages.filter((m) => m.chatId === "bot:boppy" && m.role === "bot").map((m) => m.text);

/* ---------------- Asleep, in use, and how often the app looks (lib/types.ts) ---------------- */

// Its screens are read only while it runs (or before Orgo has said otherwise); asleep is suspended.
assert.equal(T.computerUp(undefined), true, "not known yet: as before");
assert.equal(T.computerUp("running"), true);
for (const s of ["suspended", "stopped", "frozen", "starting", "error"]) assert.equal(T.computerUp(s), false, s);
assert.equal(T.computerAsleep("suspended"), true);
for (const s of [undefined, "running", "starting", "stopped", "frozen"]) assert.equal(T.computerAsleep(s), false, `${s}`);
const on = (id) => id === "boppy" || id === "otto";
const ses = (over) => ({ id: "s", botId: "boppy", chatId: "c", title: "t", goal: "g", status: "running", runsOn: "cloud", steps: [], replies: [], createdAt: 1, ...over });
assert.equal(T.computerInUse({ sessions: [] }, on), false);
assert.equal(T.computerInUse({ sessions: [ses({ status: "starting" })] }, on), true, "a task starting there");
assert.equal(T.computerInUse({ sessions: [ses({ botId: "otto" })] }, on), true, "a task of a bot that shares it");
assert.equal(T.computerInUse({ sessions: [ses({ status: "queued" })] }, on), false, "a task waiting for a screen isn't on it yet");
assert.equal(T.computerInUse({ sessions: [ses({ status: "done" })] }, on), false);
assert.equal(T.computerInUse({ sessions: [ses({ runsOn: "mac" })] }, on), false, "a task on the user's Mac");
assert.equal(T.computerInUse({ sessions: [ses({ botId: "kai" })] }, on), false, "a task on another computer");
assert.equal(T.computerInUse({ sessions: [], takeover: { botId: "boppy", display: 100, since: 1 } }, on), true, "the user driving one of its screens");
assert.equal(T.computerInUse({ sessions: [], takeover: { botId: "boppy", macScreen: 0, since: 1 } }, on), false, "the user driving a Chrome on their Mac");
assert.equal(T.computerInUse({ sessions: [], takeover: { botId: "kai", display: 100, since: 1 } }, on), false);
const every = (status, visible, inUse) => T.computerCheckMs(status, { visible, inUse });
assert.equal(every("running", true, false), 8000, "every 8 seconds while it runs, as before");
assert.equal(every(undefined, true, false), 8000, "and before its status is known");
assert.equal(every("starting", true, false), 8000, "and while it's on its way up (its status only: its screens aren't read)");
assert.equal(every("suspended", true, false), 60_000, "asleep with nothing on it: every minute (its status only, which never wakes it)");
assert.equal(every("suspended", true, true), 2000, "asleep while a task or the user wakes it: sooner, till it's up");
for (const status of ["running", "suspended", undefined]) for (const inUse of [false, true]) assert.equal(every(status, false, inUse), null, `the window hidden: never (${status}, ${inUse})`);

/* ---------------- The computer view: its status, never its screens ---------------- */

// Running: its status (and pages over the tailnet, none here). Never its screens from Orgo: a read of them
// that began as it fell asleep is retried on 5xx, and the retry would land on the suspended computer.
let n = calls.length;
let v = await computerView();
assert.equal(v.status, 200);
assert.equal(v.computer.status, "running");
assert.equal(v.screens, undefined);
assert.deepEqual(calls.slice(n).map((c) => `${c.method} ${c.path}`), [`GET /api/computers/${PC}`], "its status only");
// Asleep: the status only, so nothing wakes it.
asleepFor();
n = calls.length;
v = await computerView();
assert.deepEqual([v.status, v.computer.status, v.pages], [200, "suspended", {}]);
assert.deepEqual(calls.slice(n).map((c) => `${c.method} ${c.path}`), [`GET /api/computers/${PC}`]);
assert.deepEqual([pc.status, pc.woken], ["suspended", 0], "still asleep");
// Any status but running is left alone the same way (one on its way up, or a stopped one).
for (const status of ["starting", "stopped"]) {
  pc.status = status;
  n = calls.length;
  assert.equal((await computerView()).computer.status, status);
  assert.equal(asked("GET", `/api/computers/${PC}/screens`, n), 0, status);
}
pc.status = "running";
console.log("the computer view: its status only, never its screens");

/* ---------------- A screenshot of a computer that's asleep: asleep, never gone ---------------- */

asleepFor();
n = calls.length;
let res = await shot(100);
assert.equal(res.status, 409);
assert.equal(await res.text(), "asleep");
await later();
assert.deepEqual([pc.status, pc.woken], ["suspended", 0], "not woken");
assert.equal(main().computerId, PC, "the bot keeps its computer");
assert.equal(asked("GET", `/api/computers/${PC}`, n), 0, "nobody asked Orgo whether it's still there");
assert.deepEqual(saidInChat(), [], "nothing said about a computer that's gone");
// Orgo's code comes with a screenshot it turned down; asleep is told apart from gone, and from any other 409.
const asleepErr = await O.orgo.screenshot(PC, "screen-100").catch((e) => e);
assert.ok(asleepErr instanceof O.OrgoError);
assert.deepEqual([asleepErr.status, asleepErr.code, asleepErr.said], [409, "computer_asleep", "This computer is asleep."]);
assert.equal(O.computerAsleepError(asleepErr), true);
assert.equal(X.computerGone(asleepErr), false, "asleep is never gone");
assert.equal(O.computerAsleepError(new O.OrgoError("x", 409, "webrtc_ineligible")), false);
assert.equal(O.computerAsleepError(new O.OrgoError("x", 404)), false);
assert.equal(O.computerAsleepError(new Error("computer_asleep")), false);
// Up again, a screenshot comes as before.
pc.status = "running";
res = await shot(100);
assert.equal(res.status, 200);
assert.equal(res.headers.get("content-type"), "image/jpeg");
console.log("a screenshot of a computer that's asleep: 409 asleep, not woken, not gone");

/* ---------------- Taking over wakes it ---------------- */

// Asleep: Orgo hears it's in use, then it's woken for the user (the live view only streams it), and they drive it.
asleepFor();
n = calls.length;
await X.takeOver("boppy", 100);
assert.deepEqual(
  calls.slice(n).map((c) => `${c.method} ${c.path}`),
  ["POST /api/bops/computer/active", `GET /api/computers/${PC}`, `POST /api/computers/${PC}/resume`],
  "said to be in use first, then woken",
);
assert.equal(calls[n].auth, "Bearer sk_test_asleep");
assert.deepEqual([pc.status, pc.woken], ["running", 1]);
assert.equal(S.getState().takeover?.display, 100, "the user drives it");
assert.deepEqual(saidInChat(), []);
X.returnControl();
// Running: said to be in use, nothing to wake.
n = calls.length;
await X.takeOver("boppy", 101);
assert.equal(asked("POST", "/api/bops/computer/active", n), 1);
assert.equal(asked("POST", `/api/computers/${PC}/resume`, n), 0, "nothing to wake");
X.returnControl();
// Free's 10 hours this month used: it can't wake, so control goes straight back, and the bot says why in Orgo's words.
const usedUp = "Your free Bops computer has used its 10 hours this month. It's back on November 1, or upgrade to Pro to keep it on.";
asleepFor();
pc.refuse = () => json(402, { error: usedUp, code: "bops_free_hours" });
await X.takeOver("boppy", 100);
assert.equal(S.getState().takeover, undefined, "handed back");
assert.equal(pc.status, "suspended");
assert.deepEqual(saidInChat(), [`My computer is asleep and couldn't wake up. ${usedUp}`]);
noDashes(saidInChat()[0]);
// Anything else that keeps it asleep: handed back too, with a plain word.
pc.refuse = () => json(409, { error: "Computer can't be resumed right now (status: suspending)" });
await X.takeOver("boppy", 100);
assert.equal(S.getState().takeover, undefined);
assert.equal(saidInChat().at(-1), "My computer is asleep and couldn't wake up. Try again in a moment.");
assert.equal(main().wakeFailed?.why, "Try again in a moment.", "kept for the asleep panel");
// Any other 402 (a plan without running computers): Orgo's own words, not the generic line.
const noPlan = "Your plan does not include running computers. Upgrade to resume this computer.";
pc.refuse = () => json(402, { error: noPlan, code: "upgrade_required" });
await X.takeOver("boppy", 100);
assert.equal(S.getState().takeover, undefined);
assert.equal(saidInChat().at(-1), `My computer is asleep and couldn't wake up. ${noPlan}`);
assert.equal(main().wakeFailed?.why, noPlan);
// On its way up already (409 not suspended): up, so the user keeps control, and the last failure is cleared.
pc.refuse = () => json(409, { error: "Computer is not suspended (status: starting)" });
await X.takeOver("boppy", 100);
assert.equal(S.getState().takeover?.display, 100, "the user drives it");
assert.equal(main().wakeFailed, undefined, "cleared");
X.returnControl();
pc.refuse = null;
// Its status read failed: no proof it's up, so it's resumed anyway, and wakes.
asleepFor();
pc.statusDown = 3;
pc.woken = 0;
n = calls.length;
await X.takeOver("boppy", 100);
assert.equal(asked("POST", `/api/computers/${PC}/resume`, n), 1, "resumed without its status");
assert.deepEqual([pc.status, pc.woken], ["running", 1]);
assert.equal(S.getState().takeover?.display, 100);
X.returnControl();
// Running, with its status read failing: resumed too, which Orgo answers 200 for, and the user drives it.
pc.statusDown = 3;
await X.takeOver("boppy", 101);
assert.equal(S.getState().takeover?.display, 101);
X.returnControl();
console.log("taking over: said to be in use, then woken; handed back with Orgo's words when it can't wake");

/* ---------------- Getting a screen ready on a computer Orgo answered for from its record ---------------- */

// Asleep for want of use, its screens come from Orgo's record (its boot screen only) rather than the
// computer: an action wakes it, and the list is read again before any screen is made. None is.
asleepFor();
pc.woken = 0;
n = calls.length;
await X.ensureScreens(PC);
assert.equal(asked("POST", `/api/computers/${PC}/screens`, n), 0, "no screen made on top of the ones it has");
assert.deepEqual([pc.status, pc.woken], ["running", 1], "woken once, by an action");
assert.deepEqual(
  calls.slice(n, n + 4).map((c) => `${c.method} ${c.path}${c.body?.command ? ` ${c.body.command}` : ""}`),
  [`GET /api/computers/${PC}/screens`, `POST /api/computers/${PC}/bash true`, `GET /api/computers/${PC}/screens`, `POST /api/computers/${PC}/bash ${calls[n + 3].body.command}`],
);
assert.match(calls[n + 3].body.command, /bops-chrome 100$/, "then its Chrome, as before");
// A computer that's up and lists every screen: nothing extra.
n = calls.length;
await X.ensureScreens(PC);
assert.equal(asked("GET", `/api/computers/${PC}/screens`, n), 3, "one look per screen (the boot screen needs none)");
assert.ok(!calls.slice(n).some((c) => c.body?.command === "true"), "no wake when every screen is there");
// The common real case: asleep, with its screens on Orgo's record. Each is found in the list, so no extra
// wake: the screen's Chrome check (a command) wakes it, and no screen is made.
asleepFor();
pc.recorded = [100, 101, 102];
pc.woken = 0;
n = calls.length;
await X.ensureScreens(PC);
assert.ok(!calls.slice(n).some((c) => c.body?.command === "true"), "no extra wake: its screen was on record");
assert.match(calls[n + 1].body?.command ?? "", /curl .*\|\| bops-chrome 100$/, "found, then its Chrome check wakes it");
assert.deepEqual([pc.status, pc.woken], ["running", 1]);
assert.equal(asked("POST", `/api/computers/${PC}/screens`, n), 0, "no screen made");
pc.recorded = [];
// Asleep with nothing on record to list it from (409 computer_asleep): woken by an action, then listed.
asleepFor();
pc.screens409 = true;
pc.woken = 0;
n = calls.length;
await X.ensureScreens(PC);
assert.deepEqual(
  calls.slice(n, n + 3).map((c) => `${c.method} ${c.path}${c.body?.command ? ` ${c.body.command}` : ""}`),
  [`GET /api/computers/${PC}/screens`, `POST /api/computers/${PC}/bash true`, `GET /api/computers/${PC}/screens`],
);
assert.equal(asked("POST", `/api/computers/${PC}/screens`, n), 0, "no screen made");
assert.equal(main().computerId, PC, "not taken for gone");
console.log("a screen made ready: woken by an action first, never a screen too many");

/* ---------------- Asleep in storage: an action waits for the wake, never takes it for gone ---------------- */

// Orgo took it off its server while it slept (orgo-web's High Performance suspend). An action wakes it from
// storage; while it comes back Orgo answers 409 computer_waking with when to ask again, and the action is
// made again then, once it's up. Nothing is taken for gone, and nothing is deleted.
const waking = (retry = 1) => () => new Response(JSON.stringify({ error: "This computer is waking up. Try again in a minute.", code: "computer_waking", retry_after: retry }), { status: 409, headers: { "content-type": "application/json", "retry-after": String(retry) } });
const wakeFailed = () => json(503, { error: "This computer couldn't wake up just now. Try again in a minute.", code: "wake_failed", retry_after: 1 });
pc.status = "running";
pc.answers = [waking(), waking()];
n = calls.length;
let t0 = Date.now();
let out = await O.orgo.bash(PC, "true", 30);
assert.deepEqual(out, { output: "", exit_code: 0 }, "made once it's up");
assert.equal(asked("POST", `/api/computers/${PC}/bash`, n), 3, "asked again when Orgo said, twice");
assert.ok(Date.now() - t0 >= 1900, "waited as long as Orgo said (Retry-After: 1, twice)");
// A wake that didn't work this time (503 wake_failed): Orgo tries again, and so does the action.
pc.answers = [wakeFailed];
n = calls.length;
out = await O.orgo.bash(PC, "true", 30);
assert.equal(out.exit_code, 0);
assert.equal(asked("POST", `/api/computers/${PC}/bash`, n), 2);
// A read is never held: one of a computer that's waking answers at once, and is waking, never gone.
pc.answers = [waking()];
n = calls.length;
t0 = Date.now();
const readErr = await O.orgo.screens(PC).catch((e) => e);
assert.ok(Date.now() - t0 < 900, "a read doesn't wait");
assert.deepEqual([readErr.status, readErr.code], [409, "computer_waking"]);
assert.equal(O.computerWakingError(readErr), true);
assert.equal(X.computerGone(readErr), false, "waking is never gone");
assert.equal(await X.healIfGone(PC, readErr), false, "nothing to heal");
// Past the wait (BOPS_WAKE_WAIT_MS, 6 minutes unless set): the action ends with Orgo's words, the computer kept.
process.env.BOPS_WAKE_WAIT_MS = "1500";
pc.answers = [waking(), waking(), waking(), waking()];
n = calls.length;
const late = await O.orgo.bash(PC, "true", 30).catch((e) => e);
assert.ok(late instanceof O.OrgoError && late.code === "computer_waking", "Orgo's code, for the caller to wait on");
assert.equal(asked("POST", `/api/computers/${PC}/bash`, n), 2, "one more ask in the time there was");
assert.equal(await X.healIfGone(PC, late), false);
delete process.env.BOPS_WAKE_WAIT_MS;
pc.answers = [];
// Every waking code is a wait; a computer gone or an action turned down isn't.
for (const code of ["computer_waking", "suspend_in_progress", "resume_in_progress", "resuming", "wake_failed", "no_capacity", "saved_state_unavailable"])
  assert.equal(O.computerWakingError(new O.OrgoError("x", code === "computer_waking" || code.endsWith("_in_progress") ? 409 : 503, code)), true, code);
for (const e of [new O.OrgoError("x", 404), new O.OrgoError("x", 409, "computer_asleep"), new O.OrgoError("x", 402, "bops_free_hours"), new Error("computer_waking")])
  assert.equal(O.computerWakingError(e), false, e.message);
// A resume never waits: one asleep in storage answers at once (202, waking), and so does a wake that failed.
pc.answers = [() => json(202, { success: true, pending: true, waking: true, expected_seconds: 90 })];
t0 = Date.now();
assert.deepEqual(await O.orgo.resume(PC), { success: true, pending: true, waking: true, expected_seconds: 90 });
pc.answers = [wakeFailed];
const resumeErr = await O.orgo.resume(PC).catch((e) => e);
assert.equal(resumeErr.code, "wake_failed");
assert.ok(Date.now() - t0 < 900, "neither waited");
// Getting a screen ready while it wakes: its list is read again after an action, as for one asleep.
pc.answers = [waking()];
n = calls.length;
await X.ensureScreens(PC);
assert.deepEqual(
  calls.slice(n, n + 3).map((c) => `${c.method} ${c.path}${c.body?.command ? ` ${c.body.command}` : ""}`),
  [`GET /api/computers/${PC}/screens`, `POST /api/computers/${PC}/bash true`, `GET /api/computers/${PC}/screens`],
);
assert.equal(main().computerId, PC, "the bot keeps its computer");
assert.equal(calls.filter((c) => c.method === "DELETE").length, 0, "nothing deleted");
console.log("asleep in storage: an action waits for the wake (computer_waking, wake_failed), a read and a resume don't, never gone");

assert.ok(calls.every((c) => c.auth === "Bearer sk_test_asleep"), "Orgo asked with the user's own key");
assert.ok(calls.every((c) => c.version === "9.9.9"), "every call says the app's version");
console.log(`all asleep-computer tests passed (${calls.length} fake Orgo calls, none to the network)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
