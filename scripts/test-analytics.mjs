// Tests for Bops' usage events (README, Privacy; cloud/analytics-rules.ts): the rules every event is
// cleaned against (only listed events and properties leave, error messages and stacks scrubbed, never
// an orgo-web funnel name), the window's posthog-js setup (lib/analytics.ts: nothing that records the
// screen, identify by the Orgo user id only, reset on sign-out and on another user), the Mac's server
// (lib/server/analytics.ts, /api/analytics: who may send, the switch, the header to the cloud, exceptions),
// Bops Cloud's sender (cloud/analytics.ts: the off header, the user's switch from their state), and that
// the catalog matches the code. The real posthog-node runs; only fetch is fake, and PostHog's batch
// endpoint is recorded: nothing reaches the network. The state is a throwaway file store, the
// Keychain, the cloud's tunnel and the relay are stand-ins, and Bops Cloud's database is a fake query.
// Usage: node --conditions=react-server scripts/test-analytics.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO)_/.test(k)) delete process.env[k];
delete process.env.DO_NOT_TRACK;
delete process.env.NODE_ENV;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ts = createRequire(import.meta.url)("typescript");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) {
    const v = await check();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}

// Modules that would start something when loaded or called are stand-ins: each export does nothing.
const STAND_INS = new Set(["keychain", "cloud-tunnel", "relay", "mac", "desktop", "mirror"]);
const project = pathToFileURL(root).href + "/";
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
    if (!url.startsWith(project) || url.includes("/node_modules/") || !/\.tsx?$/.test(url)) return next(url, context);
    // Bops Cloud's database: the fake below.
    if (url.endsWith("/cloud/db.ts")) return { format: "module", shortCircuit: true, source: "export const query = (...a) => globalThis.__cloudQuery(...a);" };
    // The Mac app's state in Bops Cloud: a file store here, so the state is ready without a cloud.
    if (url.endsWith("/lib/server/persist-cloud.ts"))
      return { format: "module", shortCircuit: true, source: `export { fileStore as cloudStore } from ${JSON.stringify(project + "lib/server/persist.ts")};` };
    const file = fileURLToPath(url);
    const source = readFileSync(file, "utf8");
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (name && STAND_INS.has(name)) {
      const names = [...source.matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
      return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
    }
    const { outputText } = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});
const scratch = mkdtempSync(join(tmpdir(), "bops-test-analytics-"));
process.chdir(scratch);

/* ---------------- PostHog, faked at fetch ---------------- */

const BATCH = "https://us.i.posthog.com/batch/";
const sent = [];
const strays = [];
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  if (req.url !== BATCH) {
    strays.push(req.url);
    throw new TypeError(`fetch failed (the test is offline: ${req.url})`);
  }
  let raw = Buffer.from(await req.arrayBuffer());
  if (req.headers.get("content-encoding") === "gzip") raw = gunzipSync(raw);
  const body = JSON.parse(raw.toString("utf8"));
  for (const e of body.batch) sent.push({ api_key: body.api_key, ...e });
  return Response.json({ status: 1 });
};
const ofEvent = (event, from = 0) => sent.slice(from).filter((e) => e.event === event);
/** Nothing new goes out: what's queued is flushed, and the count stays. */
async function nothingSent(from, flush, what) {
  await flush?.();
  await sleep(60);
  assert.deepEqual(
    sent.slice(from).map((e) => e.event),
    [],
    what,
  );
}

const R = await import(`${root}/cloud/analytics-rules.ts`);
const sameProject = (v) => v === R.POSTHOG_PROJECT;

/* ---------------- 1. The rules ---------------- */

const FUNNEL = ["signup_completed", "login_completed", "product_activated", "agent_setup_succeeded", "first_computer_created"];
const PERSONAL = /email|name|phone|text|title|goal|url|query|message|address|file|token|key/;
const SUPER_KEYS = ["app", "source", "platform", "environment", "app_version", "plan"];
for (const [event, spec] of Object.entries(R.EVENTS)) {
  assert.ok(event === "$exception" || event.startsWith("bops_"), `${event} is Bops'`);
  assert.ok(!FUNNEL.includes(event), `${event} isn't an orgo-web funnel event`);
  assert.ok(["app", "mac_server", "cloud", "any"].includes(spec.by), `${event}'s sender`);
  for (const prop of Object.keys(spec.props)) {
    assert.ok(prop === "route_path" || !PERSONAL.test(prop), `${event}.${prop} names nothing personal`);
    assert.ok(!SUPER_KEYS.includes(prop), `${event}.${prop} doesn't collide with a property on every event`);
  }
}
assert.ok(R.POSTHOG_PROJECT.startsWith("phc_") && R.POSTHOG_PROJECT.length > 20, "the project key is a PostHog project key");
assert.equal(R.POSTHOG_HOST, "https://us.i.posthog.com");
// The same project as bops.bot (and so orgo-web's): compared, never printed.
assert.ok(readFileSync(join(root, "site/index.html"), "utf8").includes(`posthog.init('${R.POSTHOG_PROJECT}'`), "the site uses the same project");

const clean = R.cleanProperties;
assert.equal(clean("bops_nope", {}, "mac_server"), null, "an unknown event");
assert.equal(clean("bops_bot_created", { own_computer: true }, "app"), null, "the wrong sender");
assert.equal(clean("bops_app_opened", {}, "mac_server"), null, "the window's event from the server");
assert.equal(clean("$pageview", {}, "app"), null);
assert.equal(clean("$identify", {}, "mac_server"), null, "only the window identifies");
assert.equal(clean("toString", {}, "app"), null, "nothing from the prototype");
assert.deepEqual(clean("bops_bot_created", { own_computer: true, workspace_bots: 3, name: "Boppy", extra: 1 }, "mac_server"), { own_computer: true, workspace_bots: 3 }, "undeclared props go");
for (const [event, props] of [
  ["bops_task_started", { task_id: "boppy" }],
  ["bops_message_sent", { via: "fax" }],
  ["bops_credit_topup_started", { amount_cents: -5 }],
  ["bops_credit_topup_started", { amount_cents: 2.5 }],
  ["bops_task_finished", { duration_ms: 31 * 86_400_000 }],
  ["bops_setup_finished", { skipped: ["relay", "bogus"] }],
  ["bops_app_connected", { toolkit: "Has Spaces" }],
  ["bops_signed_in", { switched_user: "yes" }],
])
  assert.deepEqual(clean(event, props, "mac_server"), {}, `${event} ${JSON.stringify(props)} doesn't fit`);
assert.deepEqual(clean("bops_task_started", { task_id: "ses_mg9abc12x7k1" }, "mac_server"), { task_id: "ses_mg9abc12x7k1" });
const posthogOwn = {
  $current_url: "http://localhost:3210/?chat=bot:ada",
  $host: "localhost:3210",
  $pathname: "/",
  $referrer: "https://x.test",
  $referring_domain: "x.test",
  $session_entry_url: "http://localhost:3210/",
  $session_entry_host: "localhost",
  $elements_chain: "button:text=Ada",
  $heatmap_data: {},
  $initial_person_info: { u: "http://x" },
  $title: "Ada's chat",
  $search_engine: "google",
  $prev_pageview_last_content: 3,
  $some_future_prop: "page words",
  $lib: "web",
  $lib_version: "1.231.0",
  $session_id: "s1",
  $window_id: "w1",
  token: "phc_x",
  distinct_id: "u-1",
  app: "bops",
  source: "app",
  platform: "mac",
  environment: "production",
  app_version: "0.0.22",
  plan: "pro_bops",
};
assert.deepEqual(
  clean("bops_app_opened", { ...posthogOwn, $set_once: { $initial_person_info: { u: "x" }, $initial_current_url: "x", bops_app_version: "0.0.22" }, $set: { email: "ada@x.co", bops_plan: "max_bops", is_internal: "yes" } }, "app"),
  {
    $lib: "web",
    $lib_version: "1.231.0",
    $session_id: "s1",
    $window_id: "w1",
    token: "phc_x",
    distinct_id: "u-1",
    app: "bops",
    source: "app",
    platform: "mac",
    environment: "production",
    app_version: "0.0.22",
    plan: "pro_bops",
    $set_once: { bops_app_version: "0.0.22" },
    $set: { bops_plan: "max_bops" },
  },
  "posthog-js's own $ props only from the allowlist (no addresses, page content or new ones); person props only Bops'",
);
assert.deepEqual(clean("bops_app_opened", { app: "orgo", environment: "prod", plan: "free" }, "app"), {}, "super props that don't fit go");
// The window's events as posthog-js hands them to before_send.
const W = R.cleanWindowEvent;
for (const event of ["$pageview", "$pageleave", "$autocapture", "$snapshot", "$rageclick", "$dead_click", "$web_vitals", "bops_bot_created"])
  assert.equal(W({ event, properties: {} }), null, `${event} never leaves the window`);
assert.deepEqual(W({ event: "$identify", properties: { distinct_id: "u-1", $anon_distinct_id: "anon" }, $set: { is_internal: true, email: "ada@orgo.ai", name: "Ada" }, $set_once: { $initial_current_url: "x" } }), {
  event: "$identify",
  properties: { distinct_id: "u-1", $anon_distinct_id: "anon" },
  $set: { is_internal: true },
});
assert.equal(W(null), null);

// redact: nothing personal survives, and it's short.
const SAMPLE =
  'Call +1 (415) 555-0100 or ada@x.co about "Q3 plan" at https://docs.x.co/a?b=1 from /Users/ada/Library/x.json via 100.64.0.7 with sk_demo_abcdef123456 and ' +
  "a".repeat(40) +
  " " +
  "x".repeat(300);
const red = R.redact(SAMPLE);
for (const bit of ["415", "555-0100", "ada@x.co", "Q3 plan", "https://", "docs.x.co", "/Users/ada", "100.64.0.7", "sk_demo", "abcdef123456", "a".repeat(40)]) assert.ok(!red.includes(bit), `redact leaves no ${bit}: ${red}`);
assert.ok(red.length <= 200);
assert.ok(R.redact("Cannot read properties of undefined (reading 'x')").startsWith("Cannot read properties of undefined"), "words stay");

// quietFetch: a send PostHog can't take is dropped quietly, one warning per 10 minutes.
{
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  for (let i = 0; i < 3; i++) assert.equal((await R.quietFetch("https://us.i.posthog.com/batch/", { method: "POST" })).status, 200);
  globalThis.fetch = async () => new Response("blocked", { status: 403 });
  assert.equal((await R.quietFetch("https://us.i.posthog.com/batch/", { method: "POST" })).status, 200);
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  assert.equal(warned.length, 1, "one line, not one per event");
  assert.ok(!warned[0].includes("at "), "no stack");
}

// Exceptions, as posthog-js and posthog-node build them.
const jsShape = clean(
  "$exception",
  {
    $exception_list: [
      {
        type: "TypeError",
        value: "Failed for ada@x.co at https://x.test/p",
        mechanism: { handled: false, synthetic: false, type: "onerror", source: "x" },
        stacktrace: { type: "raw", frames: [{ platform: "web:javascript", filename: "http://localhost:3210/_next/static/chunks/a.js", function: "send", lineno: 1, colno: 2, in_app: true, vars: { a: 1 } }] },
      },
    ],
    $exception_level: "error",
    $exception_message: "Failed for ada@x.co",
    $exception_type: "TypeError",
    $exception_personURL: "https://us.posthog.com/person/u-1",
    $exception_stack_trace_raw: "at send (http://localhost:3210/a.js)",
    surface: "window",
  },
  "app",
);
assert.deepEqual(Object.keys(jsShape).sort(), ["$exception_level", "$exception_list", "surface"]);
assert.equal(jsShape.$exception_list[0].value, "", "never the error's message");
assert.deepEqual(jsShape.$exception_list[0].stacktrace.frames[0], { platform: "web:javascript", filename: "http://localhost:3210/_next/static/chunks/a.js", function: "send", lineno: 1, colno: 2, in_app: true });
assert.deepEqual(jsShape.$exception_list[0].mechanism, { type: "onerror", handled: false, synthetic: false });
const nodeShape = clean(
  "$exception",
  {
    $exception_list: [
      {
        type: "Error",
        value: "boom",
        stacktrace: {
          type: "raw",
          frames: Array.from({ length: 70 }, (_, i) => ({
            filename: "/Users/ada/Applications/Bops.app/server/x.js",
            abs_path: "/Users/ada/Applications/Bops.app/server/x.js",
            function: "f".repeat(200),
            lineno: i,
            colno: 1,
            in_app: true,
            context_line: "const secret = 'ada@x.co'",
            pre_context: ["a"],
            post_context: ["b"],
            platform: "node:javascript",
          })),
        },
      },
    ],
    route_path: "/app/api/bots/route",
    surface: "mac_server",
  },
  "mac_server",
);
const frames = nodeShape.$exception_list[0].stacktrace.frames;
assert.equal(frames.length, 60, "the last 60 frames");
assert.equal(frames[0].lineno, 10);
for (const f of frames) {
  assert.equal(f.context_line, undefined);
  assert.equal(f.pre_context, undefined);
  assert.equal(f.post_context, undefined);
  assert.equal(f.abs_path, "/Users/<user>/Applications/Bops.app/server/x.js");
  assert.equal(f.function.length, 120);
}
assert.equal(nodeShape.route_path, "/app/api/bots/route");
assert.equal(clean("bops_bot_created", { $exception_list: [{}] }, "mac_server").$exception_list, undefined, "an exception list only on $exception");
console.log("ok - the rules");

/* ---------------- 2. The window (lib/analytics.ts) ---------------- */

const listeners = {};
globalThis.window = { addEventListener: (type, fn) => (listeners[type] ??= []).push(fn) };
const storage = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
});
const A = await import(`${root}/lib/analytics.ts`);
const ph = { calls: [], config: null, distinct: "anon", userState: "anonymous" };
const fake = {
  init: (token, config) => {
    ph.tokenOk = sameProject(token);
    ph.config = config;
    ph.calls.push(["init"]);
  },
  register: (p) => ph.calls.push(["register", p]),
  unregister: (k) => ph.calls.push(["unregister", k]),
  get_distinct_id: () => ph.distinct,
  get_property: (k) => (k === "$user_state" ? ph.userState : undefined),
  identify: (id, set) => {
    ph.distinct = id;
    ph.userState = "identified";
    ph.calls.push(["identify", id, set]);
  },
  capture: (e, p, o) => ph.calls.push(["capture", e, p, o]),
  captureException: (e, p) => ph.calls.push(["captureException", e, p]),
  reset: () => {
    ph.distinct = "anon";
    ph.userState = "anonymous";
    ph.calls.push(["reset"]);
  },
};
let loads = 0;
const load = async () => {
  loads++;
  return fake;
};
const info = (over = {}) => ({ on: true, share: true, locked: false, userId: "u-1", internal: true, environment: "production", appVersion: "0.0.22", plan: "pro_bops", ...over });
const names = () => ph.calls.map((c) => (c[0] === "capture" ? `capture:${c[1]}` : c[0]));

await A.startAnalytics(info({ on: false }), load);
assert.equal(loads, 0, "off: posthog-js never loads");
await A.startAnalytics(info({ userId: null }), load);
assert.equal(loads, 0, "nobody signed in: never loads");

storage.set("bops.analytics.version", "0.0.21");
await A.startAnalytics(info(), load);
assert.equal(loads, 1);
assert.ok(ph.tokenOk, "init with Orgo's project");
const { before_send, ...config } = ph.config;
assert.deepEqual(config, { ...A.WINDOW_CONFIG }, "orgo-web's init with recording, autocapture and remote config off");
assert.equal(typeof before_send, "function");
for (const k of ["autocapture", "capture_pageview", "capture_pageleave", "capture_exceptions", "enable_recording_console_log", "capture_heatmaps", "capture_dead_clicks", "capture_performance"]) assert.equal(config[k], false, k);
for (const k of ["disable_session_recording", "disable_surveys", "disable_external_dependency_loading", "advanced_disable_decide"]) assert.equal(config[k], true, k);
assert.deepEqual(names(), ["init", "register", "identify", "capture:bops_app_opened", "capture:bops_app_updated"]);
assert.deepEqual(ph.calls[1], ["register", { app: "bops", platform: "mac", source: "app", environment: "production", app_version: "0.0.22", plan: "pro_bops" }]);
assert.deepEqual(ph.calls[2], ["identify", "u-1", { is_internal: true }], "identified by the Orgo user id, never an email or name");
assert.deepEqual(ph.calls[3], ["capture", "bops_app_opened", {}, { $set: { bops_app_version: "0.0.22" } }]);
assert.deepEqual(ph.calls[4], ["capture", "bops_app_updated", { from_version: "0.0.21" }, undefined]);
assert.equal(storage.get("bops.analytics.version"), "0.0.22");
// What posthog-js would send goes through the rules while on.
assert.deepEqual(before_send({ event: "bops_upgrade_clicked", properties: { surface: "chat", $current_url: "http://localhost:3210/" } }), { event: "bops_upgrade_clicked", properties: { surface: "chat" } });

ph.calls.length = 0;
await A.startAnalytics(info(), load);
assert.deepEqual(names(), ["register"], "the same user again: no second identify or app_opened");
A.trackEvent("bops_upgrade_clicked", { surface: "bot_panel" });
assert.deepEqual(ph.calls.at(-1), ["capture", "bops_upgrade_clicked", { surface: "bot_panel" }, undefined]);

// An error in the window, only while on.
const boom = new Error("boom");
listeners.error.forEach((fn) => fn({ error: boom, message: "boom" }));
listeners.unhandledrejection.forEach((fn) => fn({ reason: boom }));
assert.deepEqual(ph.calls.slice(-2), [
  ["captureException", boom, { surface: "window" }],
  ["captureException", boom, { surface: "window" }],
]);

ph.calls.length = 0;
A.stopAnalytics();
assert.deepEqual(names(), ["reset"], "signed out or switched off: reset once");
A.trackEvent("bops_upgrade_clicked", { surface: "chat" });
listeners.error.forEach((fn) => fn({ error: boom }));
A.stopAnalytics();
assert.deepEqual(names(), ["reset"], "then nothing at all");
assert.equal(before_send({ event: "bops_upgrade_clicked", properties: { surface: "chat" } }), null, "before_send lets nothing out while off");

ph.calls.length = 0;
await A.startAnalytics(info(), load);
await A.startAnalytics(info({ userId: "u-2", internal: false }), load);
assert.deepEqual(names(), ["register", "identify", "reset", "register", "identify", "capture:bops_app_opened"]);
assert.deepEqual(ph.calls[4], ["identify", "u-2", undefined], "another user: reset, then identify with no props");
assert.equal(loads, 1, "posthog-js loads once");
A.stopAnalytics();

// No plan known (yet): the one registered before doesn't stay.
ph.calls.length = 0;
await A.startAnalytics(info({ plan: null }), load);
assert.ok(ph.calls.some((c) => c[0] === "unregister" && c[1] === "plan"), "plan unregistered when not known");
A.stopAnalytics();

// A new window load (a fresh module, posthog-js not loaded yet).
delete globalThis.bopsAnalytics;
const A2 = await import(`${root}/lib/analytics.ts?second-window`);
// Switched off or signed out while posthog-js was still loading: that stop stands.
let release;
const slowLoad = () => new Promise((r) => (release = () => r(fake)));
ph.calls.length = 0;
const pending = A2.startAnalytics(info(), slowLoad);
await sleep(5);
A2.stopAnalytics();
release();
await pending;
assert.deepEqual(names(), ["init"], "a stop during the load: no identify, no app_opened");
assert.equal(ph.config.before_send({ event: "bops_upgrade_clicked", properties: { surface: "chat" } }), null, "and nothing leaves");
A2.trackEvent("bops_upgrade_clicked", { surface: "chat" });
assert.deepEqual(names(), ["init"]);
// posthog-js still holds someone else, identified before this load: reset before identifying.
ph.distinct = "u-old";
ph.userState = "identified";
ph.calls.length = 0;
await A2.startAnalytics(info(), slowLoad);
assert.deepEqual(names().slice(0, 3), ["reset", "register", "identify"], "someone else from before: reset first");
A2.stopAnalytics();
delete globalThis.bopsAnalytics;
delete globalThis.window;
delete globalThis.localStorage;
console.log("ok - the window");

/* ---------------- 3. The Mac's server (lib/server/analytics.ts) ---------------- */

process.env.NODE_ENV = "production";
process.env.BOPS_APP_VERSION = "0.0.22";
globalThis.bopsOrgoKey = "sk_test_one";
const SESSION = { userId: "u-1", publicUrl: "https://bops.orgo.ai/api", agentmail: null, agentphone: null, honcho: null, composio: null, openai: null, typesafe: false, verify: { sms: false, email: false }, slack: null, plan: { tier: "pro_bops", limits: false } };
globalThis.bopsCloud = { session: { key: "sk_test_one", value: SESSION } };
const S = await import(`${root}/lib/server/store.ts`);
const M = await import(`${root}/lib/server/analytics.ts`);
const V = await import(`${root}/lib/server/app-version.ts`);
const ROUTE = await import(`${root}/app/api/analytics/route.ts`);
const SETUP = await import(`${root}/app/api/setup/route.ts`);
const flushMac = () => M.flushAnalytics();

let mark = sent.length;
M.trackServerEvent("bops_bot_created", { own_computer: false, workspace_bots: 2 });
await nothingSent(mark, flushMac, "signed out: nothing");

S.update((s) => (s.account = { user: { id: "u-1", email: "ada@orgo.ai" }, signedInAt: 1 }));
mark = sent.length;
M.trackServerEvent("bops_bot_created", { own_computer: false, workspace_bots: 2, name: "Boppy" });
const [bot] = await until(() => ofEvent("bops_bot_created", mark).length && ofEvent("bops_bot_created", mark), "bops_bot_created");
assert.ok(sameProject(bot.api_key), "sent with Orgo's project");
assert.equal(bot.distinct_id, "u-1");
assert.equal(bot.properties.$geoip_disable, true, "server events never move the person's location");
const plainProps = Object.fromEntries(Object.entries(bot.properties).filter(([k]) => !k.startsWith("$")));
assert.deepEqual(plainProps, { own_computer: false, workspace_bots: 2, app: "bops", platform: "mac", source: "mac_server", environment: "production", app_version: "0.0.22", plan: "pro_bops" }, "a stray prop is dropped on the wire");
assert.ok(!JSON.stringify(bot).includes("ada@orgo.ai"), "never the email");

// once: orgo-web's milestoneUuid.
const expectUuid = (event, user, entity) => {
  const hex = createHash("sha256").update(JSON.stringify([event, user, entity])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
assert.equal(M.milestoneUuid("x", "u", "e"), expectUuid("x", "u", "e"));
mark = sent.length;
M.trackServerEvent("bops_credit_topup_started", { amount_cents: 2000, method: "saved_card" }, { once: "idem-1" });
const [top] = await until(() => ofEvent("bops_credit_topup_started", mark).length && ofEvent("bops_credit_topup_started", mark), "top-up");
assert.equal(top.uuid, expectUuid("bops_credit_topup_started", "u-1", "idem-1"));

// Who may send.
const quiet = async (what, set, undo) => {
  set();
  const from = sent.length;
  M.trackServerEvent("bops_routine_created", {});
  await nothingSent(from, flushMac, what);
  undo();
};
const withEnv = (k, v) => [() => (process.env[k] = v), () => (k === "NODE_ENV" ? (process.env.NODE_ENV = "production") : delete process.env[k])];
await quiet("the user's switch off", () => S.update((s) => (s.analyticsOff = true)), () => S.update((s) => delete s.analyticsOff));
await quiet("BOPS_TELEMETRY=0", ...withEnv("BOPS_TELEMETRY", "0"));
await quiet("DO_NOT_TRACK=1", ...withEnv("DO_NOT_TRACK", "1"));
await quiet("a development build", ...withEnv("NODE_ENV", "development"));
await quiet("self-hosted", ...withEnv("BOPS_SELF_HOSTED", "1"));
await quiet("a hosted server", ...withEnv("BOPS_DATABASE_URL", "postgres://x"));
mark = sent.length;
M.trackServerEvent("bops_routine_created", {}, { userId: "u-other" });
await nothingSent(mark, flushMac, "work for another user: nothing");

process.env.NODE_ENV = "development";
process.env.BOPS_TELEMETRY = "1";
mark = sent.length;
M.trackServerEvent("bops_routine_created", {});
const [dev] = await until(() => ofEvent("bops_routine_created", mark).length && ofEvent("bops_routine_created", mark), "a development event");
assert.equal(dev.properties.environment, "development");
process.env.NODE_ENV = "production";
delete process.env.BOPS_TELEMETRY;
process.env.BOPS_CLOUD_URL = "https://staging.bops.test/api";
assert.equal(M.telemetryEnvironment(), "staging");
process.env.BOPS_CLOUD_URL = "http://127.0.0.1:8790";
assert.equal(M.telemetryEnvironment(), "development");
delete process.env.BOPS_CLOUD_URL;
assert.equal(M.telemetryEnvironment(), "production");

// The header that tells Bops Cloud to send nothing for this Mac.
assert.deepEqual(V.appHeaders(), { "x-bops-version": "0.0.22" });
process.env.DO_NOT_TRACK = "1";
assert.deepEqual(V.appHeaders(), { "x-bops-version": "0.0.22", "x-bops-telemetry": "off" });
delete process.env.DO_NOT_TRACK;
process.env.NODE_ENV = "test";
assert.equal(V.telemetryHere(), false);
assert.equal(V.appHeaders()["x-bops-telemetry"], "off");
process.env.NODE_ENV = "production";

// An error in the Mac's server, scrubbed.
mark = sent.length;
M.captureServerException(new Error('Could not reach ada@x.co at https://x.test/a about "Q3 plan"'), "/api/bots/[botId]");
const [ex] = await until(() => ofEvent("$exception", mark).length && ofEvent("$exception", mark), "$exception");
assert.equal(ex.distinct_id, "u-1");
assert.equal(ex.properties.surface, "mac_server");
assert.equal(ex.properties.route_path, "/api/bots/[botId]");
assert.equal(ex.properties.$exception_list[0].value, "", "never the error's message");
assert.equal(ex.properties.$exception_list[0].type, "Error");
assert.ok(!JSON.stringify(ex).includes("ada@x.co") && !JSON.stringify(ex).includes("Q3 plan"));
for (const f of ex.properties.$exception_list[0].stacktrace?.frames ?? []) assert.equal(f.context_line, undefined, "no source lines");
assert.ok(globalThis.__bopsExitWork.has("posthog"), "queued events go out before the app quits");

// GET and POST /api/analytics.
const get = async () => (await ROUTE.GET()).json();
assert.deepEqual(await get(), { on: true, share: true, locked: false, userId: "u-1", internal: true, environment: "production", appVersion: "0.0.22", plan: "pro_bops" });
const postShare = (body) => ROUTE.POST(new Request("http://localhost/api/analytics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
let res = await postShare({ share: false });
assert.equal(res.status, 200);
assert.equal(S.getState().analyticsOff, true);
assert.equal((await res.json()).on, false);
assert.equal((await get()).share, false);
res = await postShare({ share: true });
assert.equal(S.getState().analyticsOff, undefined);
assert.equal((await res.json()).on, true);
res = await postShare({ share: "no" });
assert.equal(res.status, 400);
assert.equal((await res.json()).error, "share must be true or false");
process.env.DO_NOT_TRACK = "1";
const locked = await get();
assert.equal(locked.locked, true);
assert.equal(locked.on, false);
assert.equal(locked.share, true);
delete process.env.DO_NOT_TRACK;

// Setup: only the setup screen's items go out.
mark = sent.length;
await SETUP.POST(new Request("http://localhost/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skipped: ["relay", "bogus"] }) }));
const [setup] = await until(() => ofEvent("bops_setup_finished", mark).length && ofEvent("bops_setup_finished", mark), "bops_setup_finished");
assert.deepEqual(setup.properties.skipped, ["relay"]);

// Starting over keeps the switch.
assert.match(readFileSync(join(root, "lib/server/store.ts"), "utf8"), /const \{ host, account, usage, relay, macs, analyticsOff \} = box\.state;[\s\S]{0,200}migrate\(\{ host, account, usage, relay, macs, analyticsOff,/);

// Signed out: the switch can't be set.
S.update((s) => (s.account = undefined));
res = await postShare({ share: false });
assert.equal(res.status, 401);
assert.equal((await get()).userId, null);
await M.flushAnalytics();
console.log("ok - the Mac's server");

/* ---------------- 4. Bops Cloud (cloud/analytics.ts) ---------------- */

process.env.BOPS_CLOUD_PUBLIC_URL = "https://bops.orgo.ai/api";
const db = { off: {}, asked: 0 };
globalThis.__cloudQuery = async (text, values) => {
  assert.match(text, /FROM bops\.app_state WHERE user_id = \$1/);
  db.asked++;
  return { rows: values[0] in db.off ? [{ off: db.off[values[0]] }] : [] };
};
const C = await import(`${root}/cloud/analytics.ts`);
const flushCloud = () => C.flushTelemetry();
const req = (headers = {}) => ({ headers });

mark = sent.length;
C.trackCloudEvent("u-9", "bops_signup_completed", {}, { once: "u-9", setOnce: { bops_plan: "free_bops" } });
await nothingSent(mark, flushCloud, "BOPS_TELEMETRY unset: nothing");
assert.equal(C.flushTelemetry(), undefined, "and no client is made");
assert.equal(db.asked, 0);

process.env.BOPS_TELEMETRY = "1";
mark = sent.length;
C.trackCloudEvent("u-9", "bops_signup_completed", {}, { once: "u-9", setOnce: { bops_plan: "free_bops" } });
const [signup] = await until(() => ofEvent("bops_signup_completed", mark).length && ofEvent("bops_signup_completed", mark), "bops_signup_completed");
assert.ok(sameProject(signup.api_key));
assert.equal(signup.distinct_id, "u-9");
assert.equal(signup.uuid, expectUuid("bops_signup_completed", "u-9", "u-9"));
assert.equal(signup.properties.source, "cloud");
assert.equal(signup.properties.app, "bops");
assert.equal(signup.properties.environment, "production");
assert.deepEqual(signup.properties.$set_once, { bops_plan: "free_bops" });

mark = sent.length;
await C.inTelemetryScope(req({ "x-bops-telemetry": "off", "x-bops-version": "0.0.22" }), async () => {
  await sleep(1);
  C.trackCloudEvent("u-9", "bops_ai_credit_ran_out", {});
});
await nothingSent(mark, flushCloud, "a call marked off: nothing for what it does");

mark = sent.length;
await C.inTelemetryScope(req({ "x-bops-version": "0.0.22" }), async () => C.trackCloudEvent("u-9", "bops_ai_credit_ran_out", {}));
const [ran] = await until(() => ofEvent("bops_ai_credit_ran_out", mark).length && ofEvent("bops_ai_credit_ran_out", mark), "bops_ai_credit_ran_out");
assert.equal(ran.properties.app_version, "0.0.22", "the calling app's version");

// Bops for iPhone collects no usage data: nothing for what its calls do, whatever else they say.
mark = sent.length;
await C.inTelemetryScope(req({ "x-bops-client": "ios", "x-bops-version": "0.2.0" }), async () => {
  await sleep(1);
  C.trackCloudEvent("u-9", "bops_ai_credit_ran_out", {});
});
await nothingSent(mark, flushCloud, "a call from Bops for iPhone: nothing for what it does");

db.off["u-8"] = "true";
mark = sent.length;
C.trackCloudEvent("u-8", "bops_owner_contact_verified", { channel: "sms" });
await nothingSent(mark, flushCloud, "the user's switch off: nothing");
delete db.off["u-8"];
C.trackCloudEvent("u-8", "bops_owner_contact_verified", { channel: "sms" });
await nothingSent(mark, flushCloud, "the choice is kept for a while");
C.forgetTelemetryChoice("u-8");
C.trackCloudEvent("u-8", "bops_owner_contact_verified", { channel: "sms" });
await until(() => ofEvent("bops_owner_contact_verified", mark).length, "after a state upload, read again");

// An unexpected 500, scrubbed, unless the call or the user said off.
mark = sent.length;
C.captureCloudException(new Error("pg said no for ada@x.co"), req(), "u-9", "/v1/session");
const [cex] = await until(() => ofEvent("$exception", mark).length && ofEvent("$exception", mark), "the cloud's $exception");
assert.equal(cex.properties.surface, "cloud");
assert.equal(cex.properties.route_path, "/v1/session");
assert.equal(cex.properties.$exception_list[0].value, "", "never the error's message");
mark = sent.length;
C.captureCloudException(new Error("Jarvis couldn't reach ada-macbook.tail1.ts.net"), req(), null, "/v1/hooks/sms");
await nothingSent(mark, flushCloud, "a 500 on a public route (no user, no switch): nothing");
mark = sent.length;
C.captureCloudException(new Error("x"), req({ "x-bops-telemetry": "off" }), "u-9", "/v1/session");
await nothingSent(mark, flushCloud, "a 500 on a call marked off: nothing");
mark = sent.length;
C.captureCloudException(new Error("x"), req({ "x-bops-client": "ios" }), "u-9", "/v1/agent/messages");
await nothingSent(mark, flushCloud, "a 500 on a call from Bops for iPhone: nothing");

assert.equal(C.cloudEnvironment(), "production");
process.env.BOPS_CLOUD_PUBLIC_URL = "https://bops-staging.orgo.ai/api";
assert.equal(C.cloudEnvironment(), "staging");
delete process.env.BOPS_CLOUD_PUBLIC_URL;
assert.equal(C.cloudEnvironment(), "development");
await C.shutdownTelemetry();
console.log("ok - Bops Cloud");

/* ---------------- 5. The catalog matches the code ---------------- */

const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f === "test" || f.startsWith(".")) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(f)) files.push(p);
  }
};
for (const d of ["app", "components", "lib", "cloud"]) walk(join(root, d));
files.push(join(root, "instrumentation.ts"));
const used = new Map();
const SENDERS = { trackEvent: "app", trackServerEvent: "mac_server", trackCloudEvent: "cloud" };
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/\b(trackEvent|trackServerEvent)\(\s*"([^"]+)"/g)) used.set(m[2], [...(used.get(m[2]) ?? []), [SENDERS[m[1]], f]]);
  for (const m of src.matchAll(/\btrackCloudEvent\(\s*[^,()]+(?:\([^)]*\))?,\s*"([^"]+)"/g)) used.set(m[1], [...(used.get(m[1]) ?? []), ["cloud", f]]);
  if (/from "posthog-(js|node)|import\("posthog-js/.test(src))
    assert.ok(["lib/analytics.ts", "lib/server/analytics.ts", "cloud/analytics.ts"].includes(f.slice(root.length + 1)), `${f} doesn't import PostHog itself`);
}
for (const [event, uses] of used) {
  assert.ok(Object.hasOwn(R.EVENTS, event), `${event} is in the catalog`);
  for (const [by, f] of uses) assert.equal(R.EVENTS[event].by, by, `${event} is sent by its own sender (${f})`);
}
for (const event of Object.keys(R.EVENTS)) if (event !== "$exception") assert.ok(used.has(event), `${event} is sent somewhere`);
console.log("ok - the catalog matches the code");

for (const u of strays) assert.ok(!u.includes("posthog"), `nothing else of PostHog's was called: ${u}`);
process.chdir(tmpdir());
rmSync(scratch, { recursive: true, force: true });
console.log("all passed");
process.exit(0);
