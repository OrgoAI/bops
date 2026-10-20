// Tests for a runner signing in with its computer's Orgo identity (the identity spec, section 4): the
// client (lib/server/vm-identity.ts) against a fake VMM on 127.0.0.1 (each answer: a token, refused, none
// here, a refused connection right after a token and long after, busy, a read timeout; a rejected token
// never sent again, a fresh one at most every 5 seconds, vm_identity_off and bops_cloud_not_ready putting
// identity aside, the refresh on the monotonic clock, a nap, which computer this is, and no token in any
// log), the order a runner takes its credential in (orgo-auth.ts runnerKey: identity, refused with no
// key file, the token kept while the VMM is busy, else the key file; a 401 moves on at once, Orgo's calls
// made once more on the next credential; another account's computer stops; the same user's new token
// goes to Bops Cloud without the "new key" line; `[runner] auth:` said on each change), the watch of
// which VM it's on (runner.ts watchIdentity), and, run on its own with --start, a runner with no
// credential waiting instead of stopping (runner-start.ts).
//
// Orgo, Bops Cloud and the store are fakes; nothing reaches a real service or 169.254.169.254.
// Usage: node --conditions=react-server scripts/test-vm-identity.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
process.env.BOPS_ORGO_ORIGIN = "https://orgo.example";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const START = process.argv.includes("--start");

const FAKES = {
  store: ["getState", "update", "bindSignIn", "releaseSignOut", "stateUser", "stateEpoch", "pullState", "statePulledAt", "stateReady", "ownSession"],
  awake: ["sleptSince"],
  usage: ["recordUsage"],
  "workspace-skills": ["folderKey", "moveWorkspaceFolder"],
  ...(START ? { runner: ["checkIdentity", "IDENTITY_EVERY_MS", "runnerComputer", "startRunsOn", "watchIdentity", "WHO_AM_I_EVERY_MS"], "orgo-sign-in": ["authStatus"], "free-hours": ["startActivityBeat"], routines: [] } : {}),
};
const VALUES = { runner: { IDENTITY_EVERY_MS: 300000, WHO_AM_I_EVERY_MS: 60000 } };
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
    if (name === "routines") return { format: "module", shortCircuit: true, source: `globalThis.__fake.started.push("routines");` };
    const one = (n) => (VALUES[name]?.[n] !== undefined ? `export const ${n} = ${JSON.stringify(VALUES[name][n])};` : `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(name)}].${n}(...a);`);
    return { format: "module", shortCircuit: true, source: FAKES[name].map(one).join("\n") };
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

const C1 = "c1c1c1c1-0000-4000-8000-000000000001";
const C2 = "c2c2c2c2-0000-4000-8000-000000000002";
const state = { account: { user: { id: "u1" } }, bots: [], sessions: [], routines: [] };
let napped = false;
let ready = false;
globalThis.__fake = {
  started: [],
  bound: [],
  store: {
    getState: () => state,
    update: (fn) => fn(state),
    bindSignIn: async (user, key) => void globalThis.__fake.bound.push({ user, key }),
    releaseSignOut: async () => {},
    stateUser: () => state.account?.user.id ?? null,
    stateEpoch: () => 0,
    pullState: async () => {},
    statePulledAt: () => 0,
    stateReady: () => ready,
    ownSession: () => true,
  },
  awake: { sleptSince: () => napped },
  usage: { recordUsage: () => {} },
  "workspace-skills": { folderKey: () => "", moveWorkspaceFolder: () => {} },
};

/** The VMM's metadata address, faked: what it answers next (a function of the request, or an answer), and every request it got. */
const vmm = { seen: [], token: null, who: null };
const server = createServer((req, res) => {
  vmm.seen.push({ url: req.url, headers: req.headers });
  const pick = req.url.startsWith("/orgo/v1/identity/token") ? vmm.token : req.url === "/orgo/v1/identity" ? vmm.who : null;
  const a = typeof pick === "function" ? pick(req) : pick;
  if (!a) return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_enabled" }));
  if (a.hang) return;
  res.writeHead(a.status, { "content-type": "application/json", ...(a.headers ?? {}) }).end(JSON.stringify(a.body ?? {}));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
// A port nothing listens on: a refused connection.
const closed = createServer();
await new Promise((r) => closed.listen(0, "127.0.0.1", r));
const CLOSED = `http://127.0.0.1:${closed.address().port}`;
await new Promise((r) => closed.close(r));

let minted = 0;
/** A token as the VMM hands it out (orgo-web makes it): for computer `desktop` of user `user`, `expires_in` seconds. */
const tokenAnswer = (o = {}) => {
  const token = o.token ?? `orgo_vm_tok${++minted}.sig`;
  return { status: 200, body: { token, token_type: "Bearer", expires_in: o.expiresIn ?? 3600, expires_at: new Date(Date.now() + 3600_000).toISOString(), desktop_id: o.desktop ?? C1, vm_id: o.vm ?? "vm-a", user_id: o.user ?? "u1", project_id: "p1" } };
};

/** Console lines while `fn` runs. */
async function logged(fn) {
  const lines = [];
  const kept = { ...console };
  for (const k of ["log", "info", "warn", "error"]) console[k] = (...a) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, kept);
  }
  return lines;
}

/** A runner's computer: its key files in a folder only this user can enter (as /root). */
function keyHome() {
  const dir = mkdtempSync(join(tmpdir(), "bops-vm-identity-key-"));
  chmodSync(dir, 0o700);
  return { dir, secrets: join(dir, ".orgo-secrets.env"), env: join(dir, ".env") };
}

process.env.BOPS_RUNNER = "1";
process.env.BOPS_RUNNER_COMPUTER = C1;
const V = await import(`${root}/lib/server/vm-identity.ts`);
const VT = V.vmIdentityForTests;
const K = await import(`${root}/lib/server/runner-key.ts`);
const home = keyHome();
K.runnerKeyForTests.files([home.secrets, home.env]);
const A = await import(`${root}/lib/server/orgo-auth.ts`);
const left = [];
function resetAll() {
  VT.reset();
  VT.base(BASE);
  VT.timeouts(300, 600);
  A.orgoAuthForTests.reset();
  A.orgoAuthForTests.leave((why) => void left.push(why));
  left.length = 0;
  vmm.seen.length = 0;
  vmm.token = null;
  vmm.who = null;
  napped = false;
  globalThis.__fake.bound.length = 0;
  state.account = { user: { id: "u1" } };
  rmSync(home.secrets, { force: true });
  rmSync(home.env, { force: true });
  delete process.env.BOPS_RUNNER_IDENTITY;
}
const fileKey = (k) => writeFileSync(home.secrets, `export ORGO_API_KEY=${k}\n`, { mode: 0o600 });

/* ---------------- Started on its own (node … --start): runner-start.ts ---------------- */

if (START) {
  const S = await import(`${root}/lib/server/runner-start.ts`);
  Object.assign(process.env, { BOPS_UI_TOKEN: "a".repeat(64), HOSTNAME: "127.0.0.1", BOPS_DEVICE_SEED: C1 });
  globalThis.__fake.runner = { checkIdentity: async () => "same", runnerComputer: () => C1, startRunsOn: () => globalThis.__fake.started.push("runs-on"), watchIdentity: async () => {} };
  globalThis.__fake["orgo-sign-in"] = { authStatus: async () => ((ready = true), {}) };
  globalThis.__fake["free-hours"] = { startActivityBeat: () => globalThis.__fake.started.push("in-use") };
  globalThis.__bopsRunnerNoAuthMs = 30;

  await check("with no credential a runner waits (auth: none) instead of stopping, and starts once a key file is there", async () => {
    resetAll();
    vmm.token = { status: 404, body: { error: "not_enabled" } };
    const exit = process.exit;
    process.exit = (c) => {
      throw new Error(`exited ${c}`);
    };
    let started;
    const lines = await logged(async () => {
      started = S.startRunner();
      await sleep(200);
      assert.equal(ready, false, "nothing read meanwhile");
      assert.deepEqual(globalThis.__fake.started, [], "nothing started");
      fileKey("sk_given_later");
      await started;
    });
    process.exit = exit;
    assert.ok(lines.includes("[runner] auth: none"), lines.join(" | "));
    assert.ok(lines.includes("[runner] auth: key"), "then its key");
    assert.ok(lines.some((l) => l.startsWith("[runner] waiting: no Orgo identity and no ORGO_API_KEY")), "says why it waits");
    assert.ok(!lines.some((l) => /not starting/.test(l)), "never stops for it");
    assert.ok(vmm.seen.filter((r) => r.url.startsWith("/orgo/v1/identity/token")).length >= 2, "identity asked again while it waits");
    assert.deepEqual(globalThis.__fake.started, ["runs-on", "routines", "in-use"]);
    assert.equal(A.orgoKey(), "sk_given_later");
    assert.ok(lines.at(-1).startsWith("[runner] running the routines"));
    clearInterval(globalThis.__bopsRunnerIdentity);
    clearInterval(globalThis.__bopsRunnerWhoAmI);
  });

  await check("a runner whose computer's identity is refused stops, and never uses the key file", async () => {
    resetAll();
    delete globalThis.__bopsRunnerStarted;
    A.orgoAuthForTests.leave(undefined);
    fileKey("sk_never_used");
    vmm.token = { status: 403, body: { error: "not_eligible", reason: "workspace_shared" } };
    const exit = process.exit;
    let code;
    process.exit = (c) => {
      code = c;
      throw new Error("exited");
    };
    const lines = await logged(async () => {
      await assert.rejects(S.startRunner(), /exited/);
    });
    process.exit = exit;
    assert.equal(code, 1);
    assert.ok(lines.includes("[runner] this computer's Orgo identity was refused (workspace_shared): stopping"), lines.join(" | "));
    assert.notEqual(A.orgoKey(), "sk_never_used");
  });

  server.close();
  rmSync(home.dir, { recursive: true, force: true });
  console.log(`vm identity start: ${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

/* ---------------- The client ---------------- */

await check("200: a token for this computer, asked with Metadata-Flavor: Orgo, kept until 25 minutes before it ends (monotonic clock)", async () => {
  resetAll();
  vmm.token = tokenAnswer({ token: "orgo_vm_first.sig" });
  const t0 = performance.now();
  const id = await V.vmIdentity();
  assert.equal(id.state, "ok");
  assert.deepEqual([id.token, id.desktopId, id.vmId, id.userId, id.projectId], ["orgo_vm_first.sig", C1, "vm-a", "u1", "p1"]);
  assert.ok(Math.abs(id.refreshAt - t0 - 35 * 60_000) < 2000, `refresh in 35 minutes (${id.refreshAt - t0})`);
  assert.ok(Math.abs(id.expiresAt - t0 - 60 * 60_000) < 2000, "ends in an hour");
  assert.equal(vmm.seen[0].url, "/orgo/v1/identity/token");
  assert.equal(vmm.seen[0].headers["metadata-flavor"], "Orgo");
  assert.equal(vmm.seen[0].headers.connection, "close", "an agent of its own, no keep-alive");
  assert.equal(vmm.seen[0].headers.origin, undefined);
  await V.vmIdentity();
  assert.equal(vmm.seen.length, 1, "kept: not asked again");
  // Its time to refresh: asked again (not fresh).
  VT.box().last.refreshAt = performance.now() - 1;
  vmm.token = tokenAnswer({ token: "orgo_vm_second.sig" });
  assert.equal((await V.vmIdentity()).token, "orgo_vm_second.sig");
  assert.equal(vmm.seen[1].url, "/orgo/v1/identity/token");
  // A short one: at half its life.
  vmm.token = tokenAnswer({ expiresIn: 600 });
  VT.box().last.refreshAt = performance.now() - 1;
  const short = await V.vmIdentity();
  assert.ok(Math.abs(short.refreshAt - performance.now() - 300_000) < 2000, "half of 10 minutes");
  assert.equal(V.refreshInMs(3600), 35 * 60_000);
  assert.equal(V.refreshInMs(2400), 20 * 60_000, "40 minutes left: at half its life, never with less than 20 left");
});

await check("a nap since the token came: asked again (a wake may be another VM)", async () => {
  resetAll();
  vmm.token = tokenAnswer();
  await V.vmIdentity();
  napped = true;
  await V.vmIdentity();
  assert.equal(vmm.seen.length, 2);
});

await check("403: refused for 10 minutes, with Orgo's reason", async () => {
  resetAll();
  vmm.token = { status: 403, body: { error: "not_eligible", reason: "workspace_shared" } };
  const t0 = performance.now();
  const lines = await logged(async () => {
    const id = await V.vmIdentity();
    assert.deepEqual([id.state, id.reason], ["refused", "workspace_shared"]);
    assert.ok(Math.abs(id.until - t0 - 10 * 60_000) < 2000);
  });
  assert.deepEqual(lines, ["[runner] identity refused (workspace_shared)"]);
  vmm.token = tokenAnswer();
  assert.equal((await V.vmIdentity()).state, "refused", "kept");
  assert.equal((await V.vmIdentity({ again: true })).state, "refused", "even when asked again");
  assert.equal(vmm.seen.length, 1);
  // A 403 the VMM gives an ask it took for a browser's is the ask's fault: none, never a refusal that stops the runner.
  resetAll();
  vmm.token = { status: 403, body: { error: "browser_request", message: "no" } };
  assert.equal((await V.vmIdentity()).state, "absent");
});

await check("404: none here at once, even right after a token, asked again in 5 minutes; never sticky; another 4xx is none too", async () => {
  resetAll();
  vmm.token = tokenAnswer();
  assert.equal((await V.vmIdentity()).state, "ok");
  vmm.token = { status: 404, body: { error: "not_enabled" } };
  VT.box().last.refreshAt = 0;
  const t0 = performance.now();
  const id = await V.vmIdentity();
  assert.equal(id.state, "absent");
  assert.ok(Math.abs(id.until - t0 - 5 * 60_000) < 2000);
  // A refused connection after the 404: none, not a VMM restarting.
  VT.base(CLOSED);
  VT.box().last.until = 0;
  assert.equal((await V.vmIdentity()).state, "absent", "a 404 is never sticky");
  resetAll();
  vmm.token = { status: 400, body: { error: "metadata_header_required" } };
  assert.equal((await V.vmIdentity()).state, "absent");
  // An `again` asks before the 5 minutes are up.
  vmm.token = tokenAnswer();
  assert.equal((await V.vmIdentity({ again: true })).state, "ok");
});

await check("a refused connection: none when nothing answered before; within 10 minutes of a token or a refusal it's the VMM restarting (sticky)", async () => {
  resetAll();
  VT.base(CLOSED);
  assert.equal((await V.vmIdentity()).state, "absent", "nothing ever answered");
  resetAll();
  vmm.token = tokenAnswer();
  await V.vmIdentity();
  VT.base(CLOSED);
  VT.box().last.refreshAt = 0;
  const t = await V.vmIdentity();
  assert.deepEqual([t.state, t.sticky], ["transient", true]);
  assert.equal(V.identityHere(), true, "its copy check still asks it");
  assert.ok(t.retryAt - performance.now() > 1000 && t.retryAt - performance.now() <= 2000, "2 seconds, doubling");
  VT.box().last.retryAt = 0;
  const t2 = await V.vmIdentity();
  assert.ok(t2.retryAt - performance.now() > 3000, "then 4");
  // Ten minutes after the token: none.
  VT.box().seenAt = performance.now() - 11 * 60_000;
  VT.box().last.retryAt = 0;
  assert.equal((await V.vmIdentity()).state, "absent");
});

await check("429 and 503 wait as Retry-After says; another 5xx and a read timeout back off", async () => {
  resetAll();
  vmm.token = { status: 503, body: { error: "retry" }, headers: { "retry-after": "7" } };
  let id = await V.vmIdentity();
  assert.equal(id.state, "transient");
  assert.ok(Math.abs(id.retryAt - performance.now() - 7000) < 500);
  vmm.token = { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "1" } };
  VT.box().last.retryAt = 0;
  id = await V.vmIdentity();
  assert.ok(Math.abs(id.retryAt - performance.now() - 1000) < 500);
  vmm.token = { status: 500, body: {} };
  VT.box().last.retryAt = 0;
  id = await V.vmIdentity();
  assert.ok(id.state === "transient" && id.retryAt - performance.now() > 1000);
  // Connected, then nothing: a read timeout (here 600 ms).
  resetAll();
  vmm.token = { hang: true };
  const t0 = performance.now();
  id = await V.vmIdentity();
  assert.equal(id.state, "transient");
  assert.ok(!id.sticky);
  assert.ok(performance.now() - t0 < 1500, "within its total timeout");
});

await check("a rejected token is never sent again: a fresh one next (at most every 5 seconds), the same one from the VMM isn't taken; no token in the log", async () => {
  resetAll();
  const said = [];
  const kept = { ...console };
  for (const k of ["log", "info", "warn", "error"]) console[k] = (...a) => said.push(a.join(" "));
  vmm.token = tokenAnswer({ token: "orgo_vm_bad.sig" });
  const id = await V.vmIdentity();
  V.vmIdentityRejected(id.token, "identity_stale");
  assert.equal(V.tokenRejected("orgo_vm_bad.sig"), true);
  // The VMM still has it cached: not taken.
  let next = await V.vmIdentity();
  assert.equal(vmm.seen.at(-1).url, "/orgo/v1/identity/token?fresh=1", "asked fresh");
  assert.equal(next.state, "transient", "the same one again isn't used");
  // Within 5 seconds of that fresh ask: not asked again.
  const asked = vmm.seen.length;
  next = await V.vmIdentity();
  assert.equal(vmm.seen.length, asked);
  assert.equal(next.state, "transient");
  // After them: fresh again, and a new one.
  VT.box().freshAt = performance.now() - 6000;
  VT.box().last.retryAt = 0;
  vmm.token = tokenAnswer({ token: "orgo_vm_good.sig" });
  next = await V.vmIdentity();
  assert.equal(vmm.seen.at(-1).url, "/orgo/v1/identity/token?fresh=1");
  assert.equal(next.token, "orgo_vm_good.sig");
  V.vmIdentityRejected("sk_not_a_token", "x");
  assert.equal(V.tokenRejected("sk_not_a_token"), false, "a key is orgo-auth's");
  Object.assign(console, kept);
  assert.ok(said.some((l) => l === "[runner] identity turned down (identity_stale): asking for a fresh one"), said.join(" | "));
  assert.ok(said.every((l) => !l.includes("orgo_vm_")), said.join(" | "));
});

await check("vm_identity_off: none at once for 5 minutes (an `again` waits too); bops_cloud_not_ready: 10", async () => {
  resetAll();
  vmm.token = tokenAnswer();
  const id = await V.vmIdentity();
  V.vmIdentityRejected(id.token, "vm_identity_off");
  const asked = vmm.seen.length;
  const off = await V.vmIdentity();
  assert.equal(off.state, "absent");
  assert.ok(Math.abs(off.until - performance.now() - 5 * 60_000) < 2000);
  assert.equal((await V.vmIdentity({ again: true })).state, "absent");
  assert.equal(vmm.seen.length, asked, "not asked meanwhile");
  resetAll();
  vmm.token = tokenAnswer();
  V.vmIdentityRejected((await V.vmIdentity()).token, "bops_cloud_not_ready");
  assert.ok(Math.abs(VT.box().last.until - performance.now() - 10 * 60_000) < 2000);
});

await check("which computer this is (GET /orgo/v1/identity), and BOPS_RUNNER_IDENTITY=0 skips identity altogether", async () => {
  resetAll();
  vmm.who = { status: 200, body: { desktop_id: C1, vm_id: "vm-a", state: "bound" } };
  assert.deepEqual(await V.whoAmI(), { desktopId: C1, vmId: "vm-a" });
  vmm.who = { status: 503, body: { error: "retry" } };
  assert.equal(await V.whoAmI(), null);
  process.env.BOPS_RUNNER_IDENTITY = "0";
  vmm.seen.length = 0;
  vmm.token = tokenAnswer();
  assert.equal((await V.vmIdentity()).state, "absent");
  assert.equal(await V.whoAmI(), null);
  assert.equal(vmm.seen.length, 0, "nothing asked");
  delete process.env.BOPS_RUNNER_IDENTITY;
});

/* ---------------- The runner's credential: orgo-auth.ts ---------------- */

await check("identity first: the token, said as auth: identity; then the key file only where identity isn't", async () => {
  resetAll();
  fileKey("sk_file_key");
  vmm.token = tokenAnswer({ token: "orgo_vm_one.sig" });
  const lines = await logged(async () => {
    assert.equal(await A.loadOrgoKey(), "orgo_vm_one.sig");
  });
  assert.ok(lines.includes("[runner] auth: identity"), lines.join(" | "));
  assert.equal(A.runnerAuth(), "identity");
  // None here: the key file, as before identity.
  resetAll();
  fileKey("sk_file_key");
  vmm.token = { status: 404, body: { error: "not_enabled" } };
  const lines2 = await logged(async () => {
    assert.equal(await A.loadOrgoKey(), "sk_file_key");
  });
  assert.ok(lines2.includes("[runner] auth: key"));
  // Neither: none.
  resetAll();
  vmm.token = { status: 404, body: {} };
  const lines3 = await logged(async () => {
    assert.equal(await A.loadOrgoKey(), null);
  });
  assert.ok(lines3.includes("[runner] auth: none"));
});

await check("refused: no credential at all, never the key file, and the runner stops", async () => {
  resetAll();
  fileKey("sk_file_key");
  vmm.token = { status: 403, body: { error: "not_eligible", reason: "owner_deleting" } };
  await logged(async () => {
    assert.equal(await A.loadOrgoKey(), null);
  });
  assert.deepEqual(left, ["this computer's Orgo identity was refused (owner_deleting)"]);
  assert.equal(A.orgoKey(), null);
});

await check("the VMM busy: the token in use while it hasn't ended and isn't turned down, else the key file meanwhile", async () => {
  resetAll();
  fileKey("sk_file_key");
  vmm.token = tokenAnswer({ token: "orgo_vm_live.sig" });
  assert.equal(await A.loadOrgoKey(), "orgo_vm_live.sig");
  vmm.token = { status: 503, body: { error: "retry" }, headers: { "retry-after": "30" } };
  VT.box().last.refreshAt = 0;
  assert.equal(await A.loadOrgoKey(), "orgo_vm_live.sig", "kept while it lasts");
  globalThis.bopsRunnerAuth.identity.expiresAt = performance.now() - 1;
  VT.box().last.retryAt = 0;
  const lines = await logged(async () => {
    assert.equal(await A.loadOrgoKey(), "sk_file_key", "ended: the key file meanwhile");
  });
  assert.ok(lines.includes("[runner] auth: key"));
});

await check("a 401 moves to the next credential at once: a fresh token, or the key file when identity is off", async () => {
  resetAll();
  fileKey("sk_file_key");
  vmm.token = tokenAnswer({ token: "orgo_vm_a.sig" });
  assert.equal(await A.loadOrgoKey(), "orgo_vm_a.sig");
  A.orgoKeyRejected("orgo_vm_a.sig", "identity_stale");
  vmm.token = tokenAnswer({ token: "orgo_vm_b.sig" });
  assert.equal(await A.loadOrgoKey(), "orgo_vm_b.sig", "no wait for the key file's backoff");
  assert.equal(vmm.seen.at(-1).url, "/orgo/v1/identity/token?fresh=1");
  A.orgoKeyRejected("orgo_vm_b.sig", "vm_identity_off");
  assert.equal(await A.loadOrgoKey(), "sk_file_key", "identity off: the key file at once");
  // A 401 for the key file: read again only after its backoff, as before.
  A.orgoKeyRejected("sk_file_key");
  assert.equal(await A.loadOrgoKey(), "sk_file_key");
});

await check("a token for another account than the state's stops the runner; the same user's new token goes to Bops Cloud without the new-key line", async () => {
  resetAll();
  vmm.token = tokenAnswer({ token: "orgo_vm_u1.sig" });
  assert.equal(await A.loadOrgoKey(), "orgo_vm_u1.sig");
  vmm.token = tokenAnswer({ token: "orgo_vm_u1b.sig" });
  VT.box().last.refreshAt = 0;
  const lines = await logged(async () => {
    assert.equal(await A.loadOrgoKey(), "orgo_vm_u1b.sig");
  });
  assert.deepEqual(globalThis.__fake.bound, [{ user: "u1", key: "orgo_vm_u1b.sig" }], "Bops Cloud's calls carry the new one");
  assert.ok(!lines.some((l) => /new one|auth:/.test(l)), `no new-key line and no auth change: ${lines.join(" | ")}`);
  assert.ok(lines.every((l) => !l.includes("orgo_vm_")), "no token in a log");
  // The computer moved to another account.
  vmm.token = tokenAnswer({ token: "orgo_vm_u2.sig", user: "u2" });
  VT.box().last.refreshAt = 0;
  await logged(async () => {
    assert.equal(await A.loadOrgoKey(), null);
  });
  assert.deepEqual(left, ["this computer now belongs to another Orgo account"]);
});

await check("orgoKey() replaces a token that's due or turned down without making the caller wait", async () => {
  resetAll();
  vmm.token = tokenAnswer({ token: "orgo_vm_old.sig" });
  await A.loadOrgoKey();
  vmm.token = tokenAnswer({ token: "orgo_vm_new.sig" });
  VT.box().last.refreshAt = 0;
  globalThis.bopsRunnerAuth.identity.refreshAt = 0;
  assert.equal(A.orgoKey(), "orgo_vm_old.sig", "the one in hand, at once");
  await sleep(100);
  assert.equal(A.orgoKey(), "orgo_vm_new.sig", "then the new one");
});

await check("Orgo's calls on a turned-down token are made once more on the next credential; no token is ever logged", async () => {
  resetAll();
  const O = await import(`${root}/lib/server/orgo.ts`);
  vmm.token = tokenAnswer({ token: "orgo_vm_stale.sig" });
  const sent = [];
  const fetchWas = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const key = String(new Headers(init.headers).get("authorization") ?? "").replace(/^Bearer /, "");
    sent.push(key);
    if (key === "orgo_vm_stale.sig") return Response.json({ error: "stale", code: "identity_stale" }, { status: 401 });
    return Response.json({ id: C1, name: "boppy", status: "running" });
  };
  const lines = await logged(async () => {
    await A.loadOrgoKey();
    vmm.token = tokenAnswer({ token: "orgo_vm_fresh.sig" });
    assert.equal((await O.orgo.computer(C1)).id, C1, "answered on the second try");
  });
  globalThis.fetch = fetchWas;
  assert.deepEqual(sent, ["orgo_vm_stale.sig", "orgo_vm_fresh.sig"]);
  assert.equal(vmm.seen.at(-1).url, "/orgo/v1/identity/token?fresh=1");
  assert.ok(lines.every((l) => !l.includes("orgo_vm_")), `no token in a log: ${lines.join(" | ")}`);
});

/* ---------------- Which VM it's on: runner.ts watchIdentity ---------------- */

await check("its VMM asked every minute: another computer is a copy (it leaves), another VM of its own gets a new token", async () => {
  resetAll();
  const R = await import(`${root}/lib/server/runner.ts`);
  let copies = 0;
  R.runnerForTests.identity({ leave: () => void copies++, copyFiles: [] });
  vmm.token = tokenAnswer({ token: "orgo_vm_vma.sig", vm: "vm-a" });
  await A.loadOrgoKey();
  vmm.who = { status: 200, body: { desktop_id: C1, vm_id: "vm-a", state: "bound" } };
  await R.watchIdentity();
  assert.equal(copies, 0);
  // Woke on another VM: a new token now.
  vmm.who = { status: 200, body: { desktop_id: C1, vm_id: "vm-b", state: "bound" } };
  vmm.token = tokenAnswer({ token: "orgo_vm_vmb.sig", vm: "vm-b" });
  await R.watchIdentity();
  assert.equal(A.orgoKey(), "orgo_vm_vmb.sig");
  // A copy (a fork carries the runner on): its VMM names another computer.
  vmm.who = { status: 200, body: { desktop_id: C2, vm_id: "vm-c", state: "bound" } };
  const lines = await logged(() => R.watchIdentity());
  assert.equal(copies, 1);
  assert.ok(lines.some((l) => l.includes("is a copy")));
  // The copy check itself, by identity: nothing through Orgo.
  assert.equal(await R.checkIdentity(), "copy");
  vmm.who = { status: 200, body: { desktop_id: C1, vm_id: "vm-b", state: "bound" } };
  assert.equal(await R.checkIdentity(), "same");
  R.runnerForTests.reset();
});

await check("started on its own, a runner with no credential waits and starts on a key; a refused one stops", () => {
  const run = spawnSync(process.execPath, ["--conditions=react-server", new URL(import.meta.url).pathname, "--start"], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`.split("\n").filter((l) => /FAIL|passed|^\s{2}/.test(l)).join("\n"));
});

server.close();
rmSync(home.dir, { recursive: true, force: true });
console.log(`vm identity: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
