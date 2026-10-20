// Tests for a computer's Bops runner mode (BOPS_RUNNER=1, lib/server/runner.ts): the allow-list of what
// runs by itself there (persist.ts RUNNER_LOOPS: the routines timer, the mirror of its own routines, its
// own threads, the in-use beat; every other loop or timer of lib/server returns early, checked in each
// module that has one), what it starts with (runner-start.ts: refusing to start without a window token,
// on anything but loopback, on a Postgres or file store, or without its computer; without any credential
// it says so and waits for one; then the state, the look at which computer it's on, and only the
// allowed loops; its computer's identity first is test-vm-identity.mjs), its key (runner-key.ts: /root/.orgo-secrets.env, then /root/.env, shell quoting as Orgo
// writes it, only from a file nobody else can read, read again when Orgo answers 401, never logged, and
// never ORGO_API_KEY from its environment or a CLI login), no Keychain, the in-use beat as the runner's
// and only for its own tasks, and chooseWhere never picking the Mac there.
//
// The modules each one talks to are fakes (below), so nothing reaches Orgo, Bops Cloud or the Keychain.
// Usage: node --conditions=react-server scripts/test-runner-mode.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-runner-mode-"));

// Run again with --start, this checks how a runner starts on its own: there what it starts with is faked
// too (runner.ts, orgo-auth.ts, free-hours.ts), so only what it loads is seen. With --orgo, Orgo's client
// (orgo.ts) is the real one, against a fake Orgo: a runner's key as its calls use it.
const START = process.argv.includes("--start");
const ORGO = process.argv.includes("--orgo");

// Each faked module: its exports, each a call to globalThis.__fake[module][name] (or a value when it's one).
const FAKES = {
  store: ["getState", "update", "stateReady", "stateTooNew", "ownSession", "bot", "ownerName", "addMessage", "stateUser", "bindSignIn", "releaseSignOut", "pullState", "statePulledAt", ...(ORGO ? ["stateEpoch", "updateUnseen", "userDir"] : [])],
  decide: ["decide", "chose"],
  "full-access": ["fullAccessOn"],
  cloud: ["cloudOn", ...(ORGO ? ["cloudProxy"] : [])],
  ...(ORGO ? { usage: ["recordUsage"], "workspace-skills": ["folderKey", "moveWorkspaceFolder"] } : { orgo: ["orgo", "OrgoError"] }),
  plan: ["postOrgo"],
  local: ["CHROME"],
  "orgo-sign-in": ["authStatus"],
  routines: [],
  ...(START ? { runner: ["checkIdentity", "IDENTITY_EVERY_MS", "runnerComputer", "startRunsOn", "watchIdentity", "WHO_AM_I_EVERY_MS"], "orgo-auth": ["loadOrgoKey", "lookForRunnerKey"], "free-hours": ["startActivityBeat"] } : {}),
};
const VALUES = { local: { CHROME: "/nonexistent/Chrome" }, runner: { IDENTITY_EVERY_MS: 300000, WHO_AM_I_EVERY_MS: 60000 } };
const loaded = [];
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
    if (name) loaded.push(name);
    if (!name || !FAKES[name]) return next(url, context);
    const one = (n) => {
      if (VALUES[name]?.[n] !== undefined) return `export const ${n} = ${JSON.stringify(VALUES[name][n])};`;
      if (n === "orgo") return `export const orgo = new Proxy({}, { get: (_, k) => (...a) => globalThis.__fake.orgo.orgo[k](...a) });`;
      if (n === "OrgoError") return `export class OrgoError extends Error {}`;
      return `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(name)}].${n}(...a);`;
    };
    // routines.ts faked: importing it is the routines timer starting (noted).
    if (name === "routines") return { format: "module", shortCircuit: true, source: `globalThis.__fake.started.push("routines");` };
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

const C1 = "c1c1c1c1-0000-4000-8000-000000000001";
const state = { account: { user: { id: "u1" } }, bots: [{ id: "boppy", name: "Boppy", isMain: true, runsOn: "mac" }], sessions: [], routines: [], mac: { ready: true, rules: ["Notes"] } };
const posts = [];
let ready = true;
globalThis.__fake = {
  started: [],
  bound: [],
  store: {
    getState: () => state,
    update: (fn) => fn(state),
    stateReady: () => ready,
    stateTooNew: () => false,
    ownSession: (s) => (s.by ? s.by === "me" : process.env.BOPS_RUNNER !== "1"),
    bot: (id) => state.bots.find((b) => b.id === id),
    ownerName: () => "Sam",
    addMessage: () => {},
    stateUser: () => "u1",
    bindSignIn: async (user, key) => void globalThis.__fake.bound.push({ user, key }),
    releaseSignOut: async () => {},
    pullState: async () => {},
    statePulledAt: () => 0,
  },
  decide: { decide: async () => ({ where: { choice: "mac", confidence: 0.99 } }), chose: (x) => x },
  "full-access": { fullAccessOn: () => false },
  cloud: { cloudOn: () => true },
  orgo: { orgo: { computer: async () => ({ status: "running" }), resume: async () => ({}) } },
  plan: {
    postOrgo: async (key, path, body) => {
      posts.push({ path, body });
      return { status: 200, json: {} };
    },
  },
  "orgo-sign-in": { authStatus: async () => ({}) },
};

const asMac = () => {
  for (const k of ["BOPS_RUNNER", "BOPS_RUNNER_COMPUTER", "BOPS_DEVICE_SEED", "BOPS_UI_TOKEN", "HOSTNAME"]) delete process.env[k];
};
const asRunner = () => {
  process.env.BOPS_RUNNER = "1";
  process.env.BOPS_RUNNER_COMPUTER = C1;
};

/* ---------------- Starting (run on its own: node … --start) ---------------- */

const good = () => ({
  BOPS_RUNNER: "1",
  BOPS_UI_TOKEN: "a".repeat(64),
  HOSTNAME: "127.0.0.1",
  BOPS_RUNNER_COMPUTER: C1,
  BOPS_DEVICE_SEED: C1,
});

if (START) {
  await check("a runner makes sure of its computer, then starts the state, then only the loops it runs; refused or a copy, it stops", async () => {
    const calls = [];
    let tries = 0;
    let looks = ["unknown", "same"];
    ready = false;
    globalThis.__fake.runner = { checkIdentity: async () => (calls.push("identity"), looks.shift() ?? "same"), runnerComputer: () => C1, startRunsOn: () => calls.push("runs-on"), watchIdentity: async () => {} };
    globalThis.__fake["orgo-auth"] = { loadOrgoKey: async () => (calls.push("key"), "sk_runner"), lookForRunnerKey: async () => (calls.push("look"), "sk_runner") };
    globalThis.__fake["free-hours"] = { startActivityBeat: () => calls.push("in-use") };
    globalThis.__fake["orgo-sign-in"] = { authStatus: async () => (calls.push("state"), (ready = ++tries >= 2), {}) };
    Object.assign(process.env, good());
    const S = await import(`${root}/lib/server/runner-start.ts`);
    loaded.length = 0;
    const log = console.log;
    console.log = () => {};
    await S.startRunner();
    console.log = log;
    assert.deepEqual(calls, ["key", "identity", "identity", "state", "state", "runs-on", "in-use"], "key, which computer (again until Orgo says), the state (again until it loads), then its loops");
    assert.deepEqual(globalThis.__fake.started, ["routines"], "the routines timer");
    for (const m of ["mail", "phone", "channels", "cloud-tunnel", "bops-sync", "access-sync", "watches", "relay", "runner-install", "mac", "attention", "orbit-sync", "memory-categories", "sessions"])
      assert.ok(!loaded.includes(m), `${m} isn't started`);
    clearInterval(globalThis.__bopsRunnerIdentity);
    clearInterval(globalThis.__bopsRunnerWhoAmI);
    // Refused: out, before anything.
    const exit = process.exit;
    const err = console.error;
    let code;
    process.exit = (c) => {
      code = c;
      throw new Error("exited");
    };
    console.error = () => {};
    delete globalThis.__bopsRunnerStarted;
    calls.length = 0;
    process.env.HOSTNAME = "0.0.0.0";
    await assert.rejects(S.startRunner(), /exited/);
    assert.equal(code, 1);
    assert.deepEqual(calls, [], "nothing started");
    // No credential on its computer (no identity, no key): it waits, saying why, and looks again until one is there; never out (supervisord would only start it again, forever).
    delete globalThis.__bopsRunnerStarted;
    process.env.HOSTNAME = "127.0.0.1";
    globalThis.__bopsRunnerNoAuthMs = 5;
    globalThis.__fake["orgo-auth"].loadOrgoKey = async () => (calls.push("key"), null);
    let looks2 = 0;
    globalThis.__fake["orgo-auth"].lookForRunnerKey = async () => (calls.push("look"), ++looks2 >= 3 ? "sk_given_later" : null);
    looks = ["same"];
    ready = true;
    const said = [];
    const warn = console.warn;
    console.warn = (m) => said.push(String(m));
    console.log = () => {};
    await S.startRunner();
    console.log = log;
    console.warn = warn;
    clearInterval(globalThis.__bopsRunnerIdentity);
    clearInterval(globalThis.__bopsRunnerWhoAmI);
    delete globalThis.__bopsRunnerIdentity;
    delete globalThis.__bopsRunnerWhoAmI;
    assert.deepEqual(calls.slice(0, 5), ["key", "look", "look", "look", "identity"], "waits, looking again, then goes on");
    assert.deepEqual(said, ["[runner] waiting: no Orgo identity and no ORGO_API_KEY on this computer yet (Orgo writes the key when the computer is made, or when the Mac sets the runner up)"]);
    // A copy of another computer: out before it reads the state, so it never signs in or saves as that computer's runner.
    delete globalThis.__bopsRunnerStarted;
    calls.length = 0;
    globalThis.__fake.started.length = 0;
    looks = ["copy"];
    ready = false;
    globalThis.__fake["orgo-auth"].loadOrgoKey = async () => (calls.push("key"), "sk_runner");
    await assert.rejects(S.startRunner(), /exited/);
    assert.deepEqual(calls, ["key", "identity"], "no state read, no sign-in");
    process.exit = exit;
    console.error = err;
  });
  console.log(`runner start: ${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

/* ---------------- Its key as Orgo's client uses it (run on its own: node … --orgo) ---------------- */

/** A runner's computer: its key files in a folder of its own (only this user can enter it, as /root). */
function keyHome() {
  const dir = mkdtempSync(join(tmpdir(), "bops-runner-key-"));
  chmodSync(dir, 0o700);
  return { dir, secrets: join(dir, ".orgo-secrets.env"), env: join(dir, ".env") };
}

if (ORGO) {
  // Its computer's identity is test-vm-identity.mjs; here, a runner on its key file alone.
  process.env.BOPS_RUNNER_IDENTITY = "0";
  await check("a runner's calls use only its computer's key, and read it again when Orgo answers 401", async () => {
    const K = await import(`${root}/lib/server/runner-key.ts`);
    const O = await import(`${root}/lib/server/orgo.ts`);
    const home = keyHome();
    K.runnerKeyForTests.files([home.secrets, home.env]);
    asRunner();
    // Keys that must never be used on a runner: one in its environment, and a CLI login on its computer.
    process.env.ORGO_API_KEY = "sk_from_the_environment";
    process.env.HOME = home.dir;
    mkdirSync(join(home.dir, ".orgo"));
    writeFileSync(join(home.dir, ".orgo", "credentials.json"), JSON.stringify({ current: "default", profiles: { default: { apiKey: "sk_cli_login" } } }));
    const logged = [];
    const kept = { ...console };
    for (const k of ["log", "info", "warn", "error"]) console[k] = (...a) => logged.push(a.join(" "));
    try {
      // Orgo, faked: the key it takes now, and every key it was sent.
      let valid = "sk_first";
      const sent = [];
      globalThis.fetch = async (url, init = {}) => {
        const key = String(new Headers(init.headers).get("authorization") ?? "").replace(/^Bearer /, "");
        sent.push(key);
        return key === valid ? Response.json({ id: C1, name: "boppy", status: "running" }) : Response.json({ error: "Invalid API key" }, { status: 401 });
      };
      await assert.rejects(O.apiKey(), /No ORGO_API_KEY on this computer/, "no key on its computer: none, never the environment's or a CLI login");
      globalThis.bopsRunnerKeyRead.next = 0;
      writeFileSync(home.secrets, "export ORGO_API_KEY=sk_first\n", { mode: 0o600 });
      assert.equal(await O.apiKey(), "sk_first");
      assert.equal((await O.orgo.computer(C1)).id, C1);
      // Orgo wrote a new one on the computer (a restore in place, say): the next call is turned down, then the files are read again.
      valid = "sk_second";
      writeFileSync(home.secrets, "export ORGO_API_KEY=sk_second\n", { mode: 0o600 });
      assert.equal(await O.apiKey(), "sk_first", "kept while Orgo takes it");
      await assert.rejects(O.orgo.computer(C1), (e) => e.status === 401);
      assert.equal(await O.apiKey(), "sk_second", "read again after the 401");
      assert.equal((await O.orgo.computer(C1)).id, C1);
      assert.deepEqual(globalThis.__fake.bound.at(-1), { user: "u1", key: "sk_second" }, "Bops Cloud gets the new one too");
      // The same through callOrgo (the Mac's and the runner's direct calls).
      valid = "sk_third";
      writeFileSync(home.secrets, "export ORGO_API_KEY=sk_third\n", { mode: 0o600 });
      assert.equal((await O.callOrgo(await O.apiKey(), "/api/bops/settings"))?.status, 401);
      assert.equal(await O.apiKey(), "sk_third");
      // Turned down while the files still have the same one: read again only after a wait, twice as long each time.
      valid = "sk_fourth";
      assert.equal((await O.callOrgo(await O.apiKey(), "/api/bops/settings"))?.status, 401);
      assert.equal(await O.apiKey(), "sk_third", "the same one there");
      const wait = globalThis.bopsRunnerKeyRead.next - Date.now();
      assert.ok(wait > 3000 && wait <= 5000, `then a wait (${wait} ms)`);
      writeFileSync(home.secrets, "export ORGO_API_KEY=sk_fourth\n", { mode: 0o600 });
      assert.equal((await O.callOrgo(await O.apiKey(), "/api/bops/settings"))?.status, 401);
      assert.equal(await O.apiKey(), "sk_third", "not read again before the wait is over");
      globalThis.bopsRunnerKeyRead.next = 0;
      assert.equal(await O.apiKey(), "sk_fourth", "and after it");
      assert.equal(globalThis.bopsRunnerKeyRead.wait, 5000, "a new one starts the wait over");
      // Its key taken off the computer (Bops took it back): none, so it runs nothing.
      rmSync(home.secrets);
      valid = "none";
      assert.equal((await O.callOrgo(await O.apiKey(), "/api/bops/settings"))?.status, 401);
      await assert.rejects(O.apiKey(), /No ORGO_API_KEY on this computer/);
      assert.ok(!sent.includes("sk_from_the_environment") && !sent.includes("sk_cli_login"), "never another key");
      assert.ok(!logged.some((l) => /sk_(first|second|third|fourth)/.test(l)), `no key in a log: ${logged.join(" | ")}`);
    } finally {
      Object.assign(console, kept);
      rmSync(home.dir, { recursive: true, force: true });
    }
  });
  console.log(`runner orgo key: ${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

const P = await import(`${root}/lib/server/persist.ts`);

/* ---------------- The allow-list ---------------- */

await check("on a runner only the routines timer, its own routines' mirror, its own threads and the in-use beat run; on the Mac, all", () => {
  asMac();
  for (const l of [...P.RUNNER_LOOPS, ...P.MAC_LOOPS]) assert.equal(P.loopHere(l), true, `${l} on the Mac`);
  asRunner();
  assert.deepEqual([...P.RUNNER_LOOPS].sort(), ["in-use", "routine-sync", "routines", "sessions"]);
  for (const l of P.RUNNER_LOOPS) assert.equal(P.loopHere(l), true, `${l} on a runner`);
  for (const l of P.MAC_LOOPS) assert.equal(P.loopHere(l), false, `${l} not on a runner`);
  for (const l of ["watches", "digest", "access-sync", "bops-sync", "mail", "phone", "channels", "computer-checks", "relay", "zone", "codex", "free-computer", "tunnel", "runner-install"])
    assert.ok(P.MAC_LOOPS.includes(l), `${l} is the Mac's`);
  asMac();
});

// Every loop or timer in lib/server (an interval, a timeout at the top of a module, a watch on every
// change), by module: the Mac's are gated (loopHere("<name>"), or onRunner() in
// those that had it first), and the rest run on a runner only because they're its own or work for one
// request, task or view. A module with a new one fails here until it's in this list.
const GATED = {
  "watches.ts": ['loopHere("watches")'],
  "attention.ts": ['loopHere("digest")'],
  "mac.ts": ['loopHere("mac-check")'],
  "codex-cli.ts": ['loopHere("codex")'],
  "relay.ts": ['loopHere("relay")'],
  "mail.ts": ['loopHere("mail")'],
  "phone.ts": ['loopHere("phone")'],
  "channels.ts": ['loopHere("channels")'],
  "sessions.ts": ['loopHere("computer-checks")', 'loopHere("free-computer")'],
  "orgo-sign-in.ts": ['loopHere("free-computer")'],
  "cloud-tunnel.ts": ['loopHere("tunnel")'],
  "memory-categories.ts": ['loopHere("categories")'],
  "orbit-sync.ts": ['loopHere("orbit")'],
  "runner-install.ts": ['loopHere("runner-install")'],
  "access-sync.ts": ["onRunner()"],
  "bops-sync.ts": ["onRunner()"],
  "made-apps-sync.ts": ["if (!onRunner())", "if (onRunner() || !stateReady() || stateTooNew()) return;"],
  "routines.ts": ["onPostgres() || onRunner()"],
};
/** Run on a runner, and why. */
const ALLOWED = {
  "routines.ts": "the routines timer",
  "free-hours.ts": "the in-use beat (its own tasks)",
  "runner.ts": "asking Orgo where the bots work",
  "runner-start.ts": "the look at which computer it's on",
  "persist-cloud.ts": "the store: reading what changed elsewhere",
  "awake.ts": "the nap detector",
  "sessions.ts": "its own threads (each thread's own timers)",
  "cli-agents.ts": "one turn's",
  "mirror.ts": "one view's",
  "desktop.ts": "a page's script",
  "phone.ts": "one call's (the loop is startPhone's)",
  "channels.ts": "one link's (the listeners are startChannels')",
};
await check("every loop and timer in lib/server is the Mac's behind its gate, or one a runner runs", () => {
  const dir = `${root}/lib/server`;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const src = readFileSync(`${dir}/${f}`, "utf8");
    if (/setInterval\(|^setTimeout\(|watchChanges\(/m.test(src)) assert.ok(GATED[f] || ALLOWED[f], `${f} has a timer: gate it on a runner (persist.ts loopHere) or say here why a runner runs it`);
  }
  for (const [f, gates] of Object.entries(GATED)) {
    const src = readFileSync(`${dir}/${f}`, "utf8");
    for (const gate of gates) assert.ok(src.includes(gate), `${f} keeps it off a runner with ${gate}`);
  }
});

await check("on a runner the digest timer isn't set, Codex isn't installed, the Mac isn't looked at, and routing does nothing", async () => {
  asRunner();
  delete globalThis.bopsDigestTimer;
  await import(`${root}/lib/server/attention.ts`);
  assert.equal(globalThis.bopsDigestTimer, undefined, "no digest timer");
  const codex = await import(`${root}/lib/server/codex-cli.ts`);
  codex.installCodex();
  assert.equal(codex.installStatus(), undefined, "Codex never installed");
  let changed = 0;
  const was = globalThis.__fake.store.update;
  globalThis.__fake.store.update = (fn) => (changed++, fn(state));
  const mac = await import(`${root}/lib/server/mac.ts`);
  assert.equal(await mac.checkMac(), false);
  assert.equal(changed, 0, "no look at a Mac kept in the state");
  globalThis.__fake.store.update = was;
  asMac();
});

/* ---------------- Starting ---------------- */

const R = await import(`${root}/lib/server/runner-start.ts`);

await check("a runner refuses to start without a window token, off loopback, on Postgres or a file, or without its computer; its key is no setting of its own", () => {
  assert.equal(R.runnerRefusal(good()), null, "no key file setting needed: it reads its computer's");
  assert.equal(R.runnerRefusal({ ...good(), HOSTNAME: "::1" }), null);
  const no = (env, re) => assert.match(R.runnerRefusal({ ...good(), ...env }) ?? "", re, JSON.stringify(env));
  no({ BOPS_UI_TOKEN: undefined }, /BOPS_UI_TOKEN/);
  no({ BOPS_UI_TOKEN: "short" }, /BOPS_UI_TOKEN/);
  no({ HOSTNAME: undefined }, /HOSTNAME/);
  no({ HOSTNAME: "0.0.0.0" }, /HOSTNAME/);
  no({ HOSTNAME: "10.0.0.5" }, /HOSTNAME/);
  no({ HOSTNAME: "bops-computer" }, /HOSTNAME/);
  no({ BOPS_LISTEN_ALL: "1" }, /loopback only/);
  no({ BOPS_DATABASE_URL: "postgres://x" }, /Bops Cloud/);
  no({ BOPS_SELF_HOSTED: "1" }, /Bops Cloud/);
  no({ BOPS_RUNNER_COMPUTER: "not-an-id" }, /BOPS_RUNNER_COMPUTER/);
  no({ BOPS_DEVICE_SEED: "c2c2c2c2-0000-4000-8000-000000000002" }, /BOPS_DEVICE_SEED/);
});

await check("started on its own, a runner starts only what it runs", () => {
  const run = spawnSync(process.execPath, ["--conditions=react-server", new URL(import.meta.url).pathname, "--start"], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`.split("\n").filter((l) => /FAIL|passed|^\s{2}/.test(l)).join("\n"));
});

await check("a runner's calls to Orgo use only its computer's key, read again after a 401", () => {
  const run = spawnSync(process.execPath, ["--conditions=react-server", new URL(import.meta.url).pathname, "--orgo"], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`.split("\n").filter((l) => /FAIL|passed|^\s{2}/.test(l)).join("\n"));
});

/* ---------------- Its key, and no Keychain ---------------- */

await check("a runner's key: /root/.orgo-secrets.env, then /root/.env, as Orgo quotes it, only from a file nobody else can read; no Keychain, no sign-in", async () => {
  asRunner();
  const K = await import(`${root}/lib/server/runner-key.ts`);
  const A = await import(`${root}/lib/server/orgo-auth.ts`);
  const home = keyHome();
  K.runnerKeyForTests.files([home.secrets, home.env]);
  const warned = [];
  const warn = console.warn;
  console.warn = (m) => warned.push(String(m));
  const read = async (files, mode = 0o600, dirMode = 0o700) => {
    rmSync(home.secrets, { force: true });
    rmSync(home.env, { force: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(home[f], text, { mode });
    for (const f of Object.keys(files)) chmodSync(home[f], mode);
    chmodSync(home.dir, dirMode);
    return K.readRunnerKey();
  };
  assert.deepEqual(K.ORGO_KEY_FILES, ["/root/.orgo-secrets.env", "/root/.env"]);
  // As metal writes it when the computer is made: /root/.env alone, a quote inside written '\''.
  assert.equal(await read({ env: "export PATH=/usr/bin\nexport ORGO_API_KEY='sk_a'\\''b'\n[ -f /root/.orgo-secrets.env ] && . /root/.orgo-secrets.env\n" }), "sk_a'b");
  // As Orgo's PUT writes it (shlex.quote): it wins over the line made with the computer.
  assert.equal(await read({ secrets: "export ANTHROPIC_API_KEY=x\nexport ORGO_API_KEY=sk_new\n", env: "export ORGO_API_KEY='sk_old'\n" }), "sk_new");
  assert.equal(await read({ secrets: "export ORGO_API_KEY='sk with'\"'\"'quote'\n" }), "sk with'quote");
  assert.equal(await read({ secrets: 'ORGO_API_KEY="sk_dq\\$x"\n' }), "sk_dq$x", "double quotes, and no export");
  // The first file that has it wins; one that has none (or an empty one) doesn't count.
  assert.equal(await read({ secrets: "export OTHER=1\n", env: "export ORGO_API_KEY=sk_env\n" }), "sk_env");
  assert.equal(await read({ secrets: "export ORGO_API_KEY=''\n", env: "export ORGO_API_KEY=sk_env\n" }), "sk_env");
  assert.equal(await read({ env: "# export ORGO_API_KEY=sk_comment\nexport MY_ORGO_API_KEY=sk_x\n" }), null);
  assert.equal(await read({ env: "export ORGO_API_KEY=$(cat /tmp/k)\n" }), null, "never what a shell would expand");
  assert.equal(await read({}), null, "no files: none");
  // Who can read it: readable by others in a folder they can enter, not used (and said, without the key); in a folder only ours (/root), used.
  assert.equal(await read({ secrets: "export ORGO_API_KEY=sk_open\n" }, 0o644, 0o755), null);
  assert.ok(warned.some((m) => m.includes(".orgo-secrets.env can be read by others")) && !warned.some((m) => m.includes("sk_open")), warned.join(" | "));
  assert.equal(await read({ secrets: "export ORGO_API_KEY=sk_open\n", env: "export ORGO_API_KEY=sk_old\n" }, 0o644, 0o755), null, "the first that has it wins, so never an older one instead");
  assert.equal(await read({ secrets: "export ORGO_API_KEY=sk_private\n" }, 0o600, 0o755), "sk_private", "0600 anywhere");
  assert.equal(await read({ env: "export ORGO_API_KEY=sk_in_root\n" }, 0o644, 0o700), "sk_in_root", "0644 in a folder only ours");
  assert.equal(await read({ env: "export ORGO_API_KEY=sk_group\n" }, 0o640, 0o750), null, "readable by its group");
  console.warn = warn;
  // loadOrgoKey on a runner: its computer's key, never the Keychain (its identity skipped here: test-vm-identity.mjs).
  process.env.BOPS_RUNNER_IDENTITY = "0";
  await read({ secrets: "export ORGO_API_KEY=sk_runner_key\n" });
  delete globalThis.bopsOrgoKey;
  delete globalThis.bopsRunnerKeyRead;
  assert.equal(await A.loadOrgoKey(), "sk_runner_key");
  await assert.rejects(A.signIn("sk_other", { id: "u2" }), /Bops app on your Mac/);
  await assert.rejects(A.signOut(), /Bops app on your Mac/);
  const Kc = await import(`${root}/lib/server/keychain.ts`);
  assert.equal(await Kc.getSecret("anything"), null);
  await assert.rejects(Kc.setSecret("anything", "x"), /only in the Bops app on your Mac/);
  K.runnerKeyForTests.files(undefined);
  delete process.env.BOPS_RUNNER_IDENTITY;
  rmSync(home.dir, { recursive: true, force: true });
  asMac();
});

/* ---------------- In use, and where ---------------- */

await check("a runner says its computer is in use as the runner's, only while a task of its own runs", async () => {
  const F = await import(`${root}/lib/server/free-hours.ts`);
  globalThis.__fake.orgo.orgo = {};
  delete globalThis.bopsOrgoKey;
  // orgoKey comes from orgo-auth (real): the key in memory.
  globalThis.bopsOrgoKey = "sk_runner_key";
  asRunner();
  posts.length = 0;
  await F.sayInUse();
  assert.equal(posts.length, 0, "nothing running: nothing said (not even once)");
  state.sessions = [{ id: "s1", status: "running", runsOn: "cloud", by: "mac-device" }];
  await F.sayInUse();
  assert.equal(posts.length, 0, "another Bops's task isn't this one's to say");
  state.sessions = [{ id: "s2", status: "running", runsOn: "cloud", by: "me" }];
  await F.sayInUse();
  assert.deepEqual(posts, [{ path: "/api/bops/computer/active", body: { via: "runner" } }]);
  asMac();
  posts.length = 0;
  state.sessions = [];
  delete globalThis.bopsActivitySaid;
  await F.sayInUse();
  assert.deepEqual(posts, [{ path: "/api/bops/computer/active", body: {} }], "the Mac says it once as it opens, as before");
});

await check("chooseWhere never picks the Mac on a runner", async () => {
  const W = await import(`${root}/lib/server/where.ts`);
  asMac();
  assert.equal(await W.chooseWhere("boppy", "Write it in Notes on my Mac"), "mac", "the Mac picks it there");
  asRunner();
  assert.equal(await W.chooseWhere("boppy", "Write it in Notes on my Mac"), "cloud", "the words");
  assert.equal(await W.chooseWhere("boppy", "Check the news", "mac"), "cloud", "asked for outright");
  assert.equal(await W.chooseWhere("boppy", "Check the news"), "cloud", "a bot set to work on the Mac");
  assert.equal(await W.chooseWhere("boppy", "Check the news", "auto", { outside: true }), "cloud");
  asMac();
});

rmSync(scratch, { recursive: true, force: true });
console.log(`runner mode: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
