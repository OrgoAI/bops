// Tests for apps' work across a sign-in (lib/server/hosted-apps.ts, lib/server/ingot.ts): work on an app an
// @orgo.ai account began (a task's set-up on its computer, a deploy, a DNS change, Add app, a domain bought, a
// variable or a port changed, a rollback) stops once another account
// signs in on this Mac meanwhile (store.ts sameState): none of it goes on with that account's Orgo key, to its
// Ingot workspace or its Orgo project, or into its state, whoever they are. Without a sign-in it goes on as before.
//
// orgo-web and the central Ingot are a fake fetch on made-up origins, the Keychain a fake `security`, and the
// state lives in a throwaway folder: nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-hosted-apps-swap.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG|INGOT)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-hosted-apps-swap";
process.env.BOPS_RESPONSES_WS = "0";
process.env.BOPS_UI_TOKEN = "ui-token-test";
const ORGO = "http://orgo.test";
const INGOT = "http://ingot.test";
process.env.BOPS_ORGO_ORIGIN = ORGO;
process.env.BOPS_INGOT_URL = INGOT;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-hosted-apps-swap-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
// The Keychain: a write (security -i) takes, a read finds nothing.
writeFileSync(join(bin, "security"), '#!/bin/sh\nif [ "$1" = "-i" ]; then cat >/dev/null; exit 0; fi\nexit 44\n', { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);
const vendor = join(scratch, "vendor-ingot");
mkdirSync(vendor);
process.env.BOPS_INGOT_DIR = vendor;
const BINARY = randomBytes(1024);
writeFileSync(join(vendor, "ingot-linux-amd64"), BINARY);

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
    return {
      format: "module",
      shortCircuit: true,
      source: names.map((n) => (n === "startSession" ? "export const startSession = (...a) => globalThis.__startSession(...a);" : `export const ${n} = function () { return Promise.resolve(); };`)).join("\n"),
    };
  },
});
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (w, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(w, ...rest));
const logged = [];
for (const k of ["info", "warn"]) console[k] = (...a) => logged.push(a.map(String).join(" "));
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(String(e?.stack ?? e)));

const sha = (b) => createHash("sha256").update(b).digest("hex");
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/* ---------------- Two accounts, and a fake orgo-web and Ingot ---------------- */

const KEY_A = "sk_orgo_test_alex";
const KEY_B = "sk_orgo_test_bob";
const PA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ZONE = "cccccccc-3333-4333-8333-cccccccccccc";
const ZONE2 = "dddddddd-4444-4444-8444-dddddddddddd";
const TOKEN_SUM = sha("ingot_test_token\n");
/** The newest commit of Alex's app todo in Ingot, newer than the one its task started from. */
const TODO_HEAD = "d".repeat(64);
const alex = { id: "u_alex", email: "alex@orgo.ai", name: "Alex" };
const bob = { id: "u_bob", email: "bob@example.com", name: "Bob" };
const who = (auth) => (auth === `Bearer ${KEY_A}` ? "alex" : auth === `Bearer ${KEY_B}` ? "bob" : String(auth));

/** Every call either got, by whose key; and what's done as a call comes in (the other account signing in, say). */
const calls = [];
const on = new Map();
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const as = who(req.headers.get("authorization"));
  const text = await req.text();
  const body = text ? JSON.parse(text) : undefined;
  const what = `${req.method} ${url.pathname}${body?.command ? ` ${body.command.split("\n")[0]}` : ""}`;
  calls.push({ as, what, host: url.host });
  for (const [match, fn] of on)
    if (what.includes(match)) {
      on.delete(match);
      await fn();
    }
  if (url.origin === ORGO) {
    // Only Alex's key reaches Alex's computer c_a; Bob's own computer is c_b.
    if (url.pathname.startsWith("/api/computers/c_a") && as !== "alex") return json({ error: "Computer not found" }, 404);
    if (url.pathname === "/api/computers/c_a" && req.method === "GET") return json({ id: "c_a", name: "bops-alex", status: "running", workspace_id: PA });
    if (url.pathname === "/api/computers/c_a/bash") {
      const cmd = body.command.split("\n")[0];
      if (cmd === "# bops-ingot probe") return json({ output: [`INGOT_ARCH=amd64`, `INGOT_BIN=${sha(BINARY)}`, `INGOT_CONFIG=${sha(`${JSON.stringify({ url: INGOT })}\n`)}`, `INGOT_TOKEN_FILE=${TOKEN_SUM}`].join("\n"), exit_code: 0 });
      if (cmd === "# bops-ingot git") return json({ output: "INGOT_GIT=ok", exit_code: 0 });
      return json({ output: "INGOT_FOLDER=pull", exit_code: 0 });
    }
    if (url.pathname === "/api/computers/c_a/deploy-projects" && req.method === "GET") return json({ projects: [] });
    if (url.pathname === "/api/computers/c_a/deploy-projects" && req.method === "POST") return json({ id: "dp_new", name: body.name, port: body.port, source: "ingot", ingot_repo: body.repo });
    if (url.pathname === "/api/computers/c_a/deploy-projects/dp_new/deployments" && req.method === "POST") return json({ id: "dep_1", project_id: "dp_new", state: "queued", created_at: new Date().toISOString() }, 202);
    if (url.pathname === "/api/computers/c_a/deploy-projects/dp_live")
      return json({ id: "dp_live", name: "shop", port: req.method === "PATCH" ? (body.port ?? 3000) : 3000, url: "https://shop.orgo.dev", deployments: [{ id: "dep_old", project_id: "dp_live", state: "succeeded", can_rollback: true, created_at: new Date().toISOString() }] });
    if (url.pathname === "/api/computers/c_a/deploy-projects/dp_live/env" && req.method === "PATCH") return json({ env_keys: Object.keys(body.env) });
    if (url.pathname === "/api/computers/c_a/deployments/dep_old/rollback") return json({ id: "dep_back", project_id: "dp_live", state: "queued", created_at: new Date().toISOString() }, 202);
    if (url.pathname === `/api/projects/${PA}/domains` && req.method === "POST") return json({ id: ZONE2, domain: body.domain, status: "active" }, 201);
    if (url.pathname === `/api/projects/${PA}/domains` && req.method === "GET") return json({ registrar: true, can_buy: true, domains: [{ id: ZONE, domain: "acme.example", status: "active", pointed: [] }] });
    if (url.pathname === "/api/computers/c_a/domains" && req.method === "POST") return json({ id: "cd_new", domain: "guest.example", status: "pending", target_port: 3000, managed: true }, 201);
    if (/^\/api\/computers\/c_a\/domains\/cd_1/.test(url.pathname)) return json({ id: "cd_1", status: "active" });
    if (url.pathname === "/api/computers/c_a/domains")
      return json({ domains: [{ id: "cd_1", domain: "shop.acme.example", status: "active", cert_status: "issued", target_port: 3000, managed: true }], owned_domains: [{ id: ZONE, domain: "acme.example" }] });
    if (url.pathname.startsWith(`/api/projects/${PA}/domains/${ZONE}/dns`) && as === "alex") return json({ record: { id: "r1" }, records: [] });
    return json({ error: "Not found" }, 404);
  }
  if (url.origin === INGOT) {
    if (/\/tokens$/.test(url.pathname) && req.method === "GET") return json({ tokens: [{ id: 7, revoked_at: null, expires_at: null }] });
    if (/\/repos$/.test(url.pathname) && req.method === "POST") return json({ repo: { name: body?.name } }, 201);
    if (url.pathname === `/api/v1/w/${PA}/repos` && req.method === "GET") return json({ repos: [] });
    if (url.pathname === `/api/v1/w/${PA}/repos/todo` && req.method === "GET") return json({ repo: { name: "todo" }, refs: [{ name: "main", target: TODO_HEAD }] });
    return json({ error: "Not found" }, 404);
  }
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};

const S = await import(`${root}/lib/server/store.ts`);
const Auth = await import(`${root}/lib/server/orgo-auth.ts`);
const H = await import(`${root}/lib/server/hosted-apps.ts`);
const { SWAPPED } = await import(`${root}/lib/server/ingot.ts`);
const { botChatId } = await import(`${root}/lib/types.ts`);
clearInterval(globalThis.__bopsRoutines);

// Bob has used Bops on this Mac before: his own state, its main workspace on his own Orgo project, his own computer.
await Auth.signIn(KEY_B, bob);
S.update((s) => {
  s.workspaces[0].orgoProjectId = PB;
  Object.assign(s.bots.find((x) => x.isMain), { computerStatus: "ready", computerId: "c_b" });
});
const bobsBefore = () => JSON.stringify(S.getState().workspaces);
let bobs;

/** Alex (@orgo.ai) signed in: his computer c_a with Ingot set up, his app "todo" on it, a task on it, and "shop" deployed. */
async function asAlex() {
  // Each check probes the computer afresh (ingot.ts keeps one found ready a minute), with nothing left to happen.
  globalThis.bopsIngotReady?.clear();
  on.clear();
  await Auth.signIn(KEY_A, alex);
  S.update((s) => {
    s.workspaces[0].orgoProjectId = PA;
    s.workspaces[0].ingotTokens = { c_a: { id: "7", sum: TOKEN_SUM, at: Date.now() } };
    s.workspaces[0].hostedApps = { todo: { botId: "boppy", computerId: "c_a" }, shop: { botId: "boppy", computerId: "c_a", projectId: "dp_live", url: "https://shop.orgo.dev" } };
    Object.assign(s.bots.find((x) => x.id === "boppy"), { computerStatus: "ready", computerId: "c_a" });
    s.sessions = [{ id: "ses_app", botId: "boppy", chatId: botChatId("boppy"), sentVia: "you", title: "Work on todo", goal: "Work on todo", host: "orgo", status: "running", steps: [], replies: [], createdAt: Date.now(), app: { wsId: "ws_main", name: "todo" } }];
  });
}
/** Bob signs in as the call `match` comes in. */
const bobSignsInOn = (match) =>
  on.set(match, async () => {
    await Auth.signIn(KEY_B, bob);
    bobs = bobsBefore();
  });

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
const fails = (p) => p.then((x) => ({ ok: x }), (e) => ({ error: e }));
/** The calls made since `from` with Bob's key: none, whatever Alex began. */
const bobsCalls = (from) => calls.slice(from).filter((c) => c.as === "bob").map((c) => c.what);
/** Bob's workspaces after it: as they were when he signed in (no app, no token, no record of Alex's). */
function bobUntouched() {
  assert.equal(S.getState().account.user.email, bob.email, "Bob is the one signed in now");
  assert.equal(JSON.stringify(S.getState().workspaces), bobs, "nothing written into Bob's state");
  assert.ok(!/hostedApps|ingotTokens|todo|shop/.test(JSON.stringify(S.getState().workspaces)));
}

/* ---------------- A task's set-up on its computer ---------------- */

await check("a task on an app getting ready, with no sign-in meanwhile: Ingot set up, its repo made, its folder pulled, all with Alex's key", async () => {
  await asAlex();
  const from = calls.length;
  assert.equal(await H.readyAppForTask("ses_app", "c_a"), "Pulled the newest todo into /workspace/apps/todo");
  assert.deepEqual(bobsCalls(from), []);
  assert.ok(calls.slice(from).some((c) => c.what === `POST /api/v1/w/${PA}/repos`), "the repo made in Alex's workspace");
});

await check("Bob signs in while the task's computer is probed: it stops, nothing goes to Bob's Ingot or Orgo, nothing lands in his state", async () => {
  await asAlex();
  bobSignsInOn("# bops-ingot probe");
  const from = calls.length;
  const got = await fails(H.readyAppForTask("ses_app", "c_a"));
  assert.equal(on.size, 0, "Bob signed in as it was probed");
  assert.equal(got.error?.message, SWAPPED);
  assert.deepEqual(bobsCalls(from), [], "no call with Bob's key");
  assert.ok(!calls.slice(from).some((c) => c.what.includes(`/w/${PB}/`)), "nothing to Bob's Ingot workspace");
  bobUntouched();
});

await check("Bob signs in while the repo is made: its folder isn't readied, and nothing more goes", async () => {
  await asAlex();
  bobSignsInOn(`POST /api/v1/w/${PA}/repos`);
  const from = calls.length;
  const got = await fails(H.readyAppForTask("ses_app", "c_a"));
  assert.equal(on.size, 0, "Bob signed in as it was made");
  assert.equal(got.error?.message, SWAPPED);
  assert.deepEqual(bobsCalls(from), []);
  assert.ok(!calls.slice(from).some((c) => c.what.includes("bops-ingot folder")), "no folder readied");
  bobUntouched();
});

/* ---------------- A deploy ---------------- */

await check("a first deploy, with no sign-in meanwhile: its project made on Alex's computer", async () => {
  await asAlex();
  const from = calls.length;
  const got = await fails(H.deployApp("ws_main", "todo"));
  assert.ok(calls.slice(from).some((c) => c.as === "alex" && c.what === "POST /api/computers/c_a/deploy-projects"), JSON.stringify(got.error?.message));
  assert.deepEqual(bobsCalls(from), []);
  assert.equal(S.getState().workspaces[0].hostedApps.todo.projectId, "dp_new");
});

await check("Bob signs in while a first deploy reads the computer's projects: no project is made, nothing is kept, nothing goes with his key", async () => {
  await asAlex();
  bobSignsInOn("GET /api/computers/c_a/deploy-projects");
  const from = calls.length;
  const got = await fails(H.deployApp("ws_main", "todo"));
  assert.equal(on.size, 0, "Bob signed in as it read them");
  assert.equal(got.error?.message, SWAPPED);
  assert.equal(got.error?.status, 409);
  assert.deepEqual(bobsCalls(from), [], "no call with Bob's key (his own computer c_b least of all)");
  assert.ok(!calls.slice(from).some((c) => c.what.startsWith("POST ")), "nothing made");
  bobUntouched();
});

/* ---------------- A deploy once a task on the app has committed (work_on_app's deploy) ---------------- */

/** The task on todo, done, asked to put it live after, started from an older commit. */
const doneAskingDeploy = () =>
  S.update((s) => {
    Object.assign(s.sessions[0], { status: "done", app: { wsId: "ws_main", name: "todo", deployAfter: true, from: "e".repeat(64) } });
  });
const deploySaid = (st) => st.messages.filter((m) => m.sessionIds?.includes("ses_app"));

await check("a task's deploy once it committed, with no sign-in meanwhile: deployed on Alex's computer with his key, said in his chat", async () => {
  await asAlex();
  doneAskingDeploy();
  const from = calls.length;
  await H.deployAfterTask("ses_app");
  assert.ok(calls.slice(from).some((c) => c.as === "alex" && c.what === "POST /api/computers/c_a/deploy-projects/dp_new/deployments"));
  assert.deepEqual(bobsCalls(from), []);
  assert.match(deploySaid(S.getState()).at(-1)?.text ?? "", /^Deploying (a preview of )?the newest commit of todo/);
  assert.equal(S.getState().sessions[0].app.deployAfter, undefined);
});

await check("Bob signs in while a task's deploy reads the app's newest commit: nothing deployed, nothing said, nothing in his state", async () => {
  await asAlex();
  doneAskingDeploy();
  bobSignsInOn(`GET /api/v1/w/${PA}/repos/todo`);
  const from = calls.length;
  await H.deployAfterTask("ses_app");
  assert.equal(on.size, 0, "Bob signed in as it read it");
  assert.deepEqual(bobsCalls(from), [], "no call with Bob's key");
  assert.ok(!calls.slice(from).some((c) => c.what.includes("deploy-projects")), "nothing deployed");
  assert.deepEqual(deploySaid(S.getState()), [], "nothing said in Bob's chats");
  assert.ok(!JSON.stringify(S.getState().sessions).includes("todo"), "no task of Alex's in Bob's state");
  bobUntouched();
});

/* ---------------- A DNS change ---------------- */

await check("a DNS record added, with no sign-in meanwhile: to Alex's zone, with his key", async () => {
  await asAlex();
  const from = calls.length;
  await H.addRecord("ws_main", "shop", ZONE, { type: "TXT", name: "x", value: "y" });
  assert.ok(calls.slice(from).some((c) => c.as === "alex" && c.what === `POST /api/projects/${PA}/domains/${ZONE}/dns/records`));
  assert.deepEqual(bobsCalls(from), []);
});

await check("Bob signs in while a DNS change reads the app's domains: no record goes anywhere, nothing with his key", async () => {
  await asAlex();
  bobSignsInOn("GET /api/computers/c_a/domains");
  const from = calls.length;
  const got = await fails(H.addRecord("ws_main", "shop", ZONE, { type: "TXT", name: "x", value: "y" }));
  assert.equal(on.size, 0, "Bob signed in as it read them");
  assert.equal(got.error?.message, SWAPPED);
  assert.deepEqual(bobsCalls(from), []);
  assert.ok(!calls.slice(from).some((c) => c.what.includes("/dns")), "no zone read or written");
  bobUntouched();
});

/* ---------------- Add app, settings, variables, a rollback, a domain bought ---------------- */

/** Tasks Add app started (sessions.ts stand-in). */
const startedTasks = [];
globalThis.__startSession = (o) => {
  startedTasks.push(o);
  return { id: `ses_new_${startedTasks.length}`, chatId: o.chatId };
};
const writesBy = (from, as) => calls.slice(from).filter((c) => c.as === as && !c.what.startsWith("GET "));

await check("Add app, with no sign-in meanwhile: the name checked in Alex's Ingot, his main bot's task started", async () => {
  await asAlex();
  const from = calls.length;
  const got = await H.addApp("ws_main", { name: "guest-book", what: "A page for notes.", deploy: true });
  assert.equal(got.name, "guest-book");
  assert.equal(startedTasks.at(-1).app.name, "guest-book");
  assert.ok(calls.slice(from).some((c) => c.as === "alex" && c.what === `GET /api/v1/w/${PA}/repos`));
  assert.deepEqual(bobsCalls(from), []);
});

await check("Bob signs in while Add app checks the name in Ingot: no task, nothing kept or said, nothing with his key", async () => {
  await asAlex();
  bobSignsInOn(`GET /api/v1/w/${PA}/repos`);
  const from = calls.length;
  const n = startedTasks.length;
  const got = await fails(H.addApp("ws_main", { name: "guest-book", what: "A page for notes.", deploy: true }));
  assert.equal(on.size, 0, "Bob signed in as it looked");
  assert.equal(got.error?.message, SWAPPED);
  assert.equal(startedTasks.length, n, "no task");
  assert.deepEqual(bobsCalls(from), []);
  assert.ok(!S.getState().messages.some((m) => /guest-book/.test(m.text)), "nothing said");
  bobUntouched();
});

await check("A domain bought, with no sign-in meanwhile: bought in Alex's Orgo workspace with his key, then pointed at his app", async () => {
  await asAlex();
  const from = calls.length;
  const got = await H.buyDomain("ws_main", "shop", { domain: "guest.example", registrant: { first_name: "Ava" }, price: 1200 });
  assert.equal(got.bought, "guest.example");
  assert.deepEqual(
    writesBy(from, "alex").map((c) => c.what),
    [`POST /api/projects/${PA}/domains`, "POST /api/computers/c_a/domains"],
  );
  assert.deepEqual(bobsCalls(from), []);
});

await check("Bob signs in while a buy reads the app's domains: nothing bought, nothing with his key", async () => {
  await asAlex();
  bobSignsInOn("GET /api/computers/c_a/domains");
  const from = calls.length;
  const got = await fails(H.buyDomain("ws_main", "shop", { domain: "guest.example", registrant: { first_name: "Ava" }, price: 1200 }));
  assert.equal(got.error?.message, SWAPPED);
  assert.ok(!calls.slice(from).some((c) => c.what === `POST /api/projects/${PA}/domains`), "no buy");
  assert.deepEqual(bobsCalls(from), []);
  bobUntouched();
});

await check("Bob signs in while the buy goes through: it's Alex's (bought with his key), and nothing more goes: not pointed anywhere, nothing with Bob's key or in his state", async () => {
  await asAlex();
  bobSignsInOn(`POST /api/projects/${PA}/domains`);
  const from = calls.length;
  const got = await fails(H.buyDomain("ws_main", "shop", { domain: "guest.example", registrant: { first_name: "Ava" }, price: 1200 }));
  assert.equal(on.size, 0);
  assert.equal(got.error?.message, SWAPPED);
  assert.deepEqual(writesBy(from, "alex").map((c) => c.what), [`POST /api/projects/${PA}/domains`], "the buy alone");
  assert.ok(!calls.slice(from).some((c) => c.what === "POST /api/computers/c_a/domains"), "not pointed anywhere");
  assert.deepEqual(bobsCalls(from), []);
  bobUntouched();
});

await check("Bob signs in while a variable change reads the app's project: the values go nowhere; a port change: no domain moved; a rollback: none queued", async () => {
  await asAlex();
  bobSignsInOn("GET /api/computers/c_a/deploy-projects/dp_live");
  let from = calls.length;
  const env = await fails(H.changeEnv("ws_main", "shop", { API_TOKEN: "made-up-secret-value-7d3f" }));
  assert.equal(env.error?.message, SWAPPED);
  assert.ok(!calls.slice(from).some((c) => c.what.includes("/env")), "no variable sent");
  assert.deepEqual(bobsCalls(from), []);
  bobUntouched();

  await asAlex();
  bobSignsInOn("PATCH /api/computers/c_a/deploy-projects/dp_live");
  from = calls.length;
  const port = await fails(H.changeSettings("ws_main", "shop", { port: 4100 }));
  assert.equal(port.error?.message, SWAPPED);
  assert.ok(!calls.slice(from).some((c) => c.what.startsWith("PATCH /api/computers/c_a/domains/")), "no domain moved");
  assert.deepEqual(bobsCalls(from), []);
  bobUntouched();

  await asAlex();
  bobSignsInOn("GET /api/computers/c_a/deploy-projects/dp_live");
  from = calls.length;
  const back = await fails(H.rollbackApp("ws_main", "shop", "dep_old"));
  assert.equal(back.error?.message, SWAPPED);
  assert.ok(!calls.slice(from).some((c) => c.what.includes("/rollback")), "no rollback");
  assert.deepEqual(bobsCalls(from), []);
  bobUntouched();
});

await check("nothing unexpected: no rejections", () => {
  assert.deepEqual(rejections, []);
});

await S.flushState?.(2000);
console.log(`\napps across a sign-in: ${passed} passed, ${failed} failed`);
if (!failed) rmSync(scratch, { recursive: true, force: true });
else console.log(`The throwaway folder is kept for a look: ${scratch}`);
process.exit(failed ? 1 : 0);
