// Tests for the keeper on a Bops computer (vm/bin/bops-runner-keeper.mjs): what it reads (keeper.json, its state, the
// pin and off markers), the computer's identity (its VMM, over node:http as the runner asks: refused, none), a copy of a
// computer starting afresh, what Orgo says (the account's bots on the Mac, a key on a computer someone else can use,
// not a Bops computer), the newest release (signed with a key built in: never one from the environment or a file),
// Bops Cloud's answer, and the install or update itself: the bundle downloaded and checked (a sha256 that doesn't match
// is deleted), never the same or an older version, busy between turns, the start script from keeper.json and the
// identity, the build before kept, the health check (healthy, a first one stopped, an update rolled back and the build
// marked failed and skipped, not judged while Bops Cloud doesn't answer), the flapping guard, when it looks (the look
// file, a clock jump, its own schedule), and its log (words only: never the token, an address or a body). Then what puts
// it on a computer: the runner (lib/server/runner-keeper.ts ensureKeeper) and the template (orgo/bops-base.mjs), and its
// release checks against Bops Cloud's (cloud/runner-release.ts).
//
// Orgo, its VMM, Bops Cloud and the release site are fakes on this machine; the computer is a folder standing in for its
// root, its supervisorctl a stand-in that writes down what it's asked, and the health check's answer is said by each
// test. The install script, the rollback and the key line run as sh on that folder (Linux: GNU mv -T, flock, sha256sum).
// Every key is made at run time. Usage: node --conditions=react-server scripts/test-runner-keeper.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { unfaked } from "./fake-exports.mjs";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const FAKES = { "orgo-auth": ["orgoOrigin"] };
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
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
    return { format: "module", shortCircuit: true, source: FAKES[name].map((n) => `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(name)}].${n}(...a);`).join("\n") + unfaked(name, url, FAKES[name]) };
  },
});
globalThis.__fake = { "orgo-auth": { orgoOrigin: () => "https://orgo.example" } };

const K = await import(`${root}/vm/bin/bops-runner-keeper.mjs`);
const STEPS = await import(`${root}/vm/runner-steps.mjs`);

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 8).join("\n  ") ?? e.message}`);
  }
}

const linux = process.platform === "linux" && ["flock", "sha256sum", "tar", "sh"].every((t) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0);

/* ---------------- Fakes: keys, releases, bundles ---------------- */

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const KEYS = { t1: publicKey.export({ type: "spki", format: "pem" }).toString() };
const PEM = KEYS.t1;
const DESKTOP = "0d3f6b1e-2c4a-4f8e-9b7d-5a6c8e1f2a3b";
const OTHER = "7c1e9a2b-4d6f-4a8c-b2e0-3f5d7a9c1e2b";
const TOKEN = "orgo_vm_test-token-made-up-for-this-test-0123456789"; // gitleaks:allow (made up for this test)
const CFG = { orgo: "https://orgo.example", cloud: "https://bops.example/api", releases: "https://dl.example/runner/" };

/** A bundle on disk: a tgz with a server.js on top, its bytes, sha256 and size. */
const scratch = mkdtempSync(join(tmpdir(), "bops-keeper-"));
function bundle(version, buildId, extra = "") {
  const src = mkdtempSync(join(scratch, "src-"));
  writeFileSync(join(src, "server.js"), `// the server ${version}-${buildId}${extra}\n`);
  const name = `bops-server-${version}-${buildId}.tgz`;
  const tgz = join(scratch, `${name}.${Math.random().toString(36).slice(2)}`);
  spawnSync("tar", ["-czf", tgz, "-C", src, "."]);
  const bytes = readFileSync(tgz);
  return { name, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, version, buildId };
}
/** latest.json for a release of `b` (any fields changed by `more`), signed with `key` as `keyId`. */
function latestJson(b, more = {}, o = {}) {
  const payload = JSON.stringify({ kind: "bops-runner", version: b.version, buildId: b.buildId, name: b.name, sha256: b.sha256, size: b.size, released: "2026-11-19T10:00:00.000Z", stateLevel: 4, ...more });
  return JSON.stringify({ payload, sig: sign(null, Buffer.from(payload), o.key ?? privateKey).toString("base64"), keyId: o.keyId ?? "t1" });
}

/* ---------------- Fakes: the VMM ---------------- */

const vmm = { status: 200, desktop: DESKTOP, asked: [] };
const vmmServer = createServer((req, res) => {
  vmm.asked.push({ path: req.url, flavor: req.headers["metadata-flavor"], proxy: req.headers["proxy-authorization"] });
  if (vmm.status !== 200) return void res.writeHead(vmm.status, { "content-type": "application/json" }).end(JSON.stringify({ error: "no" }));
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: TOKEN, expires_in: 3600, desktop_id: vmm.desktop, vm_id: "vm-1", user_id: "user-max", project_id: "p-1" }));
});
await new Promise((ok) => vmmServer.listen(0, "127.0.0.1", ok));
const VMM = `http://127.0.0.1:${vmmServer.address().port}`;

/* ---------------- A computer: a folder standing in for its root, and everything the keeper asks ---------------- */

/**
 * A computer with (or without) a runner of build `runner` ("0.0.55-BuildA") up, a key line or not, keeper.json, and the
 * fakes the keeper talks to: Orgo's settings, the release site, Bops Cloud (its answer to each ask, and /health), and
 * the health check's answer. `env` is the keeper's; `calls` every address it fetched; `asks` what it asked Bops Cloud.
 */
function computer(o = {}) {
  const base = mkdtempSync(join(scratch, "computer-"));
  const at = (p) => join(base, p);
  const rewrite = (s) =>
    s
      .replaceAll("/opt/bops", at("opt/bops"))
      .replaceAll("/etc/supervisor", at("etc/supervisor"))
      .replaceAll("/var/run/bops", at("var/run/bops"))
      .replaceAll("/var/log/bops", at("var/log/bops"))
      .replaceAll("/root/.", `${at("root")}/.`);
  mkdirSync(at("bin"), { recursive: true });
  mkdirSync(at("root"), { recursive: true });
  mkdirSync(at("var/log/bops"), { recursive: true });
  writeFileSync(
    at("bin/supervisorctl"),
    `#!/bin/sh\necho "$*" >> '${at("supervisorctl.log")}'\nif [ "$1" = status ]; then if [ -f '${at("running")}' ]; then echo "$2 RUNNING pid 1"; else echo "$2 STOPPED"; fi; fi\n`,
    { mode: 0o755 },
  );
  const c = {
    base,
    at,
    rewrite,
    settings: { runsOn: "cloud", computer: { shared: false, bops: true } },
    release: null,
    served: new Map(),
    answer: () => ({ do: "nothing", why: "upToDate", retryS: 3600 }),
    cloudHealth: 200,
    health: "auth=identity\n__BOPS_HEALTHY__\n",
    calls: [],
    asks: [],
    logs: [],
    sh: [],
    clock: { now: Date.now(), mono: 1_000_000 },
  };
  c.env = {
    at: (p) => (p.startsWith("/") ? join(base, p) : p),
    vmm: VMM,
    releaseKeys: KEYS,
    now: () => c.clock.now,
    mono: () => c.clock.mono,
    log: (l) => c.logs.push(l),
    sleep: async () => {},
    sh: async (script) => {
      c.sh.push(script);
      if (script === STEPS.HEALTH_SCRIPT) return { code: 0, out: typeof c.health === "function" ? c.health() : c.health };
      if (c.shOverride) {
        const got = c.shOverride(script);
        if (got) return got;
      }
      const r = spawnSync("sh", ["-c", rewrite(script)], { encoding: "utf8", env: { ...process.env, PATH: `${at("bin")}:${process.env.PATH}` } });
      return { code: r.status ?? -1, out: r.stdout };
    },
    fetch: async (url, init = {}) => {
      c.calls.push({ url, method: init.method ?? "GET", auth: init.headers?.Authorization ?? null, headers: init.headers ?? {} });
      if (url === `${CFG.orgo}/api/bops/settings`) return c.settings === null ? new Response("{}", { status: 503 }) : Response.json(c.settings);
      if (url === `${CFG.releases}latest.json`) return c.release === null ? new Response("", { status: 404 }) : new Response(c.release, { status: 200 });
      if (url.startsWith(CFG.releases) && c.served.has(url.slice(CFG.releases.length))) return new Response(c.served.get(url.slice(CFG.releases.length)), { status: 200 });
      if (url === `${CFG.cloud}/health`) return new Response("{}", { status: c.cloudHealth });
      if (url === `${CFG.cloud}/v1/runner/keeper`) {
        const ask = JSON.parse(init.body);
        c.asks.push({ ask, version: init.headers["x-bops-version"] });
        const a = c.answer(ask);
        return a === null ? new Response("", { status: 502 }) : Response.json(a);
      }
      return new Response("", { status: 404 });
    },
  };
  mkdirSync(at("opt/bops/keeper"), { recursive: true });
  writeFileSync(at("opt/bops/keeper/keeper.json"), JSON.stringify(o.config ?? CFG));
  if (o.key) writeFileSync(at("root/.env"), "ORGO_API_KEY=sk_made_up_for_this_test\n"); // gitleaks:allow (made up for this test)
  if (o.runner) runnerAt(c, o.runner, { up: o.up !== false, tz: o.tz });
  c.asked = () => (existsSync(at("supervisorctl.log")) ? readFileSync(at("supervisorctl.log"), "utf8").trim().split("\n") : []);
  c.builds = () => readdirSync(at("opt/bops/runner")).filter((f) => /^\d/.test(f)).sort();
  c.current = () => readlinkSync(at("opt/bops/runner/current"));
  c.state = () => JSON.parse(readFileSync(at("opt/bops/keeper/state.json"), "utf8"));
  c.serve = (b) => {
    c.release = latestJson(b);
    c.served.set(b.name, b.bytes);
  };
  c.done = () => rmSync(base, { recursive: true, force: true });
  return c;
}

/** A runner of build `dir` on the computer: its build, `current`, its script and its program; up or not. */
function runnerAt(c, dir, o = {}) {
  const r = (p = "") => c.at(`opt/bops/runner${p}`);
  mkdirSync(r(`/${dir}`), { recursive: true });
  writeFileSync(r(`/${dir}/server.js`), `// ${dir}\n`);
  rmSync(r("/current"), { force: true });
  symlinkSync(dir, r("/current"));
  const w = STEPS.wrapperScript({ computerId: DESKTOP, orgo: CFG.orgo, cloud: CFG.cloud, ...(o.tz ? { timeZone: o.tz } : {}) });
  writeFileSync(STEPS.RUNNER_WRAPPER.replace("/opt/bops", c.at("opt/bops")), w);
  mkdirSync(c.at("etc/supervisor/conf.d"), { recursive: true });
  writeFileSync(c.at("etc/supervisor/conf.d/bops-runner.conf"), STEPS.SUPERVISOR_CONF);
  if (o.up !== false) writeFileSync(c.at("running"), "");
}

const B55 = bundle("0.0.55", "BuildA");
const B56 = bundle("0.0.56", "BuildB");
const install = (c) => (c.answer = (ask) => ({ do: ask.runner ? "update" : "install", why: "ok", retryS: 60 }));
const ran = (c, marker) => c.sh.some((s) => s.includes(marker));

/* ---------------- Releases ---------------- */

await check("a release is one only signed with a key built in, its kind, name and size right; the bundle is checked as it comes and deleted when it isn't the release's", async () => {
  const c = computer();
  const bad = {
    "another key": latestJson(B56, {}, { key: generateKeyPairSync("ed25519").privateKey }),
    "a keyId not built in": latestJson(B56, {}, { keyId: "t2" }),
    "another kind": latestJson(B56, { kind: "bops-app" }),
    "a name not its version's": latestJson(B56, { name: B55.name }),
    "a size over 400 MB": latestJson(B56, { size: STEPS.RELEASE_MAX_SIZE + 1 }),
    "no size": latestJson(B56, { size: 0 }),
  };
  for (const [what, text] of Object.entries(bad)) {
    c.release = text;
    assert.equal(await K.latest(c.env, CFG), null, what);
  }
  c.release = latestJson(B56);
  assert.equal((await K.latest(c.env, CFG)).buildId, "BuildB");
  // Its bytes: right, then one changed (the same size), then too many.
  const r = STEPS.verifyRelease(latestJson(B56), KEYS);
  c.served.set(B56.name, B56.bytes);
  assert.equal(await K.download(c.env, CFG, r), true);
  assert.deepEqual(readFileSync(c.at(`opt/bops/runner/incoming/${B56.name}`)), B56.bytes);
  rmSync(c.at(`opt/bops/runner/incoming/${B56.name}`));
  const changed = Buffer.from(B56.bytes);
  changed[changed.length - 1] ^= 1;
  c.served.set(B56.name, changed);
  assert.equal(await K.download(c.env, CFG, r), false, "a sha256 that isn't the release's");
  assert.deepEqual(readdirSync(c.at("opt/bops/runner/incoming")), [], "deleted, nothing left half written");
  c.served.set(B56.name, Buffer.concat([B56.bytes, Buffer.from("x")]));
  assert.equal(await K.download(c.env, CFG, r), false, "more than its size");
  assert.deepEqual(readdirSync(c.at("opt/bops/runner/incoming")), []);
  c.done();
});

await check("a key in the keeper's environment or keeper.json is no key: only those built in check a release", async () => {
  const c = computer({ config: { ...CFG, keys: KEYS, releaseKeys: KEYS, key: PEM } });
  process.env.BOPS_RELEASE_KEYS = JSON.stringify(KEYS);
  process.env.BOPS_RUNNER_RELEASE_KEY = PEM;
  process.env.RELEASE_KEYS = JSON.stringify(KEYS);
  delete c.env.releaseKeys;
  c.serve(B56);
  install(c);
  const k = K.makeKeeper(c.env);
  const out = await k.look();
  assert.equal(out.did, "nothing");
  assert.equal(c.asks[0].ask.latest, null, "the release signed with a key from the environment isn't one");
  assert.ok(!c.calls.some((x) => x.url.endsWith(".tgz")), "nothing downloaded");
  assert.deepEqual(Object.keys(STEPS.RELEASE_KEYS), ["r1"], "only r1 built in");
  assert.equal(await K.readConfig(c.env).then((x) => Object.keys(x).sort().join()), "cloud,orgo,releases", "keeper.json gives only where things are");
  delete process.env.BOPS_RELEASE_KEYS;
  delete process.env.BOPS_RUNNER_RELEASE_KEY;
  delete process.env.RELEASE_KEYS;
  c.done();
});

await check("the keeper's release checks are Bops Cloud's, with the same keys built in", async () => {
  const R = await import(`${root}/cloud/runner-release.ts`);
  assert.deepEqual({ ...STEPS.RELEASE_KEYS }, { ...R.RELEASE_KEYS }, "the same keys");
  const good = JSON.parse(STEPS.verifyRelease(latestJson(B56), KEYS) ? JSON.parse(latestJson(B56)).payload : "{}");
  const cases = [
    latestJson(B56),
    latestJson(B56, { released: "2026-11-19T10:00:00Z" }),
    latestJson(B56, { released: 1_763_467_200_000 }),
    latestJson(B56, { released: "2026-11-19 10:00:00" }),
    latestJson(B56, { released: "soon" }),
    latestJson(B56, { version: "0.0.57" }),
    latestJson(B56, { version: "0.0.1234567", name: "bops-server-0.0.1234567-BuildB.tgz" }),
    latestJson(B56, { size: 1.5 }),
    latestJson(B56, { size: "12" }),
    latestJson(B56, { stateLevel: 0 }),
    latestJson(B56, { stateLevel: 10_000 }),
    latestJson(B56, { sha256: "A".repeat(64) }),
    latestJson(B56, { kind: "bops-app" }),
    latestJson(B56, { extra: true }),
    latestJson(B56, {}, { keyId: "t2" }),
    latestJson(B56, {}, { keyId: "__proto__" }),
    latestJson(B56, {}, { key: generateKeyPairSync("ed25519").privateKey }),
    JSON.stringify({ ...JSON.parse(latestJson(B56)), sig: "AAAA" }),
    JSON.stringify({ ...JSON.parse(latestJson(B56)), payload: JSON.stringify(good).replace("BuildB", "BuildC") }),
    "not json",
    "[]",
    `${latestJson(B56)}${" ".repeat(70 * 1024)}`,
  ];
  for (const text of cases) assert.deepEqual(STEPS.verifyRelease(text, KEYS), R.verifyRelease(text, KEYS, Number.POSITIVE_INFINITY), text.slice(0, 120));
  assert.ok(STEPS.verifyRelease(cases[0], KEYS), "the good one is one");
});

/* ---------------- Who it asks, and what stops it ---------------- */

await check("its identity refused waits 10 minutes, none waits 5; nothing else is asked then, and the VMM is asked as the runner asks it", async () => {
  for (const [status, did, wait] of [
    [403, "refused", 10],
    [404, "noIdentity", 5],
    [500, "noIdentity", 5],
  ]) {
    const c = computer({ runner: "0.0.55-BuildA" });
    vmm.status = status;
    vmm.asked.length = 0;
    const k = K.makeKeeper(c.env);
    const out = await k.look();
    assert.equal(out.did, did, String(status));
    assert.equal(k.k.hold, c.clock.now + wait * 60_000, `${status}: waits ${wait} minutes`);
    assert.deepEqual(c.calls, [], "neither Orgo nor Bops Cloud asked");
    assert.deepEqual(vmm.asked, [{ path: "/orgo/v1/identity/token", flavor: "Orgo", proxy: undefined }]);
    c.done();
  }
  vmm.status = 200;
});

await check("where the bots work on the Mac, a key on a computer someone else can use (or not said), or no Bops computer: it asks, and never sets one up", async () => {
  const cases = [
    { what: "the account on This Mac", settings: { runsOn: "mac", computer: { shared: false, bops: true } }, refusal: "accountMac" },
    { what: "never set (the Mac)", settings: { runsOn: null, computer: { shared: false, bops: true } }, refusal: "accountMac" },
    { what: "shared, with a key", key: true, settings: { runsOn: "cloud", computer: { shared: true, bops: true } }, refusal: "sharedKey" },
    { what: "not said, with a key", key: true, settings: { runsOn: "cloud" }, refusal: "sharedKey" },
    { what: "not a Bops computer", settings: { runsOn: "cloud", computer: { shared: false, bops: false } }, refusal: "notOnMap", hold: 6 * 3600_000 },
    { what: "Orgo not answering", settings: null, refusal: "noSettings" },
  ];
  for (const x of cases) {
    const c = computer({ key: x.key });
    c.settings = x.settings;
    c.serve(B56);
    install(c);
    const k = K.makeKeeper(c.env);
    const out = await k.look();
    assert.equal(out.did, "nothing", x.what);
    assert.equal(out.refusal, x.refusal, x.what);
    assert.ok(c.asks.length >= 1, `${x.what}: Bops Cloud is still asked`);
    assert.equal(c.asks[0].ask.key, !!x.key, x.what);
    assert.ok(!ran(c, "__BOPS_INSTALLED__") && !c.calls.some((y) => y.url.endsWith(".tgz")), `${x.what}: nothing set up or downloaded`);
    if (x.hold) assert.equal(k.k.hold, c.clock.now + x.hold, "asked again in 6 hours");
    if (x.refusal === "sharedKey") assert.equal(c.asks.at(-1).ask.outcome?.kind, "sharedKey", "said why");
    c.done();
  }
});

await check("a pin means nothing at all; the Mac's off marker means none for an hour", async () => {
  let c = computer();
  writeFileSync(c.at("opt/bops/keeper/pin"), "1\n");
  vmm.asked.length = 0;
  let out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "pinned");
  assert.deepEqual([c.calls, vmm.asked.length], [[], 0], "not even its identity");
  c.done();
  c = computer();
  c.serve(B56);
  install(c);
  writeFileSync(c.at("opt/bops/keeper/off"), JSON.stringify({ at: Math.floor(c.clock.now / 1000) - 600, why: "mac" }));
  out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "off");
  assert.equal(c.asks[0].ask.off, Math.floor(c.clock.now / 1000) - 600, "said when");
  assert.ok(!ran(c, "__BOPS_INSTALLED__"));
  c.clock.now += 3600_000;
  out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "installed", "an hour on");
  c.done();
});

await check("set up 3 times in a day (something takes it down each time): none for a day, said as flapping", async () => {
  const c = computer();
  c.serve(B56);
  install(c);
  const now = c.clock.now;
  mkdirSync(c.at("opt/bops/keeper"), { recursive: true });
  writeFileSync(c.at("opt/bops/keeper/state.json"), JSON.stringify({ desktopId: DESKTOP, failed: {}, installs: [now - 20 * 3600_000, now - 10 * 3600_000, now - 3600_000] }));
  let out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "flapping");
  assert.equal(c.asks.at(-1).ask.outcome.kind, "flapping");
  assert.ok(!ran(c, "__BOPS_INSTALLED__"));
  c.clock.now += 12 * 3600_000;
  out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "flapping", "still within the day");
  c.clock.now += 13 * 3600_000;
  out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "installed", "a day on");
  c.done();
});

await check("a reply marked or a thread of the runner's own going is busy: said so, nothing swapped, tried again in 5 minutes", async () => {
  if (!linux) return console.log("  (on Linux only)");
  for (const mark of ["turn", "working", "script"]) {
    const c = computer({ runner: "0.0.55-BuildA" });
    c.serve(B56);
    install(c);
    mkdirSync(c.at("var/run/bops/turns"), { recursive: true });
    if (mark === "turn") writeFileSync(c.at("var/run/bops/turns/t1"), "");
    if (mark === "working") writeFileSync(c.at("var/run/bops/working"), "");
    // The install script finds it busy itself (a reply marked between the keeper's look and the swap).
    if (mark === "script") c.shOverride = (s) => (s.includes("__BOPS_INSTALLED__") ? { code: 0, out: "__BOPS_BUSY__\n" } : null);
    const k = K.makeKeeper(c.env);
    const out = await k.look();
    assert.equal(out.did, "busy", mark);
    if (mark !== "script") assert.equal(c.asks[0].ask.busy, true, `${mark}: said in the ask`);
    assert.equal(c.asks.at(-1).ask.outcome.kind, "busy");
    assert.equal(c.current(), "0.0.55-BuildA", "nothing swapped");
    assert.equal(k.k.hold, c.clock.now + 5 * 60_000, "tried again in 5 minutes");
    assert.equal(c.state().unjudged, undefined, "nothing to judge");
    assert.ok(!existsSync(c.at("var/run/bops/keeper-hold")), "the hold off");
    c.done();
  }
});

/* ---------------- Setting up, updating, going back ---------------- */

await check("a first one: downloaded, its script and program from keeper.json and the identity, healthy, said set up", async () => {
  if (!linux) return console.log("  (on Linux only)");
  const c = computer();
  c.serve(B56);
  install(c);
  const out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "installed");
  assert.equal(c.current(), "0.0.56-BuildB");
  const run = readFileSync(c.at("opt/bops/runner/run.sh"), "utf8");
  assert.ok(run.includes(`BOPS_RUNNER_COMPUTER='${DESKTOP}' BOPS_DEVICE_SEED='${DESKTOP}'`), "the computer from its identity");
  assert.ok(run.includes(`BOPS_ORGO_ORIGIN='${CFG.orgo}' BOPS_CLOUD_URL='${CFG.cloud}'`), "Orgo and Bops Cloud from keeper.json");
  assert.ok(!run.includes("TZ="), "no time zone known");
  assert.equal(readFileSync(c.at("etc/supervisor/conf.d/bops-runner.conf"), "utf8"), c.rewrite(STEPS.SUPERVISOR_CONF), "its program");
  assert.ok(c.asked().includes("restart bops-runner"));
  assert.deepEqual(c.asks.map((a) => a.ask.outcome?.kind ?? null), [null, "installed"]);
  assert.deepEqual(c.asks[1].ask.outcome, { kind: "installed", version: "0.0.56", buildId: "BuildB" });
  assert.equal(c.asks[0].version, K.KEEPER_VERSION, "no runner: the keeper's own version");
  assert.deepEqual(c.state().installs.length, 1);
  assert.ok(!existsSync(c.at("opt/bops/keeper/judging")) && !existsSync(c.at("var/run/bops/keeper-hold")), "neither marker left");
  assert.ok(c.logs.includes("set up 0.0.56"), c.logs.join(" | "));
  // Only these addresses: never an Orgo computer route.
  const urls = new Set(c.calls.map((x) => x.url));
  assert.deepEqual([...urls].sort(), [`${CFG.cloud}/v1/runner/keeper`, `${CFG.orgo}/api/bops/settings`, `${CFG.releases}${B56.name}`, `${CFG.releases}latest.json`].sort());
  for (const x of c.calls) assert.equal(x.auth, x.url.startsWith(CFG.releases) ? null : `Bearer ${TOKEN}`, `${x.url}: the identity only to Orgo and Bops Cloud`);
  c.done();
});

await check("an update keeps exactly the build before, and the time zone; same or older is nothing", async () => {
  if (!linux) return console.log("  (on Linux only)");
  let c = computer({ runner: "0.0.55-BuildA", tz: "America/New_York" });
  mkdirSync(c.at("opt/bops/runner/0.0.54-Old"), { recursive: true });
  writeFileSync(c.at("opt/bops/runner/0.0.54-Old/server.js"), "");
  c.serve(B56);
  install(c);
  const out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "updated");
  assert.deepEqual(c.builds(), ["0.0.55-BuildA", "0.0.56-BuildB"], "the build before kept, the one before that gone");
  assert.ok(c.sh.some((s) => s.includes("__BOPS_INSTALLED__") && s.includes("|'0.0.55-BuildA')")), "told to keep it");
  assert.ok(readFileSync(c.at("opt/bops/runner/run.sh"), "utf8").includes("export TZ='America/New_York'"), "the time zone kept");
  assert.equal(c.asks[0].version, "0.0.55", "its runner's version");
  assert.equal(c.asks[1].ask.outcome.kind, "updated");
  assert.equal(c.state().installs.length, 0, "an update isn't a set up");
  assert.ok(c.logs.includes("updated 0.0.55 to 0.0.56"), c.logs.join(" | "));
  c.done();
  // The same version, or an older one, whatever Bops Cloud says.
  for (const [have, rel] of [
    ["0.0.56-BuildB", B56],
    ["0.0.56-BuildZ", B56],
    ["0.0.57-BuildC", B56],
  ]) {
    c = computer({ runner: have });
    c.serve(rel);
    c.answer = () => ({ do: "update", why: "ok", retryS: 60 });
    const o2 = await K.makeKeeper(c.env).look();
    assert.equal(o2.did, "nothing", have);
    assert.ok(!ran(c, "__BOPS_INSTALLED__") && !c.calls.some((x) => x.url.endsWith(".tgz")), `${have}: nothing set up`);
    c.done();
  }
  // Bops Cloud's word must be for what's here: "install" with a runner here is nothing.
  c = computer({ runner: "0.0.55-BuildA" });
  c.serve(B56);
  c.answer = () => ({ do: "install", why: "ok", retryS: 60 });
  assert.equal((await K.makeKeeper(c.env).look()).did, "nothing");
  c.done();
});

await check("an update that fails its health check goes back to the build before, restarts it, is marked failed, and is skipped for 12 hours and after 3", async () => {
  if (!linux) return console.log("  (on Linux only)");
  const c = computer({ runner: "0.0.55-BuildA" });
  c.serve(B56);
  install(c);
  c.health = "__BOPS_DOWN__\n";
  let out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "rolledBack");
  assert.equal(out.back, true);
  assert.equal(c.current(), "0.0.55-BuildA", "back");
  assert.deepEqual(c.builds(), ["0.0.55-BuildA"], "the failed build gone");
  assert.ok(c.asked().filter((l) => l === "restart bops-runner").length >= 2, "restarted on it");
  assert.equal(c.state().failed["0.0.56-BuildB"].n, 1);
  assert.deepEqual(c.asks.at(-1).ask.outcome, { kind: "rolledBack", version: "0.0.56", buildId: "BuildB", why: "it didn't answer on its computer" });
  assert.ok(c.logs.includes("rolled back 0.0.56: it didn't answer on its computer"), c.logs.join(" | "));
  // Within 12 hours: skipped, nothing downloaded.
  c.calls.length = 0;
  c.clock.now += 6 * 3600_000;
  out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "skipped");
  assert.ok(!c.calls.some((x) => x.url.endsWith(".tgz")));
  // After 12 hours: tried again (failing twice more), then for good.
  for (let n = 2; n <= 3; n++) {
    c.clock.now += 13 * 3600_000;
    out = await K.makeKeeper(c.env).look();
    assert.equal(out.did, "rolledBack", `try ${n}`);
    assert.equal(c.state().failed["0.0.56-BuildB"].n, n);
  }
  c.clock.now += 48 * 3600_000;
  out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "skipped", "for good after 3");
  // A newer one is tried.
  const B57 = bundle("0.0.57", "BuildC");
  c.serve(B57);
  c.health = "auth=identity\n__BOPS_HEALTHY__\n";
  out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "updated");
  c.done();
});

await check("a first one that fails its health check is stopped and said failed; one that listened beyond its computer is judged even with Bops Cloud down", async () => {
  if (!linux) return console.log("  (on Linux only)");
  for (const [health, cloud, why] of [
    ["__BOPS_DOWN__\n", 200, "it didn't answer on its computer"],
    ["__BOPS_EXPOSED__\n", 503, "it listened beyond its own computer"],
    ["__BOPS_NO_SS__\n", 503, "its computer can't say what it listens on"],
  ]) {
    const c = computer();
    c.serve(B56);
    install(c);
    c.health = health;
    c.cloudHealth = cloud;
    const out = await K.makeKeeper(c.env).look();
    assert.equal(out.did, "failed", health);
    assert.ok(c.asked().includes("stop bops-runner"), "stopped");
    assert.deepEqual(c.asks.at(-1).ask.outcome, { kind: "failed", version: "0.0.56", buildId: "BuildB", why });
    assert.equal(c.state().failed["0.0.56-BuildB"].n, 1);
    c.done();
  }
});

await check("with Bops Cloud's /health not answering, a runner that never got the state isn't judged: it stays, and is judged at the next look", async () => {
  if (!linux) return console.log("  (on Linux only)");
  const c = computer({ runner: "0.0.55-BuildA" });
  c.serve(B56);
  install(c);
  c.health = "__BOPS_NO_STATE__\n";
  c.cloudHealth = 503;
  let out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "unjudged");
  assert.equal(c.current(), "0.0.56-BuildB", "it stays");
  assert.deepEqual(c.state().unjudged, { build: "0.0.56-BuildB", prev: "0.0.55-BuildA", from: "0.0.55" });
  assert.ok(!c.asked().includes("stop bops-runner") && !c.state().failed["0.0.56-BuildB"], "neither stopped nor marked");
  // Bops Cloud back: the next look judges it before anything else.
  c.cloudHealth = 200;
  c.health = "auth=identity\n__BOPS_HEALTHY__\n";
  out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "updated");
  assert.equal(c.state().unjudged, undefined);
  assert.equal(c.asks.at(-1).ask.outcome.kind, "updated");
  c.done();
});

await check("a keeper stopped between the swap and the health check judges the new build at its next look", async () => {
  if (!linux) return console.log("  (on Linux only)");
  const c = computer({ runner: "0.0.55-BuildA" });
  c.serve(B56);
  install(c);
  c.health = () => {
    throw new Error("stopped");
  };
  assert.equal((await K.makeKeeper(c.env).look()).did, "error");
  assert.equal(c.current(), "0.0.56-BuildB");
  assert.deepEqual(c.state().unjudged, { build: "0.0.56-BuildB", prev: "0.0.55-BuildA", from: "0.0.55" });
  c.health = "__BOPS_DOWN__\n";
  const out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "rolledBack", "judged, before anything else");
  assert.equal(c.current(), "0.0.55-BuildA");
  c.done();
});

await check("a copy of the computer (another desktop id) starts afresh and sets its runner up from the build on its disk, with no download", async () => {
  if (!linux) return console.log("  (on Linux only)");
  const c = computer({ runner: "0.0.56-BuildB" });
  writeFileSync(c.at("opt/bops/keeper/state.json"), JSON.stringify({ desktopId: OTHER, failed: { "0.0.56-BuildB": { at: c.clock.now, n: 3 } }, installs: [c.clock.now, c.clock.now, c.clock.now] }));
  // What a copy's scrub takes off (lib/server/runner.ts RUNNER_SCRUB): the runner's program and script.
  rmSync(c.at("etc/supervisor/conf.d/bops-runner.conf"));
  rmSync(c.at("opt/bops/runner/run.sh"));
  rmSync(c.at("running"));
  c.serve(B56);
  c.served.clear();
  install(c);
  const out = await K.makeKeeper(c.env).look();
  assert.equal(out.did, "installed");
  assert.equal(c.asks[0].ask.runner, null, "no runner on the copy");
  assert.ok(!c.calls.some((x) => x.url.endsWith(".tgz")), "the build on its disk");
  assert.equal(c.state().desktopId, DESKTOP);
  assert.equal(c.state().installs.length, 1, "what it knew of the other computer gone");
  assert.ok(readFileSync(c.at("opt/bops/runner/run.sh"), "utf8").includes(`BOPS_RUNNER_COMPUTER='${DESKTOP}'`), "its own id");
  c.done();
});

/* ---------------- When it looks ---------------- */

await check("it looks first, then on its schedule (2 minutes with no runner, doubling to 30; hourly and a while with one), at once on the look file, after a clock jump, and when Bops Cloud said", async () => {
  const c = computer();
  c.answer = () => ({ do: "nothing", why: "notCloud", retryS: 7200 });
  const k = K.makeKeeper(c.env);
  const tick = async (ms, mono = ms) => {
    c.clock.now += ms;
    c.clock.mono += mono;
    return k.tick();
  };
  assert.equal((await k.tick()).why, "first");
  assert.equal(await tick(60_000), null, "a minute on: not yet");
  assert.equal((await tick(60_000)).why, "due", "2 minutes");
  assert.equal(await tick(3 * 60_000), null, "3 minutes on: not yet");
  assert.equal((await tick(60_000)).why, "due", "then 4");
  // The runner hears of a new release: at once.
  mkdirSync(c.at("var/run/bops"), { recursive: true });
  writeFileSync(c.at("var/run/bops/keeper-look"), "");
  utimesSync(c.at("var/run/bops/keeper-look"), new Date(c.clock.now + 1000), new Date(c.clock.now + 1000));
  assert.equal((await tick(30_000)).why, "nudged");
  assert.equal(await tick(30_000), null, "once");
  // The wall clock ran 10 minutes while the process saw 30 seconds (a snapshot restored): at once.
  assert.equal((await tick(10 * 60_000, 30_000)).why, "jump");
  // Bops Cloud said to ask again in a minute (say, a turn was being answered): then.
  c.answer = () => ({ do: "nothing", why: "claimed", retryS: 60 });
  assert.equal(await tick(29 * 60_000), null, "no runner: up to 30 minutes apart");
  assert.equal((await tick(2 * 60_000)).why, "due");
  runnerAt(c, "0.0.55-BuildA");
  assert.equal((await tick(60_000)).why, "hint", "when Bops Cloud said");
  // With a runner, hourly and its while (from its computer's id), not before.
  c.answer = () => ({ do: "nothing", why: "upToDate", retryS: 7200 });
  assert.equal((await tick(61_000)).why, "hint");
  const jitter = K.jitterOf(DESKTOP);
  assert.ok(jitter >= 0 && jitter < 3600_000);
  assert.notEqual(K.jitterOf(OTHER), jitter, "copies wait differently");
  assert.equal(await tick(3600_000 + jitter - 1000), null, "not before its hour and while");
  assert.equal((await tick(2000)).why, "due");
  // A refusal holds every look but a clock jump.
  vmm.status = 403;
  assert.equal((await tick(7200_000)).did, "refused");
  writeFileSync(c.at("var/run/bops/keeper-look"), "");
  utimesSync(c.at("var/run/bops/keeper-look"), new Date(c.clock.now + 1000), new Date(c.clock.now + 1000));
  assert.equal(await tick(60_000), null, "held: not even the look file");
  vmm.status = 200;
  assert.equal((await tick(10 * 60_000)).why, "nudged", "after the 10 minutes");
  c.done();
});

await check("its log is words only: never the token, an address, a query or a body", async () => {
  if (!linux) return console.log("  (on Linux only)");
  const c = computer({ runner: "0.0.55-BuildA" });
  c.serve(B56);
  install(c);
  c.health = "__BOPS_DOWN__\n";
  const out = [];
  const log = console.log;
  const warn = console.warn;
  const err = console.error;
  console.log = console.warn = console.error = (...a) => out.push(a.join(" "));
  try {
    const k = K.makeKeeper(c.env);
    await k.look();
    vmm.status = 403;
    await k.look();
    vmm.status = 200;
    c.answer = () => null;
    await K.makeKeeper(c.env).look();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = err;
    vmm.status = 200;
  }
  assert.deepEqual(out, [], "nothing printed but through its log");
  assert.ok(c.logs.length >= 3, c.logs.join(" | "));
  for (const l of c.logs) {
    assert.ok(!l.includes(TOKEN) && !l.includes("orgo_vm_"), `no token: ${l}`);
    assert.ok(!/https?:|\?|\{|"|example/.test(l), `no address, query or body: ${l}`);
  }
  // Nor written anywhere on the computer.
  const all = spawnSync("grep", ["-rl", "orgo_vm_", c.base], { encoding: "utf8" }).stdout.trim();
  assert.equal(all, "", "the token in no file");
  c.done();
});

await check("keeper.json is checked as the Mac's install checks Orgo and Bops Cloud: bad, missing or on the computer itself means nothing runs", async () => {
  for (const cfg of [{ ...CFG, cloud: "http://127.0.0.1:8790" }, { ...CFG, orgo: "https://orgo.example/?x=1" }, { orgo: CFG.orgo, cloud: CFG.cloud }, { ...CFG, releases: "ftp://dl.example/" }, "not json"]) {
    const c = computer();
    writeFileSync(c.at("opt/bops/keeper/keeper.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg));
    vmm.asked.length = 0;
    assert.equal((await K.makeKeeper(c.env).look()).did, "noConfig", JSON.stringify(cfg));
    assert.deepEqual([c.calls.length, vmm.asked.length], [0, 0]);
    c.done();
  }
  const c = computer({ config: { orgo: "https://orgo.example/", cloud: "https://bops.example/api/", releases: "https://dl.example/runner" } });
  assert.deepEqual(await K.readConfig(c.env), CFG, "slashes as the runner has them");
  c.done();
});

await check("on a computer, the keeper runs from KEEPER_DIR with its steps beside it", async () => {
  const dir = mkdtempSync(join(scratch, "keeper-dir-"));
  copyFileSync(`${root}/vm/bin/bops-runner-keeper.mjs`, join(dir, "keeper.mjs"));
  copyFileSync(`${root}/vm/runner-steps.mjs`, join(dir, "runner-steps.mjs"));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const k = await import(${JSON.stringify(pathToFileURL(join(dir, "keeper.mjs")).href)}); console.log(k.KEEPER_VERSION, typeof k.main)`], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), `${K.KEEPER_VERSION} function`, r.stderr);
  // Its only imports: its steps and node's own.
  const src = readFileSync(`${root}/vm/bin/bops-runner-keeper.mjs`, "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(imports.every((m) => m.startsWith("node:")), imports.join());
  assert.ok(src.includes(`"./runner-steps.mjs" : "../runner-steps.mjs"`));
  assert.ok(!/process\.env/.test(src), "nothing from its environment");
});

/* ---------------- What puts it on a computer ---------------- */

await check("a runner puts its own keeper in place when the one there differs, keeping where releases are, and restarts it when it ran", async () => {
  const RK = await import(`${root}/lib/server/runner-keeper.ts`);
  const base = mkdtempSync(join(scratch, "ensure-"));
  const at = (p) => join(base, p);
  const said = [];
  let running = false;
  const sh = async (s) => (said.push(s), s.startsWith("supervisorctl status") ? (running ? "bops-keeper RUNNING" : "bops-keeper STOPPED") : "");
  let now = Date.now();
  const o = { at, sh, now: () => now, vm: `${root}/vm` };
  const info = console.info;
  console.info = () => {};
  try {
    assert.equal(await RK.ensureKeeper(o), "written", "none there");
    assert.equal(readFileSync(at("opt/bops/keeper/keeper.mjs"), "utf8"), readFileSync(`${root}/vm/bin/bops-runner-keeper.mjs`, "utf8"));
    assert.equal(readFileSync(at("opt/bops/keeper/runner-steps.mjs"), "utf8"), readFileSync(`${root}/vm/runner-steps.mjs`, "utf8"));
    assert.equal(readFileSync(at("etc/supervisor/conf.d/bops-keeper.conf"), "utf8"), STEPS.KEEPER_CONF);
    assert.deepEqual(JSON.parse(readFileSync(at("opt/bops/keeper/keeper.json"), "utf8")), { orgo: "https://orgo.example", cloud: "https://bops.orgo.ai/api", releases: "https://bops.bot/download/runner/" }, "Bops Cloud with its /api");
    assert.ok(said.some((s) => s.includes("supervisorctl reread") && s.includes("supervisorctl update")));
    assert.ok(!said.some((s) => s.includes("restart bops-keeper")), "not running: nothing to restart");
    said.length = 0;
    assert.equal(await RK.ensureKeeper(o), "same");
    assert.deepEqual(said, [], "the same: nothing asked");
    // Another releases place (a staging template's) stays; another keeper is replaced and restarted.
    writeFileSync(at("opt/bops/keeper/keeper.json"), JSON.stringify({ orgo: "x", cloud: "y", releases: "https://dl.example/staging/" }));
    writeFileSync(at("opt/bops/keeper/keeper.mjs"), "// an older keeper\n");
    running = true;
    process.env.BOPS_CLOUD_URL = "https://staging-bops.example/api";
    assert.equal(await RK.ensureKeeper(o), "written");
    delete process.env.BOPS_CLOUD_URL;
    assert.deepEqual(JSON.parse(readFileSync(at("opt/bops/keeper/keeper.json"), "utf8")), { orgo: "https://orgo.example", cloud: "https://staging-bops.example/api", releases: "https://dl.example/staging/" });
    assert.ok(said.some((s) => s.includes("restart bops-keeper")), "restarted");
    // Never while it judges a build (under 10 minutes), works on the runner (under 5), or on a pinned computer.
    writeFileSync(at("opt/bops/keeper/keeper.mjs"), "// older again\n");
    writeFileSync(at("opt/bops/keeper/judging"), "1\n");
    assert.equal(await RK.ensureKeeper(o), "judging");
    now += 11 * 60_000;
    mkdirSync(at("var/run/bops"), { recursive: true });
    writeFileSync(at("var/run/bops/keeper-hold"), "");
    utimesSync(at("var/run/bops/keeper-hold"), new Date(now - 60_000), new Date(now - 60_000));
    assert.equal(await RK.ensureKeeper(o), "busy");
    rmSync(at("var/run/bops/keeper-hold"));
    writeFileSync(at("opt/bops/keeper/pin"), "1\n");
    assert.equal(await RK.ensureKeeper(o), "pinned");
    assert.equal(readFileSync(at("opt/bops/keeper/keeper.mjs"), "utf8"), "// older again\n", "left as it was");
    rmSync(at("opt/bops/keeper/pin"));
    assert.equal(await RK.ensureKeeper(o), "written");
    assert.equal(await RK.ensureKeeper({ ...o, vm: join(base, "none") }), "missing", "a build with no keeper of its own");
  } finally {
    console.info = info;
    rmSync(base, { recursive: true, force: true });
  }
});

await check("template 0.1.12 has the keeper, its steps, keeper.json (Bops Cloud with its /api) and its program, and prints as YAML", async () => {
  const T = await import(`${root}/orgo/bops-base.mjs`);
  const { template } = T;
  assert.equal(template.template.version, "0.1.12");
  assert.ok(readFileSync(`${root}/lib/server/orgo.ts`, "utf8").includes('"system/bops-base@0.1.12"'), "BOPS_TEMPLATE in step");
  const f = (to) => template.files.find((x) => x.to === to);
  assert.deepEqual([f("/opt/bops/keeper/keeper.mjs")?.mode, f("/opt/bops/keeper/runner-steps.mjs")?.mode, f("/opt/bops/keeper/keeper.json")?.mode], ["0755", "0644", "0644"]);
  assert.equal(f("/opt/bops/keeper/keeper.mjs").inline, readFileSync(`${root}/vm/bin/bops-runner-keeper.mjs`, "utf8"));
  assert.equal(f("/opt/bops/keeper/runner-steps.mjs").inline, readFileSync(`${root}/vm/runner-steps.mjs`, "utf8"));
  assert.deepEqual(JSON.parse(f("/opt/bops/keeper/keeper.json").inline), { orgo: "https://www.orgo.ai", cloud: "https://bops.orgo.ai/api", releases: "https://bops.bot/download/runner/" });
  assert.ok(template.files.every((x) => !x.to.startsWith("/etc/")), "Orgo takes no template file in /etc: the program is written by a build step");
  // Its program, byte for byte, from that step.
  const step = template.build.run.find((r) => r.includes("bops-keeper.conf"));
  const d = mkdtempSync(join(scratch, "conf-"));
  mkdirSync(join(d, "conf.d"));
  const r = spawnSync("sh", ["-c", step.split(" && ")[1].replaceAll("/etc/supervisor", d)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(d, "conf.d/bops-keeper.conf"), "utf8"), STEPS.KEEPER_CONF);
  // Staging's places when it's published for staging.
  const env = { ...process.env, BOPS_KEEPER_ORGO: "https://staging.orgo.example", BOPS_KEEPER_CLOUD: "https://staging-bops.example/api", BOPS_KEEPER_RELEASES: "https://dl.example/staging/" };
  const y = spawnSync(process.execPath, [`${root}/orgo/bops-base.mjs`, "yaml"], { encoding: "utf8", env });
  assert.equal(y.status, 0, y.stderr);
  assert.ok(y.stdout.includes('version: "0.1.12"') && y.stdout.includes('"cloud": "https://staging-bops.example/api"'), "keeper.json from the publisher's environment");
  // The YAML is the template exactly, when a YAML reader is at hand.
  let yaml = null;
  try {
    yaml = createRequire(import.meta.url)("js-yaml");
  } catch {}
  if (yaml) assert.deepEqual(yaml.load(spawnSync(process.execPath, [`${root}/orgo/bops-base.mjs`, "yaml"], { encoding: "utf8" }).stdout), JSON.parse(JSON.stringify(template)));
  else console.log("  (no YAML reader here: the YAML's round trip isn't checked)");
  rmSync(d, { recursive: true, force: true });
});

await check("the runner bundle ships only with its keeper", () => {
  const sh = readFileSync(`${root}/scripts/server-bundle.sh`, "utf8");
  assert.ok(sh.includes('[ -f "$stage/server/vm/bin/bops-runner-keeper.mjs" ]'));
  assert.ok(sh.includes('[ -f "$stage/server/vm/runner-steps.mjs" ]'));
});

vmmServer.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`runner keeper: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
