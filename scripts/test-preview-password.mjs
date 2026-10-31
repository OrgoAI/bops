// Tests for each site's Preview password (lib/server/hosted-apps.ts passwordNow, previewPassword, changePreviewPassword,
// newPassword; the public URL password calls in lib/server/orgo.ts; app/api/hosted-apps/[name]/password): a password is
// 7 characters of letters and digits without look-alikes, case sensitive, with a letter and a digit, crypto random; a new
// Preview link gets one at once, and one found without one gets one on the next read of the Apps page, once (two reads
// at once ask once); an orgo-web that can't tell (no `protected`) is never asked, read after read; one Orgo turned down
// isn't asked again in a loop, nor for an hour when Orgo can't take one yet (503 PASSWORD_UNAVAILABLE) or the key can't
// (403); a key that can't read it gets none with why, never an error, and one Orgo keeps only the cookie's check of
// answers no password with its cookie; the owner's off choice is kept on the site's record and Bops sets none then, on a read or
// a deploy, until they turn it on again; a Preview deploy that goes live gets a new one, one that fails or is stopped
// keeps it, a Published deploy never touches it, and a site that's off is skipped; each site has its own; New password
// keeps the link; the routes are the Bops window's alone, refused while a shared workspace is open and for an account
// apps aren't open to; and a bot's words (its deploy answer, its note of the workspace's apps) say a Preview asks for a
// password but never carry it. Nothing a person reads has a dash.
//
// orgo-web (deploy projects and their deploys, public URLs with passwords) and the central Ingot are a fake fetch on
// made-up origins, the Keychain a fake `security`, and the state lives in a throwaway folder: nothing reaches a real
// service. The keys in it are made up.
// Usage: node --conditions=react-server scripts/test-preview-password.mjs
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG|INGOT)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-preview-password";
process.env.BOPS_RESPONSES_WS = "0";
const UI = "ui-token-test-preview-password";
process.env.BOPS_UI_TOKEN = UI;
const ORGO = "http://orgo.test";
const INGOT = "http://ingot.test";
process.env.BOPS_ORGO_ORIGIN = ORGO;
process.env.BOPS_INGOT_URL = INGOT;
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-preview-password-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), '#!/bin/sh\nif [ "$1" = "-i" ]; then cat >/dev/null; exit 0; fi\nexit 44\n', { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
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
process.emitWarning = (w, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(w, ...rest));
const logged = [];
for (const k of ["info", "warn"]) console[k] = (...a) => logged.push(a.map(String).join(" "));

const sha = (b) => createHash("sha256").update(b).digest("hex");
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
let clock = Date.parse("2026-10-30T12:00:00Z");
const iso = () => new Date((clock += 60_000)).toISOString();

const KEY = "sk_orgo_test_preview_password";
const PA = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const TOKEN_SUM = sha("ingot_test_token\n");
const alex = { id: "u_alex", email: "alex@orgo.ai", name: "Alex" };
const HEAD = sha("head");

/* ---------------- A fake orgo-web: deploy projects and their deploys, public URLs with passwords ---------------- */

/**
 * `projects` and `urls` on the computer c_a; `old`: an orgo-web from before passwords (no `protected`, and a PATCH
 * with a password turned down); `refuse`: every password change turned down (503); `unavailable`: before Orgo's
 * migration (503 PASSWORD_UNAVAILABLE); `readOnly`: a key without write on computers (403 key_permission on the
 * password's read and change); `hashOnly`: Orgo keeps only the cookie's check of it (its read says no password);
 * every call, with its body.
 */
const web = { projects: [], urls: [], calls: [], old: false, refuse: false, unavailable: false, readOnly: false, hashOnly: false };
const KEY_PERMISSION = { error: "This key can't do that. It needs computers write.", code: "key_permission" };
const PASS = /^[\x20-\x7e]{4,64}$/;
const urlView = (u) => ({ id: u.id, url: `https://${u.label}.orgo.dev`, hostname: `${u.label}.orgo.dev`, label: u.label, port: u.port, created_at: u.created_at, ...(web.old ? {} : { protected: !!u.password }) });
const projectView = (p) => {
  const ds = [...p.deployments].reverse();
  return { id: p.id, name: p.name, source: "ingot", repo: null, ingot_repo: p.ingot_repo, url: null, port: p.port, env_keys: [], current: p.deployments.findLast((d) => d.state === "succeeded" || d.live) ?? null, deployments: ds };
};
function orgoWeb(req, url, body) {
  web.calls.push({ method: req.method, path: url.pathname, body });
  if (req.headers.get("authorization") !== `Bearer ${KEY}`) return json({ error: "Not authenticated" }, 401);
  if (url.pathname === "/api/computers/c_a" && req.method === "GET") return json({ id: "c_a", name: "bops-alex", status: "running" });
  if (url.pathname === "/api/computers/c_a/domains") return json({ enabled: true, domains: [] });
  if (url.pathname === "/api/computers/c_a/deploy-projects" && req.method === "GET") return json({ enabled: true, projects: web.projects.map(projectView) });
  if (url.pathname === "/api/computers/c_a/deploy-projects" && req.method === "POST") {
    if (web.projects.some((x) => x.name === body.name)) return json({ error: "Name taken", code: "NAME_TAKEN" }, 409);
    const p = { id: randomUUID(), name: body.name, port: body.port, ingot_repo: body.repo, deployments: [], publicUrl: body.public_url };
    web.projects.push(p);
    return json(projectView(p), 201);
  }
  let m = url.pathname.match(/^\/api\/computers\/c_a\/deploy-projects\/([^/]+)(\/env|\/deployments)?$/);
  if (m) {
    const p = web.projects.find((x) => x.id === m[1]);
    if (!p) return json({ error: "Project not found", code: "NOT_FOUND" }, 404);
    if (!m[2] && req.method === "GET") return json(projectView(p));
    if (!m[2] && req.method === "PATCH") return json(projectView(p));
    if (m[2] === "/env") return json({ env_keys: Object.keys(body.env ?? {}) });
    if (m[2] === "/deployments" && req.method === "POST") {
      const d = { id: randomUUID(), project_id: p.id, state: "queued", source_version: body.at ?? HEAD, created_at: iso() };
      p.deployments.push(d);
      return json(d, 202);
    }
  }
  if (url.pathname === "/api/computers/c_a/public-urls" && req.method === "GET") return json({ enabled: true, base_domain: "orgo.dev", public_urls: web.urls.map(urlView) });
  if (url.pathname === "/api/computers/c_a/public-urls" && req.method === "POST") {
    const u = { id: randomUUID(), label: body.label, port: body.port, created_at: iso(), password: null };
    web.urls.push(u);
    return json(urlView(u), 201);
  }
  m = url.pathname.match(/^\/api\/computers\/c_a\/public-urls\/([^/]+)(\/password)?$/);
  if (m) {
    const u = web.urls.find((x) => x.id === m[1]);
    if (!u) return json({ error: "Public URL not found" }, 404);
    if (m[2] && req.method === "GET" && web.readOnly) return json(KEY_PERMISSION, 403);
    if (m[2] && req.method === "GET") return web.old ? json({ error: "Not found" }, 404) : json({ password: web.hashOnly ? null : u.password, cookie: u.password ? { name: "__Host-orgo_pass", value: `v1.${Buffer.from(`${u.id}:${u.password}`).toString("hex").padEnd(32, "0").slice(0, 32)}` } : null });
    if (!m[2] && req.method === "PATCH") {
      if ("password" in (body ?? {})) {
        if (web.old) return json({ error: "Nothing to change", code: "INVALID_BODY" }, 400);
        if (web.refuse) return json({ error: "Try again later" }, 503);
        if (web.unavailable) return json({ error: "Passwords aren't available yet.", code: "PASSWORD_UNAVAILABLE" }, 503);
        if (web.readOnly) return json(KEY_PERMISSION, 403);
        if (body.password !== null && (typeof body.password !== "string" || !PASS.test(body.password))) return json({ error: "A password is 4 to 64 characters", code: "INVALID_PASSWORD" }, 400);
        u.password = body.password;
      }
      if (typeof body?.port === "number") u.port = body.port;
      return json(urlView(u));
    }
    if (!m[2] && req.method === "DELETE") {
      web.urls = web.urls.filter((x) => x !== u);
      return new Response(null, { status: 204 });
    }
  }
  return json({ error: "Not found" }, 404);
}

/** The central Ingot: the workspace's one repo, recipe-box, at HEAD. */
function ingotApi(req, url) {
  if (url.pathname === `/api/v1/w/${PA}/repos` && req.method === "GET") return json({ repos: [{ name: "recipe-box", head: HEAD, updated_at: iso() }] });
  if (url.pathname === `/api/v1/w/${PA}/repos/recipe-box` && req.method === "GET") return json({ repo: { name: "recipe-box" }, refs: [{ name: "main", target: HEAD }] });
  return json({ error: "not_found", message: "No such route." }, 404);
}

globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const text = await req.text();
  const body = text ? JSON.parse(text) : undefined;
  if (url.origin === ORGO) return orgoWeb(req, url, body);
  if (url.origin === INGOT) return ingotApi(req, url);
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};

const S = await import(`${root}/lib/server/store.ts`);
const Auth = await import(`${root}/lib/server/orgo-auth.ts`);
const H = await import(`${root}/lib/server/hosted-apps.ts`);
const L = await import(`${root}/lib/server/app-labels.ts`);
const AppsRoute = await import(`${root}/app/api/hosted-apps/route.ts`);
const AppRoute = await import(`${root}/app/api/hosted-apps/[name]/route.ts`);
const PassRoute = await import(`${root}/app/api/hosted-apps/[name]/password/route.ts`);
clearInterval(globalThis.__bopsRoutines);
await Auth.signIn(KEY, alex);

const REPO = `${PA}/recipe-box`;
/** Each check starts the same: Alex's app recipe-box on his computer c_a, Ingot set up there, nothing on Orgo yet. */
function fresh() {
  Object.assign(web, { projects: [], urls: [], calls: [], old: false, refuse: false, unavailable: false, readOnly: false, hashOnly: false });
  globalThis.bopsIngotListed?.clear();
  globalThis.bopsPasswordRefused?.clear();
  globalThis.bopsShared = null;
  S.update((s) => {
    s.owner = { name: "Alex", timeZone: "America/New_York" };
    s.account = { ...s.account, user: alex };
    s.workspaces[0].orgoProjectId = PA;
    s.workspaces[0].ingotTokens = { c_a: { id: "7", sum: TOKEN_SUM, at: Date.now() } };
    s.workspaces[0].hostedApps = { "recipe-box": { botId: "boppy", computerId: "c_a" } };
    Object.assign(s.bots.find((x) => x.id === "boppy"), { name: "Boppy", computerStatus: "ready", computerId: "c_a" });
    s.messages = [];
  });
}

let passed = 0;
let failed = 0;
async function check(name, fn) {
  fresh();
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e?.stack ?? e).split("\n").slice(0, 8).join("\n     ")}`);
  }
}
/** Everything a person or a bot reads, checked for dashes at the end. */
const heard = [];
const hear = (x) => (heard.push(typeof x === "string" ? x : JSON.stringify(x)), x);

const req = (path, { method = "GET", body, window = true } = {}) =>
  new Request(`http://localhost:3210${path}`, { method, headers: { "content-type": "application/json", ...(window ? { "x-bops-window": UI } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
const params = (name = "recipe-box") => ({ params: Promise.resolve({ name }) });
const answerOf = async (res) => ({ status: res.status, body: hear(await res.json()) });
/** The Apps page's read (GET /api/hosted-apps), its app. */
const list = async () => {
  const r = await answerOf(await AppsRoute.GET(req("/api/hosted-apps?ws=ws_main")));
  assert.equal(r.status, 200);
  return r.body.apps.find((a) => a.name === "recipe-box");
};
const act = async (body, window = true) => answerOf(await AppRoute.POST(req("/api/hosted-apps/recipe-box", { method: "POST", body: { ws: "ws_main", ...body }, window }), params()));
const passGet = async ({ site, window = true, name = "recipe-box" } = {}) => answerOf(await PassRoute.GET(req(`/api/hosted-apps/${name}/password?ws=ws_main${site ? `&site=${site}` : ""}`, { window }), params(name)));
const passPost = async (body, { window = true, name = "recipe-box" } = {}) => answerOf(await PassRoute.POST(req(`/api/hosted-apps/${name}/password`, { method: "POST", body: { ws: "ws_main", ...body }, window }), params(name)));

/** Password changes Orgo was asked for (PATCH a public URL with a password), from call `n` on. */
const passwordCalls = (n = 0) => web.calls.slice(n).filter((c) => c.method === "PATCH" && /\/public-urls\/[^/]+$/.test(c.path) && c.body && "password" in c.body);
const previewLink = (site = "recipe-box") => web.urls.find((u) => L.isLabelOf("preview", u.label, REPO, site));
const previewProject = (site = "recipe-box") => web.projects.find((p) => L.isLabelOf("preview", p.name, REPO, site));
const prodProject = (site = "recipe-box") => web.projects.find((p) => L.isLabelOf("prod", p.name, REPO, site));
const record = () => S.getState().workspaces[0].hostedApps["recipe-box"];
/** The newest deploy of a project ends as `state` (succeeded: it's live). */
const ends = (p, state) => {
  const d = p.deployments.at(-1);
  d.state = state;
  d.finished_at = iso();
};
/** Deploy the app to its Preview (the window's Deploy), its newest deploy then ending as `state`. */
const deployPreview = async (state) => {
  const r = await act({ action: "deploy", env: "preview" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (state) ends(previewProject(), state);
  return r.body.app;
};

const SHAPE = /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{7}$/;

/* ---------------- Its shape ---------------- */

await check("newPassword: 7 characters of letters and digits without look alikes (no 0 O o 1 l I), case sensitive, a letter and a digit in each, from crypto random", async () => {
  const seen = new Set();
  const chars = new Set();
  for (let i = 0; i < 3000; i++) {
    const p = H.newPassword();
    assert.match(p, SHAPE);
    assert.match(p, /[A-Za-z]/, "a letter");
    assert.match(p, /[2-9]/, "a digit");
    assert.doesNotMatch(p, /[0Oo1lI]/);
    seen.add(p);
    for (const c of p) chars.add(c);
  }
  assert.ok(seen.size > 2990, "random: hardly ever the same twice");
  assert.equal(chars.size, 56, "every one of the 56 characters comes up, upper and lower case both");
  assert.equal(H.PASSWORD_LENGTH, 7);
  // Its random source is crypto's randomInt by default; one that never gives a digit (or a letter) still gives a password with both.
  assert.match(H.newPassword(() => 0), SHAPE);
  assert.match(H.newPassword(() => 0), /[2-9]/);
  assert.match(H.newPassword(() => 55), /[A-Za-z]/);
  const asked = [];
  H.newPassword((n) => (asked.push(n), 50));
  assert.ok(asked.every((n) => n === 56), "one of 56 each time");
  assert.match(readFileSync(`${root}/lib/server/hosted-apps.ts`, "utf8"), /import \{ createHash, randomInt \} from "node:crypto";/);
});

/* ---------------- On by default ---------------- */

await check("a new Preview link gets a password at once, before its first deploy is queued; the list says it asks for one and when it was set; the route gives it with its cookie", async () => {
  const app = await deployPreview();
  const link = previewLink();
  assert.ok(link?.password, "set on Orgo");
  assert.match(link.password, SHAPE);
  const order = web.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path.replace(/[0-9a-f-]{36}/g, "id").replace(link.label, "label")}${c.body && "password" in c.body ? " password" : ""}`);
  assert.deepEqual(order, [
    "POST /api/computers/c_a/deploy-projects",
    "POST /api/computers/c_a/public-urls",
    "POST /api/computers/c_a/deploy-projects",
    "PATCH /api/computers/c_a/public-urls/id password",
    "POST /api/computers/c_a/deploy-projects/id/deployments",
  ]);
  assert.deepEqual(record().passwordSet && { ...record().passwordSet, at: 0 }, { at: 0, live: null }, "kept: set with nothing live yet");
  assert.equal(record().passwordOff, undefined);
  assert.equal(JSON.stringify(S.getState()).includes(link.password), false, "the password itself is never kept");
  assert.equal(app.preview.protected, true);
  assert.equal(app.preview.passwordAt, record().passwordSet.at);
  const r = await passGet();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { url: `https://${link.label}.orgo.dev`, on: true, password: link.password, cookie: { name: "__Host-orgo_pass", value: r.body.cookie.value }, at: record().passwordSet.at });
  assert.match(r.body.cookie.value, /^v1\.[0-9a-f]{32}$/);
});

await check("an existing Preview with no password gets one on the next read of the Apps page, once; two reads at once ask once", async () => {
  await deployPreview("succeeded");
  // (As a Preview from before passwords: its password gone, Bops' record of it too.)
  previewLink().password = null;
  S.update((s) => void delete s.workspaces[0].hostedApps["recipe-box"].passwordSet);
  const n = web.calls.length;
  const [a, b] = await Promise.all([list(), list()]);
  assert.equal(passwordCalls(n).length, 1, "asked once");
  assert.match(previewLink().password, SHAPE);
  assert.equal(a.preview.protected, true);
  assert.equal(b.preview.protected, true);
  const live = previewProject().deployments.at(-1).id;
  assert.equal(record().passwordSet.live, live, "set for what's live now: no second one for it");
  const m = web.calls.length;
  await list();
  await list();
  assert.equal(passwordCalls(m).length, 0, "nothing more asked");
});

await check("an Orgo that can't tell (no `protected`) is left alone: no password asked for on a deploy or read after read, nothing kept, and the route says Orgo can't", async () => {
  web.old = true;
  await deployPreview("succeeded");
  for (let i = 0; i < 4; i++) {
    const app = await list();
    assert.equal(app.preview.protected, undefined);
    assert.equal(app.preview.passwordAt, undefined);
  }
  assert.equal(passwordCalls().length, 0, "never asked");
  assert.equal(record().passwordSet, undefined);
  const got = await passGet();
  assert.deepEqual(got.body, { url: previewLink() && `https://${previewLink().label}.orgo.dev`, on: null, password: null, cookie: null });
  for (const action of ["new", "on", "off"]) {
    const r = await passPost({ action });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "Orgo can't put a password on its preview yet.");
  }
  assert.equal(passwordCalls().length, 0);
});

await check("a password Orgo turned down isn't asked for again in a loop: once, then again only after a few minutes", async () => {
  web.refuse = true;
  await deployPreview();
  assert.equal(passwordCalls().length, 1, "tried with the new link");
  for (let i = 0; i < 3; i++) assert.equal((await list()).preview.protected, false);
  assert.equal(passwordCalls().length, 1, "not again on each read");
  // (A few minutes later.)
  globalThis.bopsPasswordRefused.clear();
  web.refuse = false;
  assert.equal((await list()).preview.protected, true);
  assert.equal(passwordCalls().length, 2);
});

await check("an Orgo that can't take a password yet (503 PASSWORD_UNAVAILABLE), or a key that can't change one (403): asked once, then left alone for an hour, as an older Orgo; changing it by hand says why", async () => {
  for (const flag of ["unavailable", "readOnly"]) {
    fresh();
    web[flag] = true;
    await deployPreview("succeeded");
    for (let i = 0; i < 3; i++) await list();
    assert.equal(passwordCalls().length, 1, `${flag}: asked once`);
    const until = [...globalThis.bopsPasswordRefused.values()][0];
    assert.ok(until - Date.now() > 50 * 60_000, `${flag}: not again for an hour`);
    const r = await passPost({ action: "on" });
    assert.deepEqual([r.status, r.body.error], flag === "unavailable" ? [409, "Orgo can't put a password on its preview yet."] : [403, "Your Orgo key can't see or change it. Sign in with Orgo again to use one that can."]);
    assert.equal(record().passwordOff, undefined, "nothing kept of it");
  }
});

await check("a key that can't read the password (403 key_permission) gets none, with why, as an answer and never an error; one Orgo keeps only the cookie's check of answers no password, with its cookie", async () => {
  await deployPreview("succeeded");
  await list();
  web.readOnly = true;
  const r = await passGet();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { url: `https://${previewLink().label}.orgo.dev`, on: true, password: null, cookie: null, why: "Your Orgo key can't see or change it. Sign in with Orgo again to use one that can.", at: record().passwordSet.at });
  web.readOnly = false;
  web.hashOnly = true;
  const h = await passGet();
  assert.equal(h.status, 200);
  assert.equal(h.body.password, null);
  assert.equal(h.body.cookie.name, "__Host-orgo_pass", "Bops' own view still opens it");
  assert.equal(h.body.why, undefined);
});

/* ---------------- The owner's choice ---------------- */

await check("turned off: Orgo's password removed, the choice kept on the site's record, and Bops sets none on a read or a deploy that goes live; turned on again, a new one", async () => {
  await deployPreview("succeeded");
  await list();
  const off = await passPost({ action: "off" });
  assert.equal(off.status, 200);
  assert.deepEqual(off.body, { url: `https://${previewLink().label}.orgo.dev`, on: false, password: null, cookie: null, ...(record().passwordSet ? { at: record().passwordSet.at } : {}) });
  assert.equal(previewLink().password, null, "off on Orgo");
  assert.equal(record().passwordOff, true, "the owner's choice, on the record");
  const n = web.calls.length;
  for (let i = 0; i < 3; i++) assert.equal((await list()).preview.protected, false);
  await deployPreview("succeeded");
  await list();
  assert.equal(passwordCalls(n).length, 0, "none set while it's off");
  assert.equal(previewLink().password, null);
  const on = await passPost({ action: "on" });
  assert.equal(on.status, 200);
  assert.match(on.body.password, SHAPE);
  assert.equal(on.body.on, true);
  assert.equal(previewLink().password, on.body.password);
  assert.equal(record().passwordOff, undefined, "the choice gone");
  assert.equal(record().passwordSet.live, previewProject().deployments.at(-1).id);
  assert.equal((await list()).preview.protected, true);
});

await check("New password: a new one for the same link (nothing else made, moved or deployed), the list's passwordAt moves on, and the route gives the new one; refused while it's off", async () => {
  await deployPreview("succeeded");
  const before = await list();
  const was = previewLink().password;
  const label = previewLink().label;
  const n = web.calls.length;
  await new Promise((r) => setTimeout(r, 5));
  const r = await passPost({ action: "new" });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.password, was);
  assert.match(r.body.password, SHAPE);
  assert.equal(previewLink().password, r.body.password);
  assert.equal(previewLink().label, label, "the link stays");
  assert.deepEqual(web.calls.slice(n).filter((c) => c.method !== "GET").map((c) => c.method), ["PATCH"], "only its password changed");
  const after = await list();
  assert.ok(after.preview.passwordAt > before.preview.passwordAt, "a window holding the old one reads it again");
  assert.equal(r.body.at, after.preview.passwordAt);
  assert.equal((await passGet()).body.password, r.body.password);
  await passPost({ action: "off" });
  const again = await passPost({ action: "new" });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "Its password is off. Turn it on first.");
});

/* ---------------- A new one with each Preview deploy that goes live ---------------- */

await check("a Preview deploy that goes live gets a new password (once); one that fails or is stopped keeps it; a Published deploy never touches it; a site that's off is skipped", async () => {
  await deployPreview("succeeded");
  await list();
  const first = previewLink().password;
  const firstAt = record().passwordSet.at;
  assert.equal(record().passwordSet.live, previewProject().deployments.at(-1).id);
  // Another goes live: a new one, once.
  await deployPreview("succeeded");
  await new Promise((r) => setTimeout(r, 5));
  let n = web.calls.length;
  const app = await list();
  assert.equal(passwordCalls(n).length, 1, "a new one");
  const second = previewLink().password;
  assert.notEqual(second, first);
  assert.ok(app.preview.passwordAt > firstAt);
  assert.equal((await passGet()).body.password, second, "every place reads the new one");
  n = web.calls.length;
  await list();
  assert.equal(passwordCalls(n).length, 0, "once a deploy");
  // Still deploying, then failed: the one it has stays.
  await deployPreview();
  await list();
  ends(previewProject(), "running");
  await list();
  ends(previewProject(), "failed");
  await list();
  assert.equal(passwordCalls(n).length, 0, "not when it starts, nor when it fails");
  assert.equal(previewLink().password, second);
  // Stopped (cancelled, or replaced by a newer one): the same.
  await deployPreview("cancelled");
  await list();
  await deployPreview("superseded");
  await list();
  assert.equal(passwordCalls(n).length, 0);
  // Published goes live (a Publish, an Apply variables): its project isn't the Preview's, so nothing.
  const prod = prodProject();
  prod.deployments.push({ id: randomUUID(), project_id: prod.id, state: "succeeded", source_version: HEAD, created_at: iso(), finished_at: iso() });
  await list();
  assert.equal(passwordCalls(n).length, 0, "a Published deploy never touches it");
  assert.equal(previewLink().password, second);
  // Turned off: a deploy that goes live sets none.
  await passPost({ action: "off" });
  n = web.calls.length;
  await deployPreview("succeeded");
  await list();
  await passGet();
  assert.equal(passwordCalls(n).length, 0, "skipped while it's off");
  assert.equal(previewLink().password, null);
});

await check("each site has its own: a new link for each, a deploy of one renews only its own, off for one leaves the other", async () => {
  S.update((s) => void (s.workspaces[0].hostedApps["recipe-box"].sites = [{ name: "recipe-admin" }]));
  await deployPreview();
  ends(previewProject(), "succeeded");
  ends(previewProject("recipe-admin"), "succeeded");
  await list();
  const own = previewLink().password;
  const admin = previewLink("recipe-admin").password;
  assert.match(own, SHAPE);
  assert.match(admin, SHAPE);
  assert.notEqual(own, admin);
  assert.ok(record().sites[0].passwordSet, "kept on the site's own record");
  const r = await act({ action: "deploy", env: "preview", site: "recipe-admin" });
  assert.equal(r.status, 200);
  ends(previewProject("recipe-admin"), "succeeded");
  await list();
  assert.equal(previewLink().password, own, "the app's own site keeps its");
  assert.notEqual(previewLink("recipe-admin").password, admin);
  const off = await passPost({ action: "off", site: "recipe-admin" });
  assert.equal(off.body.on, false);
  assert.equal(record().sites[0].passwordOff, true);
  assert.equal(record().passwordOff, undefined, "the app's own site's choice is its own");
  assert.equal(previewLink().password, own);
  assert.equal((await passGet({ site: "recipe-admin" })).body.on, false);
  assert.equal((await passGet()).body.password, own);
  assert.equal((await passGet({ site: "nope" })).status, 404);
});

/* ---------------- The routes ---------------- */

await check("the routes are the Bops window's alone, refused while a shared workspace is open and for an account apps aren't open to; a site with no link yet has none", async () => {
  // No link yet: nothing to read, nothing to change.
  assert.deepEqual((await passGet()).body, { url: null, on: null, password: null, cookie: null });
  const none = await passPost({ action: "new" });
  assert.equal(none.status, 409);
  assert.equal(none.body.error, "It has no preview link yet. Deploy a preview first.");
  await deployPreview();
  // From a page that isn't the Bops window (a bot's browser on this Mac, say): no.
  for (const r of [await passGet({ window: false }), await passPost({ action: "new" }, { window: false }), await passPost({ action: "off" }, { window: false })]) {
    assert.equal(r.status, 403);
    assert.equal(r.body.password, undefined);
  }
  assert.equal(previewLink().password.length, 7, "nothing changed");
  // A workspace someone shared with Alex open: their password isn't Alex's to see, nor his to change.
  globalThis.bopsShared = { user: S.stateUser(), key: KEY, copy: { openNow: () => ({ projectId: "p_shared" }), data: () => ({ messages: [] }), close() {} }, subscriber: { stop() {} }, moods: { forApp: () => ({}) } };
  for (const r of [await passGet(), await passPost({ action: "new" })]) {
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "Only the owner can do this.");
  }
  globalThis.bopsShared = null;
  // An account apps on the web aren't open to: as if there were no such route.
  S.update((s) => void (s.account.user = { ...alex, email: "alex@example.com" }));
  assert.equal((await passGet()).status, 404);
  assert.equal((await passPost({ action: "new" })).status, 404);
  S.update((s) => void (s.account.user = alex));
  // What it can't be asked.
  const bad = await passPost({ action: "show" });
  assert.equal(bad.status, 400);
  assert.equal((await passGet({ name: "no-such-app" })).status, 404);
  assert.equal((await passGet({ name: "../etc" })).status, 404);
  assert.equal((await passGet()).status, 200);
});

/* ---------------- What bots are told ---------------- */

await check("a bot is told a Preview asks for a password, where the owner sees it, and to check its work on Local; never the password, in its note, its deploy answer or the chat", async () => {
  const said = await H.deployForBot("boppy", "recipe-box", null);
  hear(said);
  const pw = previewLink().password;
  assert.match(said, /It asks for a password, a new one once this deploy is live, shown beside its Preview link in Bops\./);
  assert.equal(said.includes(pw), false);
  const note = H.hostedAppsLine("boppy");
  hear(note);
  assert.match(note, /asks for a password unless Alex turned it off \(Alex sees it beside the Preview link in Bops; you never have it, so never write one in this chat or ask for it, and check your work on Local\)/);
  assert.equal(note.includes(pw), false);
  await passPost({ action: "off" });
  assert.match(H.hostedAppsLine("boppy"), /preview at https:\/\/[a-z0-9]{12}\.orgo\.dev, with no password;/);
  const chat = readFileSync(`${root}/lib/server/chat.ts`, "utf8");
  assert.match(chat, /It asks for a password \(a new one with each deploy\) unless \$\{owner\} turned that off: \$\{owner\} sees it beside the Preview link in Bops, and you never have it, so never write one in this chat; check your work on Local\./);
  const skills = readFileSync(`${root}/lib/builtin-skills.ts`, "utf8");
  assert.match(skills, /You never have it: never write a password in the chat or ask for it/);
  assert.equal(JSON.stringify(S.getState().messages).includes(pw), false);
});

/* ---------------- Words ---------------- */

await check("nothing a person or a bot reads here has a dash", async () => {
  for (const words of heard) assert.doesNotMatch(words.replace(/https?:\/\/\S+|[0-9a-f]{8}-[0-9a-f-]{27}|"[a-z]+-[a-z-]+"|recipe-(box|admin)|__Host-orgo_pass|\/api\/\S+/g, ""), /[-‐-―]/, words.slice(0, 200));
  const src = readFileSync(`${root}/components/app/preview-password.tsx`, "utf8");
  for (const [, s] of src.matchAll(/>([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g)) assert.doesNotMatch(s, /[‐-―]| - /, s);
  for (const [, s] of src.matchAll(/"([A-Z][^"]*[a-z.?][^"]*)"/g)) assert.doesNotMatch(s, /[‐-―]| - /, s);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`preview password: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
