// Tests for each site's Preview password (lib/server/hosted-apps.ts passwordNow, previewPassword, changePreviewPassword,
// newPassword; the public URL password calls in lib/server/orgo.ts; app/api/hosted-apps/[name]/password): a password is
// 7 characters of letters and digits without look-alikes, case sensitive, with a letter and a digit, crypto random; a new
// Preview link gets one at once from the Bops that made it, and one found without one gets one on the next read of the
// Apps page, once (two reads at once ask once), but not while it's just made; an orgo-web that can't tell (no `protected`)
// is never asked, read after read; one Orgo turned down isn't asked again in a loop, nor for an hour when Orgo can't take
// one yet (503 PASSWORD_UNAVAILABLE) or the key can't (403), and one Orgo answered 5xx is sent again once, the same; a
// key that can't read it gets none with why, never an error, and one Orgo keeps only the cookie's check of answers no
// password with its cookie; the owner's off choice is kept on the site's record and Bops sets none then, on a read or a
// deploy, until they turn it on again; a read of the link only ever sets a first one, never a new one because another
// deploy went live; a Preview deploy this Bops queued gets a new one once, as it goes live (watchPreview), never onto a
// link with none whose record says one was set, one that fails or is stopped gets none, a newer deploy takes over from an
// older one's watch, a set Orgo didn't take is tried again at a later look, a Published deploy never touches it, and a
// site that's off is skipped; each site has its own; New password keeps the link; whoever sets a password shares the
// very one it sent to Orgo with Bops Cloud (preview-password-share.ts: New, on and off too), for the account it was set
// in, one site's posts one at a time and in order, a newer one in place of one waiting, sent again for about 20 minutes
// while Bops Cloud doesn't take it; the owner's Mac tells Bops Cloud what Orgo has where its copy is another and older
// (apps-for-members.ts); the routes are the Bops window's alone, refused while a shared workspace is open and for an
// account apps aren't open to; and a bot's words (its deploy answer, its note of the workspace's apps) say a Preview asks
// for a password but never carry it, nor does any log line. Nothing a person reads has a dash.
//
// orgo-web (deploy projects and their deploys, public URLs with passwords), the central Ingot and Bops Cloud are a fake
// fetch on made-up origins, the Keychain a fake `security`, and the state lives in a throwaway folder: nothing reaches a
// real service. The keys in it are made up.
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
/** Bops Cloud, for the one check that sends a share on the wire (`cloudGot`: each post it got, with its sign in and account). */
const CLOUD = "http://cloud.test";
const cloudGot = [];
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
for (const k of ["info", "warn", "error", "debug"]) console[k] = (...a) => logged.push(a.map(String).join(" "));

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
 * `young`: a link made now says it was made now (else the made up clock's past); every call, with its body.
 */
const web = { projects: [], urls: [], calls: [], old: false, refuse: false, unavailable: false, readOnly: false, hashOnly: false, young: false };
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
  m = url.pathname.match(/^\/api\/computers\/c_a\/deployments\/([^/]+)\/rollback$/);
  if (m && req.method === "POST") {
    const p = web.projects.find((x) => x.deployments.some((d) => d.id === m[1]));
    if (!p) return json({ error: "Deployment not found", code: "NOT_FOUND" }, 404);
    const was = p.deployments.find((d) => d.id === m[1]);
    const d = { id: randomUUID(), project_id: p.id, state: "queued", trigger: "rollback", source_version: was.source_version, created_at: iso() };
    p.deployments.push(d);
    return json(d, 202);
  }
  if (url.pathname === "/api/computers/c_a/public-urls" && req.method === "GET") return json({ enabled: true, base_domain: "orgo.dev", public_urls: web.urls.map(urlView) });
  if (url.pathname === "/api/computers/c_a/public-urls" && req.method === "POST") {
    const u = { id: randomUUID(), label: body.label, port: body.port, created_at: web.young ? new Date().toISOString() : iso(), password: null };
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
  if (url.origin === CLOUD) return (cloudGot.push({ method: req.method, path: url.pathname, user: req.headers.get("x-bops-user"), auth: req.headers.get("authorization"), body }), new Response(null, { status: 204 }));
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};

const S = await import(`${root}/lib/server/store.ts`);
const Auth = await import(`${root}/lib/server/orgo-auth.ts`);
const H = await import(`${root}/lib/server/hosted-apps.ts`);
const Share = await import(`${root}/lib/server/preview-password-share.ts`);
// (The waits between a share's tries and a watch's looks don't keep a process up on their own: this does, to the end.)
const awake = setInterval(() => {}, 60_000);
const P = await import(`${root}/cloud/protocol.ts`);
const L = await import(`${root}/lib/server/app-labels.ts`);
const AppsRoute = await import(`${root}/app/api/hosted-apps/route.ts`);
const AppRoute = await import(`${root}/app/api/hosted-apps/[name]/route.ts`);
const PassRoute = await import(`${root}/app/api/hosted-apps/[name]/password/route.ts`);
clearInterval(globalThis.__bopsRoutines);
await Auth.signIn(KEY, alex);

const REPO = `${PA}/recipe-box`;
/** What Bops Cloud was told (preview-password-share.ts), each post as sent; `answers`: what it answers the next ones (204 when none is left). */
const shares = [];
const shareAnswers = [];
/** Every password shared in any check (the log check at the end). */
const everShared = new Set();
const recordShare = async (body) => (shares.push(structuredClone(body)), body.password && everShared.add(body.password), shareAnswers.length ? shareAnswers.shift() : 204);
Share.previewShareForTests.send(recordShare);
Share.previewShareForTests.retryMs([5, 5]);
/** Every password Orgo was sent, so no log line carries one (checked at the end). */
const sentToOrgo = new Set();
/** Watches of Preview deploys as the checks that aren't about them want them: so slow none looks within a check. */
const slow = () => H.previewWatchForTests.times({ every: 60_000, for: 20 * 60_000 });
/** And as the checks about them want them: a look every few milliseconds. */
const fast = () => H.previewWatchForTests.times({ every: 5, for: 5_000 });
/** Each check starts the same: Alex's app recipe-box on his computer c_a, Ingot set up there, nothing on Orgo yet. */
function fresh() {
  for (const c of web.calls) if (c.body && typeof c.body.password === "string") sentToOrgo.add(c.body.password);
  H.previewWatchForTests.stopAll();
  slow();
  shares.length = 0;
  shareAnswers.length = 0;
  Object.assign(web, { projects: [], urls: [], calls: [], old: false, refuse: false, unavailable: false, readOnly: false, hashOnly: false, young: false });
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
/** Until `ok()` holds (polled), or fail after `ms`. */
async function until(ok, what = "it", ms = 3_000) {
  for (const end = Date.now() + ms; !(await ok()); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Every watch of a Preview deploy done, and every post to Bops Cloud settled. */
const watched = async () => {
  await until(() => H.previewWatchForTests.now().size === 0, "the watches to end");
  await Share.previewShareForTests.settled();
};
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

await check("Bops Cloud's rule for a Preview password (cloud/protocol.ts) is newPassword's: the same 56 characters, the same length, a letter and a digit, and nothing else", async () => {
  assert.equal(P.PREVIEW_PASSWORD_LENGTH, H.PASSWORD_LENGTH);
  assert.equal(P.PREVIEW_PASSWORD_ABC, "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"); // gitleaks:allow (an alphabet, not a key)
  for (let i = 0; i < 2000; i++) assert.match(H.newPassword(), P.PREVIEW_PASSWORD);
  // Every character the alphabet has, and none it hasn't, in a password that's otherwise fine.
  for (let c = 0x20; c < 0x7f; c++) {
    const ch = String.fromCharCode(c);
    assert.equal(P.PREVIEW_PASSWORD.test(`a2${ch}bcde`), P.PREVIEW_PASSWORD_ABC.includes(ch), JSON.stringify(ch));
  }
  for (const bad of ["a2bcde", "a2bcdefg", "abcdefg", "2345678", "a2bcde0", "a2bcdeO", "a2bcdel", "a2bcdeI", "a2bcde1", "a2bcdeo", "a2 bcde", "a2bcde\n", "", "Kq7mZ3x".repeat(10)]) assert.doesNotMatch(bad, P.PREVIEW_PASSWORD, JSON.stringify(bad));
  assert.match("Kq7mZ3x", P.PREVIEW_PASSWORD);
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
  await Share.previewShareForTests.settled();
  assert.deepEqual(shares, [{ ws: "ws_main", app: "recipe-box", site: "recipe-box", url: `https://${link.label}.orgo.dev`, password: link.password }], "shared with Bops Cloud, exactly as it went to Orgo");
  assert.deepEqual([...H.previewWatchForTests.now().values()], [previewProject().deployments.at(-1).id], "its deploy watched until it's live");
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
  await Share.previewShareForTests.settled();
  assert.equal(shares.at(-1).password, previewLink().password, "the first one, shared");
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

await check("a password Orgo turned down isn't asked for again in a loop: once (the same one sent twice, as a 5xx may have made it), then again only after a few minutes", async () => {
  web.refuse = true;
  await deployPreview();
  const sent = passwordCalls();
  assert.equal(sent.length, 2, "tried with the new link, the same one again once");
  assert.equal(sent[0].body.password, sent[1].body.password, "the very same password: setting it again is harmless");
  for (let i = 0; i < 3; i++) assert.equal((await list()).preview.protected, false);
  assert.equal(passwordCalls().length, 2, "not again on each read");
  await Share.previewShareForTests.settled();
  assert.equal(shares.length, 0, "nothing Orgo turned down is shared");
  // (A few minutes later.)
  globalThis.bopsPasswordRefused.clear();
  web.refuse = false;
  assert.equal((await list()).preview.protected, true);
  assert.equal(passwordCalls().length, 3);
});

await check("a set Orgo answered 5xx (or didn't answer) but made all the same: the same password again, then that one shared, on a deploy and on New", async () => {
  // Orgo makes the first one, then answers 502 as if it hadn't.
  let lose = 1;
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const res = await real(input, init);
    const req = new Request(input, init);
    if (lose > 0 && req.method === "PATCH" && /\/public-urls\/[^/]+$/.test(new URL(req.url).pathname)) {
      lose--;
      return json({ error: "Bad gateway" }, 502);
    }
    return res;
  };
  try {
    await deployPreview();
    const sent = passwordCalls();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body.password, sent[0].body.password);
    await Share.previewShareForTests.settled();
    assert.deepEqual(shares.map((x) => x.password), [previewLink().password], "shared: what the link has");
    lose = 1;
    const r = await passPost({ action: "new" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(previewLink().password, r.body.password);
    await Share.previewShareForTests.settled();
    assert.equal(shares.at(-1).password, r.body.password);
    // A refusal that says Orgo did nothing (400, 403, 503 PASSWORD_UNAVAILABLE) is never sent again.
    web.unavailable = true;
    const n = web.calls.length;
    assert.equal((await passPost({ action: "new" })).status, 409);
    assert.equal(passwordCalls(n).length, 1);
  } finally {
    globalThis.fetch = real;
  }
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
  await Share.previewShareForTests.settled();
  assert.deepEqual(shares.at(-1), { ws: "ws_main", app: "recipe-box", site: "recipe-box", url: `https://${label}.orgo.dev`, password: r.body.password }, "the new one, shared");
  await passPost({ action: "off" });
  const again = await passPost({ action: "new" });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "Its password is off. Turn it on first.");
});

/* ---------------- A new one with each Preview deploy that goes live ---------------- */

await check("a read of the link sets only a first password: never a new one because another deploy went live, on the Apps page, the window's read or a Preview made", async () => {
  await deployPreview("succeeded");
  H.previewWatchForTests.stopAll();
  await list();
  const first = previewLink().password;
  const n = web.calls.length;
  const m = shares.length;
  // Another deploy went live that this Bops never watched (a bot's computer deployed it, or this Bops quit before it was live).
  const pv = previewProject();
  pv.deployments.push({ id: randomUUID(), project_id: pv.id, state: "succeeded", source_version: HEAD, created_at: iso(), finished_at: iso() });
  for (let i = 0; i < 3; i++) await list();
  await passGet();
  await act({ action: "preview" });
  assert.equal(passwordCalls(n).length, 0, "no new one from a read");
  assert.equal(previewLink().password, first);
  assert.equal(shares.length, m, "nothing new to share");
  // A link found with none (turned off on Orgo's own pages, say) gets one on the next read, as ever.
  previewLink().password = null;
  await list();
  assert.equal(passwordCalls(n).length, 1);
  assert.match(previewLink().password, SHAPE);
});

await check("a Preview deploy this Bops queued gets a new password once, as it goes live, and shares exactly that one; still on its way, failed or stopped, none; a Published deploy never touches it; a site that's off is skipped", async () => {
  fast();
  await deployPreview();
  // Still queued, then running: watched, nothing set.
  let n = web.calls.length;
  await sleep(40);
  assert.equal(passwordCalls(n).length, 0, "not while it's queued");
  ends(previewProject(), "running");
  await sleep(40);
  assert.equal(passwordCalls(n).length, 0, "nor while it runs");
  assert.equal(H.previewWatchForTests.now().size, 1);
  const before = previewLink().password;
  const beforeAt = record().passwordSet.at;
  const m = shares.length;
  await sleep(5);
  ends(previewProject(), "succeeded");
  await watched();
  const sent = passwordCalls(n);
  assert.equal(sent.length, 1, "once, as it went live");
  const now = previewLink().password;
  assert.notEqual(now, before);
  assert.equal(sent[0].body.password, now);
  assert.equal(record().passwordSet.live, previewProject().deployments.at(-1).id, "set for that deploy");
  assert.ok(record().passwordSet.at > beforeAt);
  assert.deepEqual(shares.slice(m), [{ ws: "ws_main", app: "recipe-box", site: "recipe-box", url: `https://${previewLink().label}.orgo.dev`, password: now }], "shared: exactly what went to Orgo");
  assert.equal((await passGet()).body.password, now, "the window reads the new one");
  const app = await list();
  assert.equal(app.preview.passwordAt, record().passwordSet.at, "a window holding the old one reads it again");
  n = web.calls.length;
  await list();
  assert.equal(passwordCalls(n).length, 0, "once a deploy");
  // Failed: none, nothing shared.
  const k = shares.length;
  await deployPreview();
  await sleep(20);
  ends(previewProject(), "failed");
  await watched();
  // Stopped (cancelled, or replaced by a newer one): the same.
  await deployPreview("cancelled");
  await watched();
  await deployPreview("superseded");
  await watched();
  assert.equal(passwordCalls(n).length, 0, "none for a deploy that never went live");
  assert.equal(shares.length, k);
  assert.equal(previewLink().password, now);
  // Published goes live (a Publish, an Apply variables): its project isn't the Preview's, so nothing.
  const prod = prodProject();
  prod.deployments.push({ id: randomUUID(), project_id: prod.id, state: "succeeded", source_version: HEAD, created_at: iso(), finished_at: iso() });
  await list();
  assert.equal(passwordCalls(n).length, 0, "a Published deploy never touches it");
  // Turned off: shared as none, and a deploy that goes live sets none.
  await passPost({ action: "off" });
  await Share.previewShareForTests.settled();
  assert.equal(shares.at(-1).password, null);
  n = web.calls.length;
  const j = shares.length;
  await deployPreview("succeeded");
  await watched();
  await list();
  await passGet();
  assert.equal(passwordCalls(n).length, 0, "skipped while it's off");
  assert.equal(shares.length, j);
  assert.equal(previewLink().password, null);
});

await check("a newer Preview deploy takes over from an older one's watch: only the newer one, once live, gets a new password; an older one live first gets none", async () => {
  fast();
  await deployPreview("succeeded");
  await watched();
  const pv = () => previewProject();
  await deployPreview();
  const older = pv().deployments.at(-1);
  await deployPreview();
  const newer = pv().deployments.at(-1);
  assert.deepEqual([...H.previewWatchForTests.now().values()], [newer.id], "one watch a project: the newest deploy's");
  const n = web.calls.length;
  const m = shares.length;
  // The older one goes live first (Orgo built it before the newer one came): no watch is for it.
  older.state = "succeeded";
  older.finished_at = iso();
  await sleep(40);
  assert.equal(passwordCalls(n).length, 0, "none for the older one");
  newer.state = "succeeded";
  newer.finished_at = iso();
  await watched();
  assert.equal(passwordCalls(n).length, 1, "once, for the newer one");
  assert.equal(record().passwordSet.live, newer.id);
  assert.equal(shares.length, m + 1);
  assert.equal(shares.at(-1).password, previewLink().password);
  // A newer one live while this one's watch still runs (another Bops queued it, after this one): this one's ends with none.
  await deployPreview();
  const k = web.calls.length;
  const mine = pv().deployments.at(-1);
  mine.state = "succeeded";
  pv().deployments.push({ id: randomUUID(), project_id: pv().id, state: "succeeded", source_version: HEAD, created_at: iso(), finished_at: iso() });
  await watched();
  assert.equal(passwordCalls(k).length, 0, "this one's watch ends with none: the newer one's Bops sets it");
});

await check("a Preview rollback gets a new password once the release it puts back is live", async () => {
  fast();
  await deployPreview("succeeded");
  await watched();
  await deployPreview("succeeded");
  await watched();
  const pv = previewProject();
  const back = pv.deployments.at(-2);
  back.can_rollback = true;
  const n = web.calls.length;
  const r = await act({ action: "rollback", deployment: back.id, env: "preview" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rb = pv.deployments.at(-1);
  assert.equal(rb.trigger, "rollback");
  await sleep(30);
  assert.equal(passwordCalls(n).length, 0, "not before it's live");
  rb.state = "succeeded";
  rb.finished_at = iso();
  await watched();
  assert.equal(passwordCalls(n).length, 1);
  assert.equal(record().passwordSet.live, rb.id);
  assert.equal(shares.at(-1).password, previewLink().password);
});

await check("a link just made is left to the Bops that made it: it sets one at once, and a read (the Apps page, the window's) sets none for its first minute", async () => {
  web.young = true;
  await deployPreview();
  assert.equal(passwordCalls().length, 1, "the Bops that made it set one at once");
  assert.match(previewLink().password, SHAPE);
  // As another Bops sees a link just made whose first password isn't set yet.
  previewLink().password = null;
  S.update((s) => void delete s.workspaces[0].hostedApps["recipe-box"].passwordSet);
  const n = web.calls.length;
  const m = shares.length;
  assert.equal((await list()).preview.protected, false);
  await passGet();
  assert.equal(passwordCalls(n).length, 0, "none set by a read while it's just made");
  // A minute on: a read sets one, as for any link found without one.
  previewLink().created_at = new Date(Date.now() - 61_000).toISOString();
  assert.equal((await list()).preview.protected, true);
  assert.equal(passwordCalls(n).length, 1);
  await Share.previewShareForTests.settled();
  assert.deepEqual(shares.slice(m).map((x) => x.password), [previewLink().password]);
});

await check("a deploy going live never sets a password on a link that has none while this Bops's record says one was set (turned off on another of the owner's Bops, its choice not here yet), nor shares one", async () => {
  fast();
  await deployPreview("succeeded");
  await watched();
  await deployPreview();
  // Off on the owner's other Mac: Orgo has none now, and Bops Cloud none; this Bops's record still says one was set.
  previewLink().password = null;
  assert.ok(record().passwordSet && !record().passwordOff);
  const n = web.calls.length;
  const m = shares.length;
  ends(previewProject(), "succeeded");
  await watched();
  assert.equal(passwordCalls(n).length, 0, "no rotation onto a link with none");
  assert.equal(shares.length, m, "nothing shared that would put Bops Cloud's copy back");
  assert.equal(previewLink().password, null);
});

await check("a Preview whose first password never went through gets one as its deploy goes live; a rotation Orgo didn't take is tried again at a later look, once taken shared once; an Orgo that can't take one ends the watch", async () => {
  fast();
  // Its first set failed (Orgo answered 503 twice): nothing kept, the link public, a refusal noted for a few minutes.
  web.refuse = true;
  await deployPreview();
  assert.equal(passwordCalls().length, 2);
  assert.equal(record().passwordSet, undefined);
  assert.equal(previewLink().password, null);
  web.refuse = false;
  ends(previewProject(), "succeeded");
  await watched();
  assert.match(previewLink().password ?? "", SHAPE, "set as it went live, the few minutes not waited out");
  assert.equal(record().passwordSet.live, previewProject().deployments.at(-1).id);
  assert.deepEqual(shares.map((x) => x.password), [previewLink().password]);
  // The next deploy goes live while Orgo answers 503: tried again at later looks, until it takes one.
  await deployPreview();
  const was = previewLink().password;
  web.refuse = true;
  const n = web.calls.length;
  const m = shares.length;
  ends(previewProject(), "succeeded");
  await until(() => passwordCalls(n).length >= 4, "two looks that Orgo turned down");
  assert.equal(H.previewWatchForTests.now().size, 1, "still watched");
  assert.equal(previewLink().password, was);
  web.refuse = false;
  await watched();
  assert.notEqual(previewLink().password, was);
  assert.equal(record().passwordSet.live, previewProject().deployments.at(-1).id);
  assert.deepEqual(shares.slice(m).map((x) => x.password), [previewLink().password], "shared once, what Orgo took");
  // An Orgo that can't take one (503 PASSWORD_UNAVAILABLE): asked once, the watch ends.
  await deployPreview();
  web.unavailable = true;
  const k = web.calls.length;
  ends(previewProject(), "succeeded");
  await watched();
  assert.equal(passwordCalls(k).length, 1);
});

await check("each site has its own: a new link for each, a deploy of one renews only its own, off for one leaves the other", async () => {
  fast();
  S.update((s) => void (s.workspaces[0].hostedApps["recipe-box"].sites = [{ name: "recipe-admin" }]));
  await deployPreview();
  assert.equal(H.previewWatchForTests.now().size, 2, "each site's deploy watched on its own");
  ends(previewProject(), "succeeded");
  ends(previewProject("recipe-admin"), "succeeded");
  await watched();
  await list();
  const own = previewLink().password;
  const admin = previewLink("recipe-admin").password;
  assert.match(own, SHAPE);
  assert.match(admin, SHAPE);
  assert.notEqual(own, admin);
  assert.ok(record().sites[0].passwordSet, "kept on the site's own record");
  assert.deepEqual(Object.fromEntries(["recipe-box", "recipe-admin"].map((x) => [x, shares.filter((y) => y.site === x).at(-1)?.password])), { "recipe-box": own, "recipe-admin": admin }, "each shared as its own site's");
  const r = await act({ action: "deploy", env: "preview", site: "recipe-admin" });
  assert.equal(r.status, 200);
  ends(previewProject("recipe-admin"), "succeeded");
  await watched();
  await list();
  assert.equal(previewLink().password, own, "the app's own site keeps its");
  assert.notEqual(previewLink("recipe-admin").password, admin);
  assert.equal(shares.at(-1).site, "recipe-admin");
  assert.equal(shares.at(-1).password, previewLink("recipe-admin").password);
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
  fast();
  const said = await H.deployForBot("boppy", "recipe-box", null);
  hear(said);
  const first = previewLink().password;
  // Its deploy goes live: a new one, which the bot never has either.
  ends(previewProject(), "succeeded");
  await watched();
  const pw = previewLink().password;
  assert.notEqual(pw, first);
  assert.equal(said.includes(first), false);
  assert.match(said, /It asks for a password, a new one once this deploy is live, shown beside its Preview link in Bops\./);
  assert.equal(said.includes(pw), false);
  const note = H.hostedAppsLine("boppy");
  hear(note);
  assert.match(note, /It asks for a password unless Alex turned it off \(Alex sees it beside the Preview link in Bops; you never have it, so never write one in this chat or ask for it\)\./);
  assert.match(note, /Never open a Preview link to check it \(its password page answers 401\): check your work on Local\./);
  assert.equal(note.includes(pw), false);
  await passPost({ action: "off" });
  assert.match(H.hostedAppsLine("boppy"), /preview at https:\/\/[a-z0-9]{12}\.orgo\.dev, with no password;/);
  const chat = readFileSync(`${root}/lib/server/chat.ts`, "utf8");
  assert.match(chat, /It asks for a password \(a new one with each deploy\) unless \$\{owner\} turned that off: \$\{owner\} sees it beside the Preview link in Bops, and you never have it, so never write one in this chat; check your work on Local\./);
  const skills = readFileSync(`${root}/lib/builtin-skills.ts`, "utf8");
  assert.match(skills, /You never have it: never write a password in the chat or ask for it/);
  assert.equal(JSON.stringify(S.getState().messages).includes(pw), false);
  assert.equal(JSON.stringify(S.getState().messages).includes(first), false);
  const again = await H.deployForBot("boppy", "recipe-box", null);
  hear(again);
  for (const x of [first, pw]) assert.equal(again.includes(x) || H.hostedAppsLine("boppy").includes(x), false);
});

/* ---------------- Shared with Bops Cloud ---------------- */

await check("New, on and off share with Bops Cloud: the new password, exactly as Orgo has it, or none once it's off", async () => {
  await deployPreview("succeeded");
  const url = `https://${previewLink().label}.orgo.dev`;
  const at = (n) => shares.slice(n);
  let n = shares.length;
  const fresh1 = await passPost({ action: "new" });
  await Share.previewShareForTests.settled();
  assert.deepEqual(at(n), [{ ws: "ws_main", app: "recipe-box", site: "recipe-box", url, password: fresh1.body.password }]);
  assert.equal(previewLink().password, fresh1.body.password);
  n = shares.length;
  await passPost({ action: "off" });
  await Share.previewShareForTests.settled();
  assert.deepEqual(at(n), [{ ws: "ws_main", app: "recipe-box", site: "recipe-box", url, password: null }]);
  n = shares.length;
  const on = await passPost({ action: "on" });
  await Share.previewShareForTests.settled();
  assert.deepEqual(at(n), [{ ws: "ws_main", app: "recipe-box", site: "recipe-box", url, password: on.body.password }]);
  assert.equal(previewLink().password, on.body.password);
  // A change Orgo turned down shares nothing.
  web.unavailable = true;
  n = shares.length;
  assert.equal((await passPost({ action: "new" })).status, 409);
  await Share.previewShareForTests.settled();
  assert.equal(shares.length, n);
});

await check("one site's posts to Bops Cloud go one at a time, in order, a newer one in place of one not sent yet; one not taken is sent again for about 20 minutes (a 401 once more); a body it can't take, or another account's, isn't", async () => {
  const body = (password, site = "recipe-box") => ({ ws: "ws_main", app: "recipe-box", site, url: "https://k7p2qxm4wr3d.orgo.dev", password });
  // The real waits: 10 tries over about 20 minutes, each wait no shorter than the one before.
  const waits = Share.previewShareForTests.waits();
  assert.equal(waits.length + 1, 10);
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(total >= 18 * 60_000 && total <= 21 * 60_000, `${total / 60_000} minutes`);
  assert.ok(waits.every((w, i) => i === 0 || w >= waits[i - 1]));
  // (Here: two waits of a few milliseconds, so three tries.)
  shareAnswers.push(0, 503);
  assert.equal(await Share.sharePreviewPassword(body("Ab3cdef")), true, "taken on the third try");
  assert.equal(shares.length, 3);
  shares.length = 0;
  shareAnswers.push(403);
  assert.equal(await Share.sharePreviewPassword(body("Ab3cdeq")), true, "a new app's record landed in between");
  assert.equal(shares.length, 2);
  shares.length = 0;
  shareAnswers.push(401);
  assert.equal(await Share.sharePreviewPassword(body("Ab3cdem")), true, "a 401 once more: a runner's next credential");
  assert.equal(shares.length, 2);
  shares.length = 0;
  shareAnswers.push(401, 401);
  assert.equal(await Share.sharePreviewPassword(body("Ab3cden")), false, "but not twice");
  assert.equal(shares.length, 2);
  for (const status of [400, 409]) {
    shares.length = 0;
    shareAnswers.push(status);
    assert.equal(await Share.sharePreviewPassword(body("Ab3cdeg")), false);
    assert.equal(shares.length, 1, `${status}: not sent again`);
  }
  shares.length = 0;
  shareAnswers.push(0, 0, 0);
  assert.equal(await Share.sharePreviewPassword(body("Ab3cdeh")), false);
  assert.equal(shares.length, 3, "never answered: every try, then no more");
  const order = [];
  let open;
  const held = new Promise((r) => (open = r));
  try {
    Share.previewShareForTests.send(async (b) => {
      order.push(`start ${b.password}`);
      if (b.password === "Ab3cdei") await held;
      order.push(`end ${b.password}`);
      return 204;
    });
    const a = Share.sharePreviewPassword(body("Ab3cdei"));
    const b = Share.sharePreviewPassword(body("Ab3cdej"));
    const c = Share.sharePreviewPassword(body("Ab3cdes"));
    const other = Share.sharePreviewPassword(body("Ab3cdek", "recipe-admin"));
    // The owner's Mac's check of Bops Cloud's copy, while this site's shares are going: dropped (they're as new).
    const check = Share.sharePreviewPassword({ ...body("Ab3cdet"), seen: 5 });
    await sleep(20);
    assert.deepEqual(order, ["start Ab3cdei", "start Ab3cdek", "end Ab3cdek"], "the site's next waits for the one going; another site's doesn't");
    assert.equal(await check, false);
    open();
    assert.deepEqual(await Promise.all([a, b, c, other]), [true, false, true, true], "the one waiting gave way to the newest");
    assert.deepEqual(order.slice(3), ["end Ab3cdei", "start Ab3cdes", "end Ab3cdes"], "then the newest, never the older after it");
    // One waiting between tries: a newer one goes at once in its place.
    Share.previewShareForTests.retryMs([60_000]);
    order.length = 0;
    let first = true;
    Share.previewShareForTests.send(async (x) => (order.push(x.password), first ? ((first = false), 0) : 204));
    const old = Share.sharePreviewPassword(body("Ab3cdeu"));
    await sleep(10);
    const t0 = Date.now();
    assert.deepEqual(await Promise.all([old, Share.sharePreviewPassword(body("Ab3cdev"))]), [false, true]);
    assert.ok(Date.now() - t0 < 5_000, "without waiting out the minute");
    assert.deepEqual(order, ["Ab3cdeu", "Ab3cdev"]);
  } finally {
    Share.previewShareForTests.send(recordShare);
    Share.previewShareForTests.retryMs([5, 5]);
  }
});

await check("a post is for the account whose state it was set in: that account named to Bops Cloud on each try, and dropped once another account's state is here", async () => {
  let who = "u_alex";
  const users = [];
  try {
    Share.previewShareForTests.user(() => who);
    Share.previewShareForTests.send(async (b, user) => (users.push(user), shares.push(structuredClone(b)), 0));
    Share.previewShareForTests.retryMs([40]);
    const p = Share.sharePreviewPassword({ ws: "ws_main", app: "recipe-box", site: "recipe-box", url: "https://k7p2qxm4wr3d.orgo.dev", password: "Ab3cdew" });
    await sleep(10);
    // Signed out, and another account signed in on this Bops, before its next try.
    who = "u_other";
    assert.equal(await p, false);
    assert.deepEqual(users, ["u_alex"], "sent once, as Alex's; never on the other account's sign in");
  } finally {
    Share.previewShareForTests.user();
    Share.previewShareForTests.send(recordShare);
    Share.previewShareForTests.retryMs([5, 5]);
  }
  // On the wire (Bops Cloud, signed in): POST /v1/apps/preview-password on the sign in, the account in x-bops-user, the body alone.
  const was = { self: process.env.BOPS_SELF_HOSTED, url: process.env.BOPS_CLOUD_URL };
  try {
    process.env.BOPS_SELF_HOSTED = "0";
    process.env.BOPS_CLOUD_URL = CLOUD;
    Share.previewShareForTests.send();
    Share.previewShareForTests.user(() => "u_alex");
    const sent = { ws: "ws_main", app: "recipe-box", site: "recipe-box", url: "https://k7p2qxm4wr3d.orgo.dev", password: "Ab3cdex" };
    assert.equal(await Share.sharePreviewPassword(sent), true);
    assert.deepEqual(cloudGot, [{ method: "POST", path: P.PREVIEW_PASSWORD_PATH, user: "u_alex", auth: `Bearer ${KEY}`, body: sent }]);
    everShared.add(sent.password);
  } finally {
    process.env.BOPS_SELF_HOSTED = was.self;
    if (was.url === undefined) delete process.env.BOPS_CLOUD_URL;
    else process.env.BOPS_CLOUD_URL = was.url;
    Share.previewShareForTests.user();
    Share.previewShareForTests.send(recordShare);
  }
});

/* ---------------- The owner's Mac puts Bops Cloud's copy right ---------------- */

await check("the owner's Mac, reading Orgo for members, tells Bops Cloud what Orgo has where its copy for that link is another and older than the read (only over the entry it saw); never over a fresh one, one the same, or one for another link; none for a link that asks for none", async () => {
  const F = await import(`${root}/lib/server/apps-for-members.ts`);
  const GRACE = F.CLOUD_FIX_AFTER_MS;
  const orgo = { on: true, password: "Nw3pass" };
  let asked = 0;
  const readers = (url, protectedNow = true) => ({
    list: async () => ({
      apps: [{ name: "recipe-box", head: null, updatedAt: 1, hosting: { botId: "boppy", computerId: "c_a" }, serving: null, live: null, domain: null, preview: { projectId: "p1", url, label: "x", serving: null, live: null, protected: protectedNow, passwordAt: undefined } }],
    }),
    commits: async () => ({ commits: [], head: null, next: null }),
    settings: async () => ({ url: null, settings: null, env: [], deploys: [] }),
    owned: async () => ({ buy: { open: true }, owned: [], contact: null }),
    password: async () => (asked++, { url, on: orgo.on, password: orgo.on ? orgo.password : null, cookie: null }),
  });
  const cloudHas = (url, password, at) => S.update((s) => void (s.workspaces[0].previewPasswords = { "recipe-box/recipe-box": { url, password, at } }));
  S.update((s) => void (s.workspaces[0].memberAccess = { "sam@example.com": { others: "none", bots: {}, apps: "write", at: 1 } }));
  const see = async (url, protectedNow) => {
    await F.seeApps("ws_main", undefined, readers(url, protectedNow));
    await Share.previewShareForTests.settled();
  };
  try {
    // Older than the read by more than the grace, and another: told, over the entry it saw.
    const old = Date.now() - GRACE - 60_000;
    cloudHas("https://aaaa2222bbbb.orgo.dev", "Old2pas", old);
    await see("https://aaaa2222bbbb.orgo.dev");
    assert.deepEqual(shares, [{ ws: "ws_main", app: "recipe-box", site: "recipe-box", url: "https://aaaa2222bbbb.orgo.dev", password: "Nw3pass", seen: old }]);
    shares.length = 0;
    // The same as Orgo's: nothing.
    cloudHas("https://cccc3333dddd.orgo.dev", "Nw3pass", old);
    await see("https://cccc3333dddd.orgo.dev");
    // For another link: nothing (it's never shown anyway).
    cloudHas("https://eeee4444ffff.orgo.dev", "Old2pas", old);
    await see("https://gggg5555hhhh.orgo.dev");
    // Fresh (a share that may have come after the read began): nothing, and no read again for it until it's old enough.
    const fresh = Date.now() - 10_000;
    cloudHas("https://jjjj6666kkkk.orgo.dev", "Fr4shpw", fresh);
    await see("https://jjjj6666kkkk.orgo.dev");
    assert.deepEqual(shares, [], "nothing told for the same, another link, or a fresh copy");
    const n = asked;
    await see("https://jjjj6666kkkk.orgo.dev");
    assert.equal(asked, n, "the read kept stands");
    assert.deepEqual(shares, []);
    // Minutes on, that copy still another: Orgo read again (the read kept is from before it was old enough), and it's told.
    const realNow = Date.now;
    Date.now = () => realNow() + GRACE + 60_000;
    try {
      await see("https://jjjj6666kkkk.orgo.dev");
    } finally {
      Date.now = realNow;
    }
    assert.equal(asked, n + 1, "read again");
    assert.deepEqual(shares, [{ ws: "ws_main", app: "recipe-box", site: "recipe-box", url: "https://jjjj6666kkkk.orgo.dev", password: "Nw3pass", seen: fresh }]);
    shares.length = 0;
    // A link that asks for none now (turned off where its share never got there): Bops Cloud's old copy goes, over the entry seen.
    cloudHas("https://mmmm7777nnnn.orgo.dev", "Old2pas", old);
    await see("https://mmmm7777nnnn.orgo.dev", false);
    assert.deepEqual(shares, [{ ws: "ws_main", app: "recipe-box", site: "recipe-box", url: "https://mmmm7777nnnn.orgo.dev", password: null, seen: old }]);
    shares.length = 0;
    // Nobody at Write: nothing told (Bops Cloud shows it to nobody).
    S.update((s) => void (s.workspaces[0].memberAccess = { "sam@example.com": { others: "none", bots: {}, apps: "read", at: 1 } }));
    cloudHas("https://pppp8888qqqq.orgo.dev", "Old2pas", old);
    await see("https://pppp8888qqqq.orgo.dev");
    assert.deepEqual(shares, []);
  } finally {
    S.update((s) => {
      delete s.workspaces[0].memberAccess;
      delete s.workspaces[0].previewPasswords;
      delete s.workspaces[0].appsForMembers;
    });
  }
});

/* ---------------- Logs ---------------- */

await check("no log line carries a password: none Orgo was sent, none shared", async () => {
  const all = new Set([...sentToOrgo, ...everShared]);
  assert.ok(all.size > 10, "the checks above set plenty");
  for (const line of logged) for (const p of all) assert.equal(line.includes(p), false, line.slice(0, 200));
});

/* ---------------- Words ---------------- */

await check("nothing a person or a bot reads here has a dash", async () => {
  for (const words of heard) assert.doesNotMatch(words.replace(/https?:\/\/\S+|[0-9a-f]{8}-[0-9a-f-]{27}|"[a-z]+-[a-z-]+"|recipe-(box|admin)|__Host-orgo_pass|\/api\/\S+/g, ""), /[-‐-―]/, words.slice(0, 200));
  const src = readFileSync(`${root}/components/app/preview-password.tsx`, "utf8");
  for (const [, s] of src.matchAll(/>([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g)) assert.doesNotMatch(s, /[‐-―]| - /, s);
  for (const [, s] of src.matchAll(/"([A-Z][^"]*[a-z.?][^"]*)"/g)) assert.doesNotMatch(s, /[‐-―]| - /, s);
});

rmSync(scratch, { recursive: true, force: true });
clearInterval(awake);
console.log(`preview password: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
