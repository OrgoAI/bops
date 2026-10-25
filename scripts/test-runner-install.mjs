// Tests for setting Bops runners up on the bots' computers and stopping them (lib/server/runner-install.ts),
// against a fake Orgo: which computers get one (each a bot works on, as Orgo's map and this Mac both have
// it), what goes to a computer (no command ever carries a key, the window token or the upload's link), the
// version rules (never an older one over a newer; the same version again only from the Mac that set it up
// last; one that's up stays up while it's set up again, and isn't set up again while a run of its goes), a copy
// of a computer that has the build already,
// the computer's own Orgo key (one it came with is left alone; one without is given it by Orgo, and only
// that one is taken back at the stop, an entry from before keyMade too), none where someone else can use
// the workspace, the health check (loopback only), a runner marked up that's gone from its computer, a
// computer down or asleep with its routines overdue (they wait for it, saying why: never the Mac's for it),
// Orgo's copy of the routines following each runner up or down, and the stop (This Mac, the bots in
// browsers on the Mac, a computer deleted, no bot on it any more: taken off, the key Bops gave revoked by
// any Mac, its threads ended). What the runner signs in with (the health check's auth=, kept as
// RunnerState.auth), its computer's identity in this release (phase 1: the key step as before, whatever
// identity answers), the way back (a runner with no key and no identity it can use gets its key again,
// and is started), and phase 2 behind IDENTITY_ONLY (each row of the identity spec's 4.5 table, a key
// taken back only once the new build runs on identity). The commands it sends are checked as shell too.
//
// The store, Orgo, storage and the modules it talks to are fakes (below): nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-runner-install.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { unfaked } from "./fake-exports.mjs";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
process.env.BOPS_ORGO_ORIGIN = "https://orgo.example";
process.env.BOPS_CLOUD_URL = "https://bops.example/api";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const FAKES = {
  store: ["flushState", "getState", "stateDevice", "stateInCloud", "stateReady", "stateTooNew", "update"],
  members: ["othersCanUse", "forgetGoneMembers"],
  orgo: ["apiKey", "callOrgo", "orgo"],
  "orgo-auth": ["orgoOrigin"],
  "persist-cloud": ["deviceIdFor"],
  runner: ["heardRunsOn", "noteDown", "overdueOn", "runnerRunsOn", "runsOnMissing", "RUNNER_CONF", "RUNNER_WRAPPER"],
  sessions: ["computerGone", "endSessionOf", "endSessionsOf"],
  "routine-sync": ["mendRoutineCopies", "routineChanged"],
  permission: ["wakeForAnswers"],
};
const VALUES = { runner: { RUNNER_CONF: "/etc/supervisor/conf.d/bops-runner.conf", RUNNER_WRAPPER: "/opt/bops/runner/run.sh" } };
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
    const one = (n) => {
      if (VALUES[name]?.[n] !== undefined) return `export const ${n} = ${JSON.stringify(VALUES[name][n])};`;
      if (n === "orgo") return `export const orgo = new Proxy({}, { get: (_, k) => (...a) => globalThis.__fake.orgo.orgo[k](...a) });`;
      return `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(name)}].${n}(...a);`;
    };
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

const PID = "11111111-2222-4333-8444-555555555555";
const C1 = "c1c1c1c1-0000-4000-8000-000000000001";
const C2 = "c2c2c2c2-0000-4000-8000-000000000002";
const ME = "mac-me";
const MAC_KEY = "sk_mac_key_that_never_leaves_the_mac";
const RUNNER_KEY = "sk_runner_key_orgo_writes_itself";
const UPLOAD_URL = "https://storage.example/put?X-Amz-Signature=SIGNED_SECRET";
const UPLOAD_TOKEN = "upload_token_secret_value";

// The app's bundle, as scripts/server-bundle.sh writes it, in a dev Mac's dist-runner.
const scratch = mkdtempSync(join(tmpdir(), "bops-runner-install-"));
mkdirSync(join(scratch, "dist-runner"));
const BUNDLE = "bops-server-0.0.29-buildA1.tgz";
const BYTES = Buffer.from("not really a tarball, but the bytes the computer gets");
const SHA = createHash("sha256").update(BYTES).digest("hex");
function bundle(name = BUNDLE, bytes = BYTES) {
  writeFileSync(join(scratch, "dist-runner", name), bytes);
  writeFileSync(join(scratch, "dist-runner", `${name}.sha256`), `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`);
}
process.chdir(scratch);

/* ---------------- The fakes ---------------- */

const state = {};
function fresh() {
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, {
    account: { user: { id: "u1" } },
    owner: { name: "Sam", timeZone: "America/New_York" },
    workspaces: [{ id: "ws_main", name: "Main", createdAt: 0, orgoProjectId: PID }],
    bots: [
      { id: "boppy", name: "Boppy", isMain: true, computerId: C1, computerStatus: "ready" },
      { id: "otto", name: "Otto", isMain: false, computer: "shared", computerStatus: "none" },
    ],
    sessions: [],
    routines: [],
  });
}

/** Orgo, faked: each computer as Orgo has it, every call and command kept. */
const orgo = {};
function freshOrgo() {
  Object.assign(orgo, {
    calls: [],
    bash: [],
    puts: [],
    mode: "cloud",
    missing: false,
    full: false,
    keyRefusal: null,
    deleteAnswer: null,
    map: [C1],
    health: "__BOPS_HEALTHY__",
    keys: 0,
    computers: { [C1]: { status: "running", current: "", key: false, have: new Set(), program: false } },
    ended: [],
    /** The devices whose runs were ended for good (endSessionsOf with gone): one paused for the owner's OK too. */
    endedForGood: [],
    endedOne: [],
    changed: [],
    mends: 0,
    answerWakes: 0,
    // What each look found of a computer its routines wait on (runner.ts noteDown): [id, Orgo's status], null when it's up.
    down: [],
    overdue: false,
    mapStatus: undefined,
    uploadFails: false,
    duringInstall: null,
    supervisor: "bops-runner                      RUNNING   pid 812, uptime 1:02:03",
    // What the computer's identity answers (curl's status code: 000 when nothing does), and what the runner says it signs in with.
    ident: "000",
    auth: "key",
    starts: 0,
    installFails: false,
  });
}
const pc = (c) => orgo.computers[c];
globalThis.__fake = {
  store: {
    getState: () => state,
    update: (fn) => fn(state),
    flushState: async () => true,
    stateDevice: () => ME,
    stateInCloud: () => true,
    stateReady: () => true,
    stateTooNew: () => false,
  },
  members: { othersCanUse: async () => orgo.full, forgetGoneMembers: async () => {} },
  "orgo-auth": { orgoOrigin: () => process.env.BOPS_ORGO_ORIGIN },
  "persist-cloud": { deviceIdFor: (user, seed) => `device:${user}:${seed}` },
  runner: {
    heardRunsOn: () => orgo.mode,
    runsOnMissing: () => orgo.missing,
    overdueOn: () => orgo.overdue,
    // Every routine is its computer's runner's (scripts/test-runner.mjs checks the ones that left it).
    runnerRunsOn: () => true,
    // As runner.ts keeps it: in the state (RunnerState.down), noted only when it changes.
    noteDown: (id, status) => {
      const x = state.runners?.[id];
      if (!x || (status === undefined ? !x.down : x.down?.status === status)) return;
      orgo.down.push([id, status ?? null]);
      if (status === undefined) delete x.down;
      else x.down = { status, at: Date.now() };
    },
  },
  "routine-sync": { mendRoutineCopies: async () => void orgo.mends++, routineChanged: (botId) => orgo.changed.push(botId) },
  // Each look wakes the computers whose runs wait on an answer (permission.ts, tested in test-computer-task.mjs).
  permission: { wakeForAnswers: async () => void orgo.answerWakes++ },
  sessions: {
    computerGone: (e) => e?.status === 404,
    endSessionsOf: (device, why, opts) => {
      orgo.ended.push({ device, why });
      if (opts?.gone) orgo.endedForGood.push(device);
    },
    endSessionOf: (sessionId, device, why) => orgo.endedOne.push({ sessionId, device, why }),
  },
  orgo: {
    apiKey: async () => MAC_KEY,
    callOrgo: async (key, path, init = {}) => {
      const c = { key, path, method: init.method ?? "GET", body: init.body };
      orgo.calls.push(c);
      if (path === `/api/projects/${PID}/bops`) return orgo.mapStatus ? { status: orgo.mapStatus, json: {} } : { status: 200, json: { bots: orgo.map.map((d, i) => ({ bopsId: `b${i}`, desktopId: d })) } };
      // The computer's own key (orgo-web PUT and DELETE /api/computers/{id}/orgo-key): Orgo writes it on the computer, and takes it off a computer that's up.
      const k = /^\/api\/computers\/([^/?]+)\/orgo-key$/.exec(path);
      if (k && c.method === "PUT") {
        if (orgo.keyRefusal) return orgo.keyRefusal;
        pc(k[1]).key = true;
        return { status: 200, json: { keyId: `key-${++orgo.keys}` } };
      }
      if (k && c.method === "DELETE") {
        if (orgo.deleteAnswer) return orgo.deleteAnswer;
        const x = pc(k[1]);
        if (x?.status === "running") x.key = false;
        return { status: 200, json: { revoked: true, removed: x?.status === "running" } };
      }
      if (path === "/api/files/uploads") return orgo.uploadFails ? { status: 503, json: {} } : { status: 200, json: { upload_url: UPLOAD_URL, upload_token: UPLOAD_TOKEN } };
      if (path === "/api/files/uploads/complete") {
        assert.equal(init.body.upload_token, UPLOAD_TOKEN);
        pc(init.body.desktopId).incoming = true;
        return { status: 200, json: { ok: true } };
      }
      return { status: 404, json: {} };
    },
    orgo: {
      computer: async (id) => {
        const x = pc(id);
        if (!x) throw Object.assign(new Error("gone"), { status: 404 });
        return { id, status: x.status };
      },
      bash: async (id, command) => {
        orgo.bash.push({ id, command });
        const x = pc(id);
        if (!x) throw Object.assign(new Error("gone"), { status: 404 });
        // A command wakes a computer that's asleep (Orgo's auto-resume), never one stopped, frozen or in error: it can't reach it.
        if (["stopped", "frozen", "error"].includes(x.status)) throw Object.assign(new Error("Computer not ready"), { status: 503 });
        x.status = "running";
        if (command.includes('echo "current=$c"')) {
          const dir = /\/opt\/bops\/runner\/([^/ ]+)\/server\.js/.exec(command)[1];
          const ident = command.includes('echo "ident=') ? `ident=${orgo.ident}\n` : "";
          return { output: `current=${x.current}\nkey=${x.key ? "yes" : "no"}\n${ident}have=${x.have.has(dir) ? "yes" : "no"}\nsup=yes\n`, exit_code: 0 };
        }
        if (command.includes("__BOPS_INSTALLED__")) {
          orgo.duringInstall?.();
          if (orgo.installFails) return { output: "tar: something went wrong\n", exit_code: 2 };
          const dir = /mv -Tf "\$d\/current\.next"/.test(command) && /ln -sfn '([^']+)'/.exec(command)[1];
          // As the script does: the upload unpacked when it's there (and gone after), else the build there already, else nothing.
          const usesBuildThere = command.includes(`elif [ ! -f "$d/${dir}/server.js" ]; then`);
          if (!x.incoming && !(usesBuildThere && x.have.has(dir))) return { output: usesBuildThere ? "__BOPS_NO_FILES__\n" : "sha256sum: bops-server.tgz: No such file or directory\n", exit_code: usesBuildThere ? 3 : 1 };
          x.incoming = false;
          x.have.add(dir);
          x.current = dir;
          x.program = true;
          x.wrapper = /cat > \/opt\/bops\/runner\/run\.sh <<'BOPS_EOF'\n([\s\S]*?)BOPS_EOF/.exec(command)[1];
          return { output: "__BOPS_INSTALLED__\n", exit_code: 0 };
        }
        if (command.includes("__BOPS_HEALTHY__")) return { output: `${orgo.health === "__BOPS_HEALTHY__" ? `auth=${orgo.auth}\n` : ""}${orgo.health}\n`, exit_code: 0 };
        if (command.includes("__BOPS_OFF__")) {
          // As the script does: the program, its script and the builds, never the computer's key.
          Object.assign(x, { current: "", have: new Set(), program: false });
          return { output: "__BOPS_OFF__\n", exit_code: 0 };
        }
        if (/^supervisorctl stop bops-runner/.test(command)) {
          x.program = false;
          return { output: "", exit_code: 0 };
        }
        if (/^supervisorctl status bops-runner/.test(command)) return { output: `${orgo.supervisor}\nkey=${x.key ? "yes" : "no"}\nident=${orgo.ident}\nauth=${orgo.auth}\n__BOPS_STATUS_END__\n`, exit_code: 0 };
        if (/^supervisorctl start bops-runner/.test(command)) {
          orgo.starts++;
          orgo.supervisor = "bops-runner                      RUNNING   pid 900, uptime 0:00:01";
          return { output: "", exit_code: 0 };
        }
        return { output: "", exit_code: 0 };
      },
    },
  },
};
// Storage, faked: the bytes go straight there, with nothing of Orgo's.
globalThis.fetch = async (url, init = {}) => {
  orgo.puts.push({ url, method: init.method, headers: init.headers, size: init.body?.length });
  return new Response(null, { status: 200 });
};

const I = await import(`${root}/lib/server/runner-install.ts`);
const T = I.runnerInstallForTests;

function reset() {
  fresh();
  freshOrgo();
  T.reset();
  rmSync(join(scratch, "dist-runner"), { recursive: true, force: true });
  mkdirSync(join(scratch, "dist-runner"));
  bundle();
}
const runner = (id = C1) => state.runners?.[id];
const bashText = () => orgo.bash.map((b) => b.command).join("\n");
/** Nothing secret in any command sent to a computer. */
function noSecrets() {
  const all = bashText();
  for (const secret of [MAC_KEY, RUNNER_KEY, UPLOAD_URL, UPLOAD_TOKEN, "SIGNED_SECRET"]) assert.ok(!all.includes(secret), `a command carries ${secret}`);
  assert.ok(!/BOPS_UI_TOKEN=(?!\$\()/.test(all), "the window token is made on the computer, never sent");
  assert.ok(!/sk_[A-Za-z0-9]/.test(all), "no Orgo key at all");
}

/* ---------------- Setting one up ---------------- */

await check("in the Cloud, a bot's computer without its key gets a runner: its files, its key from Orgo (keyMade), its program, a health check; nothing secret in any command", async () => {
  reset();
  await I.lookAtRunners();
  const x = runner();
  assert.equal(x?.status, "running", JSON.stringify(x));
  assert.deepEqual([x.version, x.buildId, x.by, x.keyMade, x.keyId], ["0.0.29", "buildA1", ME, true, "key-1"]);
  assert.equal(orgo.mends, 1, "the look puts Orgo's copy of the routines right too (routine-sync.ts mendRoutineCopies)");
  for (let i = 0; i < 100 && orgo.answerWakes < 1; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(orgo.answerWakes, 1, "the look wakes a computer whose run waits on an answer (permission.ts wakeForAnswers)");
  assert.ok(!("keyBy" in x));
  assert.equal(pc(C1).current, "0.0.29-buildA1");
  assert.ok(pc(C1).program, "its program is on");
  const steps = orgo.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(steps, [`GET /api/projects/${PID}/bops`, `PUT /api/computers/${C1}/orgo-key`, "POST /api/files/uploads", "POST /api/files/uploads/complete"]);
  assert.equal(orgo.calls[1].body, undefined, "no body: nothing secret goes to Orgo, and Orgo names the key for the computer");
  const probe = orgo.bash.find((b) => b.command.includes('echo "current=$c"')).command;
  assert.ok(probe.includes("grep -qsE ") && probe.includes("/root/.orgo-secrets.env /root/.env && echo key=yes || echo key=no"), "the key looked for in both files, by grep alone");
  assert.ok(!/\bcat\b[^\n]*\/root\/\.(orgo-secrets\.)?env/.test(probe), "never printed");
  assert.deepEqual(orgo.calls[2].body, { desktopId: C1, filename: BUNDLE, size_bytes: BYTES.length, destPath: "/opt/bops/runner/incoming" });
  assert.equal(orgo.puts.length, 1);
  assert.equal(orgo.puts[0].url, UPLOAD_URL);
  assert.equal(orgo.puts[0].method, "PUT");
  assert.equal(orgo.puts[0].headers, undefined, "nothing of Orgo's (no key) goes to storage");
  assert.equal(orgo.puts[0].size, BYTES.length);
  noSecrets();
  const install = orgo.bash.find((b) => b.command.includes("__BOPS_INSTALLED__")).command;
  assert.match(install, /flock -w 120 9/);
  assert.ok(install.includes(`printf '%s  %s\\n' '${SHA}' '${BUNDLE}' | sha256sum -c --status`), "checked against its sha256");
  assert.match(install, /mv -Tf "\$d\/current\.next" "\$d\/current"/, "current switched in one rename");
  assert.match(install, /\[program:bops-runner\]\ncommand=\/opt\/bops\/runner\/run\.sh/);
  assert.match(install, /autorestart=true/);
  assert.match(install, /supervisorctl reread[^\n]*\nsupervisorctl update/);
  const w = pc(C1).wrapper;
  for (const want of ["export BOPS_UI_TOKEN", "HOSTNAME=127.0.0.1", "PORT=3210", "NEXT_MANUAL_SIG_HANDLE=true", "BOPS_RUNNER=1", `BOPS_RUNNER_COMPUTER='${C1}'`, `BOPS_DEVICE_SEED='${C1}'`, "TZ='America/New_York'", "BOPS_ORGO_ORIGIN='https://orgo.example'", "BOPS_CLOUD_URL='https://bops.example/api'", "exec /usr/bin/node server.js"])
    assert.ok(w.includes(want), `the wrapper has ${want}`);
  for (const not of ["BOPS_ORGO_KEY_FILE", "ORGO_API_KEY", ".orgo-secrets.env", "/root/.env"]) assert.ok(!w.includes(not) && !install.includes(not), `neither the wrapper nor the program has ${not}: the runner reads its key itself`);
  const health = orgo.bash.find((b) => b.command.includes("__BOPS_HEALTHY__")).command;
  assert.match(health, /curl -fsS --max-time 3 -o \/dev\/null http:\/\/127\.0\.0\.1:3210\/api\/health/);
  assert.match(health, /ss -ltnH 'sport = :3210'/);
  assert.ok(health.includes("grep -qv '^127\\.0\\.0\\.1:'"), "listening only on loopback");
  assert.ok(health.includes("grep -q '^\\[runner\\] running the routines' /var/log/bops/runner.log"), "and has the state (its log says it runs)");
  assert.ok(install.includes(": > /var/log/bops/runner.log"), "this start's log");
});

await check("a computer that came with its key (a template that asks for it): no PUT, keyMade unset, and the stop leaves its key alone", async () => {
  reset();
  pc(C1).key = true;
  await I.lookAtRunners();
  const x = runner();
  assert.equal(x?.status, "running", JSON.stringify(x));
  assert.deepEqual([x.keyMade, x.keyId], [undefined, undefined], "not Bops' key");
  assert.ok(!orgo.calls.some((c) => c.path.includes("/orgo-key")), "Orgo isn't asked for a key");
  orgo.mode = "mac";
  await I.lookAtRunners();
  assert.equal(runner(), undefined, "stopped and out of the state");
  assert.equal(pc(C1).program, false, "taken off its computer");
  assert.equal(pc(C1).key, true, "its key stays: the computer's, revoked with it");
  assert.ok(!orgo.calls.some((c) => c.path.includes("/orgo-key")), "and never revoked by Bops");
  // Set up again later (a new release): still the computer's own, and still not marked as Bops'.
  reset();
  pc(C1).key = true;
  pc(C1).current = "0.0.28-old";
  state.runners = { [C1]: { status: "running", version: "0.0.28", buildId: "old", by: ME, at: Date.now() } };
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().version, runner().keyMade], ["running", "0.0.29", undefined]);
  assert.ok(!orgo.calls.some((c) => c.path.includes("/orgo-key")));
});

await check("the key Bops gave is kept across a set-up again, and taken back once at the stop (200 or 404 is done)", async () => {
  reset();
  await I.lookAtRunners();
  assert.deepEqual([runner().keyMade, runner().keyId], [true, "key-1"]);
  // A newer release: the computer has the key Bops gave it, so it isn't asked for again, and it stays Bops' to take back.
  rmSync(join(scratch, "dist-runner"), { recursive: true, force: true });
  mkdirSync(join(scratch, "dist-runner"));
  bundle("bops-server-0.0.30-buildB2.tgz");
  orgo.calls.length = 0;
  T.reset();
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().version, runner().keyMade, runner().keyId], ["running", "0.0.30", true, "key-1"]);
  assert.ok(!orgo.calls.some((c) => c.path.includes("/orgo-key")), "no new key");
  // The stop: Orgo already forgot it (404): done all the same.
  orgo.deleteAnswer = { status: 404, json: { code: "key_not_found" } };
  orgo.mode = "mac";
  await I.lookAtRunners();
  assert.equal(runner(), undefined);
  assert.equal(orgo.calls.filter((c) => c.method === "DELETE" && c.path === `/api/computers/${C1}/orgo-key`).length, 1);
  // Orgo didn't answer the revoke: it stays Stopping with the key still Bops' to take back, and the next look tries again.
  reset();
  await I.lookAtRunners();
  orgo.deleteAnswer = { status: 503, json: {} };
  orgo.mode = "mac";
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().keyMade], ["stopping", true]);
  orgo.deleteAnswer = null;
  await I.lookAtRunners();
  assert.equal(runner(), undefined, "revoked, and out of the state");
});

await check("set up and up to date: nothing more is sent, and a computer asleep isn't woken", async () => {
  reset();
  await I.lookAtRunners();
  orgo.calls.length = 0;
  orgo.bash.length = 0;
  pc(C1).status = "suspended";
  await I.lookAtRunners();
  assert.equal(orgo.bash.length, 0, "no command (a command would wake it)");
  assert.equal(pc(C1).status, "suspended");
  assert.ok(!orgo.calls.some((c) => c.method !== "GET"), "nothing but reads");
});

await check("a computer asleep is never woken to set a runner up: not to upgrade one that's up after a Bops update, not for a first one, not to try again one that didn't start; up, it's set up", async () => {
  // An older runner up on a computer asleep, nothing overdue, nothing running there: the 0.0.29 bundle waits for it.
  reset();
  pc(C1).key = true;
  pc(C1).current = "0.0.28-old";
  pc(C1).have = new Set(["0.0.28-old"]);
  pc(C1).status = "suspended";
  state.runners = { [C1]: { status: "running", version: "0.0.28", buildId: "old", by: ME, keyMade: true, keyId: "key-0", at: Date.now() - 86_400_000 } };
  await I.lookAtRunners();
  assert.equal(orgo.bash.length, 0, "no command: one would wake it");
  assert.equal(pc(C1).status, "suspended", "still asleep");
  assert.deepEqual([runner().status, runner().version, runner().upgrading], ["running", "0.0.28", undefined], "the old runner kept as it is");
  // None there yet (the first look in the Cloud), and one that didn't start, after a Bops restart (no backoff in memory).
  for (const before of [undefined, { status: "failed", version: "0.0.29", buildId: "buildA1", by: ME, error: "its computer didn't answer", at: Date.now() - 60_000 }]) {
    reset();
    pc(C1).status = "suspended";
    state.runners = before ? { [C1]: before } : undefined;
    await I.lookAtRunners();
    assert.equal(orgo.bash.length, 0, `${before ? "failed" : "none"}: no command`);
    assert.equal(pc(C1).status, "suspended", `${before ? "failed" : "none"}: still asleep`);
    assert.ok(!orgo.calls.some((c) => c.method !== "GET"), `${before ? "failed" : "none"}: nothing asked of Orgo for it but reads (no key put on it)`);
  }
  // Up (for something real: a due routine, the owner opening its screen): set up at the next look.
  pc(C1).status = "running";
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().version], ["running", "0.0.29"]);
});

await check("versions: a newer one replaces it, never an older one; the same version again only from the Mac that set it up last", async () => {
  const mine = { version: "0.0.29", buildId: "b2" };
  const x = (o) => ({ status: "running", version: "0.0.29", buildId: "b1", by: ME, at: Date.now(), ...o });
  assert.equal(I.installPlan(undefined, mine, ME), "install", "none there");
  assert.equal(I.installPlan(x({ version: "0.0.28" }), mine, ME), "install", "an older one");
  assert.equal(I.installPlan(x({ version: "0.0.28", by: "other" }), mine, ME), "install", "an older one of another Mac's");
  assert.equal(I.installPlan(x({ version: "0.0.30" }), mine, ME), "keep", "never downgraded");
  assert.equal(I.installPlan(x({ version: "0.1.0", status: "failed" }), mine, ME), "keep", "nor over a newer one that didn't start");
  assert.equal(I.installPlan(x({ buildId: "b2" }), mine, ME), "keep", "the same build, up");
  assert.equal(I.installPlan(x({ buildId: "b2", status: "failed" }), mine, ME), "install", "the same build, tried again");
  assert.equal(I.installPlan(x({}), mine, ME), "install", "the same version built again here (a dev Mac)");
  assert.equal(I.installPlan(x({ by: "other" }), mine, ME), "keep", "the same version from another Mac: theirs");
  assert.equal(I.installPlan(x({ status: "installing", by: "other", version: "0.0.28" }), mine, ME), "wait", "another Mac is setting it up");
  assert.equal(I.installPlan(x({ status: "installing", by: "other", version: "0.0.28", at: Date.now() - 21 * 60_000 }), mine, ME), "install", "one that's been at it 20 minutes stopped");
  assert.equal(I.installPlan(x({ status: "stopping" }), mine, ME), "install", "wanted again");
  assert.ok(I.compareVersions("0.0.10", "0.0.9") > 0 && I.compareVersions("0.1.0", "0.0.99") > 0 && I.compareVersions("1.2.3", "1.2.3") === 0);
  // As a look does it: a newer runner of another Mac's is left as it is; an older one is replaced, keeping its key.
  reset();
  state.runners = { [C1]: x({ version: "0.0.31", by: "other", keyMade: true, keyId: "key-other" }) };
  await I.lookAtRunners();
  assert.equal(orgo.bash.length, 0);
  assert.equal(runner().version, "0.0.31");
  reset();
  pc(C1).key = true;
  pc(C1).current = "0.0.28-old";
  state.runners = { [C1]: x({ version: "0.0.28", buildId: "old", by: "other", keyMade: true, keyId: "key-other" }) };
  await I.lookAtRunners();
  assert.equal(runner().status, "running");
  assert.equal(runner().version, "0.0.29");
  assert.deepEqual([runner().keyMade, runner().keyId], [true, "key-other"], "the key another Mac had Orgo give it stays Bops' to take back");
  assert.ok(!orgo.calls.some((c) => c.path.includes("/orgo-key")), "no new key, and theirs isn't revoked");
  // The computer has a newer one than the state says: it's never replaced.
  reset();
  pc(C1).current = "0.0.40-newer";
  await I.lookAtRunners();
  assert.equal(runner().version, "0.0.40", "the one there, kept");
  assert.ok(!bashText().includes("__BOPS_INSTALLED__"));
});

await check("someone else can use the workspace: no runner, nothing on the computer, and one up is stopped; Orgo's other refusals say why", async () => {
  reset();
  orgo.full = true;
  await I.lookAtRunners();
  assert.equal(runner().status, "failed");
  assert.equal(runner().error, "someone else can use this workspace");
  assert.equal(orgo.bash.length, 0, "nothing sent to the computer");
  assert.ok(!orgo.calls.some((c) => c.path.includes("/orgo-key") || c.path.includes("/files/")));
  // Orgo says so itself (it sees a share link too): the same, and a wait before the next try, which would wake the computer again.
  reset();
  orgo.keyRefusal = { status: 409, json: { code: "full_access_member", error: "Someone else can use this workspace." } };
  await I.lookAtRunners();
  assert.equal(runner().error, "someone else can use this workspace");
  assert.equal(runner().keyMade, undefined);
  assert.ok(T.retryAt(C1) > Date.now(), "tried again later, not on every look");
  const asked = orgo.bash.length;
  await I.lookAtRunners();
  assert.equal(orgo.bash.length, asked, "the next look doesn't wake the computer");
  assert.ok(!bashText().includes("__BOPS_INSTALLED__"));
  // Only the workspace's owner may: said so, and tried again later.
  reset();
  orgo.keyRefusal = { status: 403, json: { code: "owner_only", error: "Only the owner of this workspace can do that." } };
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().error], ["failed", "only the workspace's owner can set a runner up there"]);
  assert.ok(T.retryAt(C1) > Date.now(), "tried again later");
  // An Orgo without the route, and a computer that isn't Linux.
  for (const [status, error] of [
    [404, "Orgo can't set up a runner on it yet"],
    [405, "Orgo can't set up a runner on it yet"],
    [422, "a runner needs a Linux computer"],
    [503, "Orgo didn't give its computer its key"],
  ]) {
    reset();
    orgo.keyRefusal = { status, json: {} };
    await I.lookAtRunners();
    assert.deepEqual([runner().status, runner().error, runner().keyMade], ["failed", error, undefined], String(status));
    assert.ok(!bashText().includes("__BOPS_INSTALLED__"));
  }
  // Someone else can use it after it was set up: stopped and taken off, the key Bops gave revoked.
  reset();
  await I.lookAtRunners();
  orgo.full = true;
  await I.lookAtRunners();
  assert.equal(runner().error, "someone else can use this workspace");
  assert.deepEqual([runner().keyMade, runner().keyId], [undefined, undefined], "its key revoked");
  assert.ok(orgo.calls.some((c) => c.method === "DELETE" && c.path === `/api/computers/${C1}/orgo-key`));
  assert.equal(pc(C1).program, false, "taken off its computer");
  assert.equal(pc(C1).key, false, "Orgo took the key off it");
  assert.deepEqual(orgo.ended, [{ device: `device:u1:${C1}`, why: "Stopped: someone else can use this workspace." }]);
});

await check("no bundle, a bad health check, a computer Orgo's map doesn't have: no runner", async () => {
  reset();
  rmSync(join(scratch, "dist-runner"), { recursive: true, force: true });
  await I.lookAtRunners();
  assert.equal(runner().error, "no server bundle");
  assert.equal(orgo.bash.length, 0);
  // A .sha256 that isn't for it: no bundle either.
  reset();
  writeFileSync(join(scratch, "dist-runner", `${BUNDLE}.sha256`), `${"0".repeat(64)}  another.tgz\n`);
  assert.equal(I.findBundle(), null);
  // Up but never signed in (Bops Cloud refused its key, say): stopped, and said why.
  reset();
  orgo.health = "__BOPS_NO_STATE__";
  await I.lookAtRunners();
  assert.equal(runner().error, "it couldn't sign in on its computer");
  // Listening beyond its computer: stopped, and said why.
  reset();
  orgo.health = "__BOPS_EXPOSED__";
  await I.lookAtRunners();
  assert.equal(runner().status, "failed");
  assert.equal(runner().error, "it listened beyond its own computer");
  assert.ok(orgo.bash.some((b) => /^supervisorctl stop bops-runner/.test(b.command)), "stopped");
  assert.ok(T.retryAt(C1) > Date.now() + 25 * 60_000, "tried again later");
  orgo.bash.length = 0;
  await I.lookAtRunners();
  assert.equal(orgo.bash.length, 0, "not before then");
  // A computer this Mac has but Orgo's map doesn't (not one of the user's live Bops computers): none.
  reset();
  orgo.map = [C2];
  await I.lookAtRunners();
  assert.equal(runner(), undefined);
  assert.equal(orgo.bash.length, 0);
  // Before Orgo says where the bots work: nothing at all.
  reset();
  orgo.mode = undefined;
  await I.lookAtRunners();
  assert.equal(orgo.calls.length, 0);
});

/* ---------------- Stopping ---------------- */

await check("This Mac: the runner is taken off its computer, its key revoked, its threads ended, and it's out of the state", async () => {
  reset();
  await I.lookAtRunners();
  orgo.calls.length = 0;
  orgo.bash.length = 0;
  orgo.mode = "mac";
  await I.lookAtRunners();
  assert.equal(runner(), undefined, "gone from the state");
  assert.equal(pc(C1).program, false);
  assert.equal(pc(C1).key, false, "the key Bops gave it, taken off by Orgo with its revoke");
  assert.ok(orgo.bash.some((b) => b.command.includes("__BOPS_OFF__")));
  const off = orgo.bash.find((b) => b.command.includes("__BOPS_OFF__")).command;
  assert.match(off, /supervisorctl stop bops-runner/);
  assert.match(off, /rm -f \/etc\/supervisor\/conf\.d\/bops-runner\.conf \/opt\/bops\/runner\/run\.sh\n/);
  assert.ok(!/orgo-secrets|\/root\/\.env|ORGO_API_KEY/.test(off), "the computer's key is never Bops' to delete");
  assert.ok(orgo.calls.some((c) => c.method === "DELETE" && c.path === `/api/computers/${C1}/orgo-key`), "its key revoked");
  assert.deepEqual(orgo.ended, [{ device: `device:u1:${C1}`, why: "Stopped: routines run on your Mac now." }]);
  assert.ok(!orgo.calls.some((c) => c.path.endsWith("/bops")), "Orgo's map isn't needed for that");
  noSecrets();
});

await check("stopping: an asleep computer isn't woken (its key is revoked), a deleted one just goes, another Mac's key is revoked too", async () => {
  reset();
  await I.lookAtRunners();
  pc(C1).status = "suspended";
  orgo.bash.length = 0;
  orgo.mode = "mac";
  await I.lookAtRunners();
  assert.equal(orgo.bash.length, 0, "not woken");
  assert.equal(pc(C1).status, "suspended");
  assert.equal(runner().status, "stopping", "taken off when it's up");
  assert.deepEqual([runner().keyMade, runner().keyId], [undefined, undefined], "but the key Bops gave it revoked now");
  pc(C1).status = "running";
  await I.lookAtRunners();
  assert.equal(runner(), undefined);
  assert.equal(orgo.ended.length, 1, "its threads ended once");
  // Deleted.
  reset();
  await I.lookAtRunners();
  delete orgo.computers[C1];
  state.bots[0].computerId = C2;
  orgo.computers[C2] = { status: "running", current: "", key: false, have: new Set(), program: false };
  orgo.map = [C2];
  await I.lookAtRunners();
  assert.equal(runner(C1), undefined, "the deleted one's gone");
  assert.deepEqual(orgo.ended[0], { device: `device:u1:${C1}`, why: "Stopped: its computer was deleted." }, "its threads say why");
  assert.equal(runner(C2)?.status, "running", "and its bot's new computer has one");
  // Another Mac had Orgo give it its key: revoked here all the same.
  reset();
  pc(C1).key = true;
  state.runners = { [C1]: { status: "running", version: "0.0.29", buildId: "buildA1", by: "other", keyMade: true, keyId: "key-other", at: Date.now() } };
  orgo.mode = "mac";
  await I.lookAtRunners();
  assert.ok(orgo.calls.some((c) => c.method === "DELETE" && c.path === `/api/computers/${C1}/orgo-key`), "its key revoked");
  assert.equal(runner(), undefined, "and it's out of the state");
  assert.equal(pc(C1).program, false, "taken off its computer");
  // An entry from before keyMade (a key made by the old bops-runner-key route, with keyBy): it loads, counts as Bops' key, and is revoked.
  reset();
  pc(C1).key = true;
  state.runners = { [C1]: { status: "running", version: "0.0.29", buildId: "buildA1", by: "other", keyId: "key-old", keyBy: "other", at: Date.now() } };
  orgo.mode = "mac";
  await I.lookAtRunners();
  assert.equal(orgo.calls.filter((c) => c.method === "DELETE" && c.path === `/api/computers/${C1}/orgo-key`).length, 1, "revoked");
  assert.equal(runner(), undefined);
  // And one set up again keeps it as Bops' (keyMade), without its old keyBy.
  reset();
  pc(C1).key = true;
  pc(C1).current = "0.0.28-old";
  state.runners = { [C1]: { status: "failed", version: "0.0.28", buildId: "old", by: ME, keyId: "key-old", keyBy: ME, error: "it didn't answer on its computer", at: Date.now() - 86_400_000 } };
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().keyMade, runner().keyId, runner().keyBy], ["running", true, "key-old", undefined]);
});

await check("the bots in browsers on this Mac stops the runners too", async () => {
  reset();
  await I.lookAtRunners();
  state.host = "mac";
  await I.lookAtRunners();
  assert.equal(runner(), undefined);
  assert.equal(orgo.ended[0].why, "Stopped: your bots work in browsers on your Mac now.");
});

/* ---------------- Set up again, copies, gone ---------------- */

await check("a copy of a computer with the build there already (no upload, no key on it): set up from what's there, with a key of its own", async () => {
  reset();
  // As a bot's own computer copied from its main bot's: the build and `current` stay, its runner and key were taken off.
  Object.assign(pc(C1), { current: "0.0.29-buildA1", have: new Set(["0.0.29-buildA1"]), key: false });
  await I.lookAtRunners();
  assert.equal(runner().status, "running", JSON.stringify(runner()));
  assert.deepEqual([runner().keyMade, runner().keyId], [true, "key-1"], "a key of its own");
  assert.ok(!orgo.calls.some((c) => c.path.startsWith("/api/files/")), "nothing uploaded");
  assert.equal(orgo.puts.length, 0);
  // Its own try again later, with the upload gone: the same.
  reset();
  Object.assign(pc(C1), { have: new Set(["0.0.29-buildA1"]) });
  state.runners = { [C1]: { status: "failed", version: "0.0.29", buildId: "buildA1", by: ME, error: "it didn't answer on its computer", at: Date.now() - 60 * 60_000 } };
  await I.lookAtRunners();
  assert.equal(runner().status, "running");
});

await check("one that's up set up again stays up, with its routines, until the new one starts; a try that doesn't get that far leaves it as it was", async () => {
  reset();
  pc(C1).key = true;
  pc(C1).current = "0.0.28-old";
  pc(C1).have = new Set(["0.0.28-old"]);
  state.runners = { [C1]: { status: "running", version: "0.0.28", buildId: "old", by: ME, keyMade: true, keyId: "key-0", at: Date.now() - 86_400_000 } };
  let during;
  orgo.duringInstall = () => (during = structuredClone(runner()));
  await I.lookAtRunners();
  assert.equal(during.status, "running", "still up while the new one goes in: the Mac doesn't take its routines");
  assert.deepEqual([during.upgrading?.version, during.upgrading?.buildId, during.upgrading?.by], ["0.0.29", "buildA1", ME]);
  assert.deepEqual([runner().status, runner().version, runner().upgrading], ["running", "0.0.29", undefined]);
  assert.deepEqual(orgo.changed, [], "up all along: Orgo's copy of the routines needn't change");
  // The upload fails: left up as it was (not Couldn't start), and tried again later.
  reset();
  pc(C1).key = true;
  pc(C1).current = "0.0.28-old";
  state.runners = { [C1]: { status: "running", version: "0.0.28", buildId: "old", by: ME, keyMade: true, keyId: "key-0", at: Date.now() } };
  orgo.uploadFails = true;
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().version, runner().upgrading, runner().error], ["running", "0.0.28", undefined, undefined]);
  assert.ok(!bashText().includes("__BOPS_INSTALLED__"), "the computer's runner untouched");
  assert.ok(T.retryAt(C1) > Date.now(), "tried again later");
  orgo.uploadFails = false;
  orgo.bash.length = 0;
  await I.lookAtRunners();
  assert.equal(orgo.bash.length, 0, "not before then");
  // Another Mac setting it up again right now: this one waits.
  const x = { status: "running", version: "0.0.28", buildId: "old", by: "other", at: Date.now() };
  assert.equal(I.installPlan({ ...x, upgrading: { version: "0.0.29", buildId: "b9", by: "other", at: Date.now() } }, { version: "0.0.29", buildId: "buildA1" }, ME), "wait");
  assert.equal(I.installPlan({ ...x, upgrading: { version: "0.0.29", buildId: "b9", by: "other", at: Date.now() - 21 * 60_000 } }, { version: "0.0.29", buildId: "buildA1" }, ME), "install", "one at it 20 minutes stopped");
});

await check("one that's up isn't set up again while a run of its goes (one paused for the owner's OK for hours too: setting it up would wake the computer for nothing): it's set up once that run is over", async () => {
  reset();
  pc(C1).key = true;
  pc(C1).current = "0.0.28-old";
  pc(C1).have = new Set(["0.0.28-old"]);
  state.runners = { [C1]: { status: "running", version: "0.0.28", buildId: "old", by: ME, keyMade: true, keyId: "key-0", at: Date.now() - 86_400_000 } };
  // A routine's run on that computer, paused for Sam's OK to send an email (lib/server/permission.ts).
  const run = { id: "ses_waits", botId: "boppy", chatId: "bot:boppy", sentVia: "routine", title: "Weekly email", goal: "x", host: "orgo", status: "queued", by: `device:u1:${C1}`, steps: [], replies: [], createdAt: Date.now() - 3 * 60 * 60_000 };
  state.sessions = [run];
  state.appApprovals = [{ id: "apr_w", botId: "boppy", threadId: run.id, askedBy: run.by, action: "Send an email", resources: ["dana@acme.example"], preview: "", at: run.createdAt, resume: { engine: "responses", responseId: "resp_w", callId: "call_w", call: { name: "use_app", arguments: "{}" } } }];
  await I.lookAtRunners();
  assert.ok(!bashText().includes("__BOPS_INSTALLED__"), "not set up again: that would end the run");
  assert.deepEqual([runner().status, runner().version, runner().upgrading], ["running", "0.0.28", undefined]);
  // The run is over: now it's set up.
  run.status = "done";
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().version], ["running", "0.0.29"]);
});

await check("a runner kept on for a run paused for the owner's OK (routines moved to the Mac) whose workspace is then shared: that run ends for good with it, as no runner is left to read the answer; so does one of a runner that failed with no key of Bops' to take back", async () => {
  const device = `device:u1:${C1}`;
  const paused = () => {
    const run = { id: "ses_kept", botId: "boppy", chatId: "bot:boppy", sentVia: "routine", title: "Weekly email", goal: "x", host: "orgo", status: "queued", by: device, steps: [], replies: [], createdAt: Date.now() - 60_000 };
    state.sessions = [run];
    state.appApprovals = [{ id: "apr_kept", botId: "boppy", threadId: run.id, askedBy: device, action: "Send an email", resources: ["dana@acme.example"], preview: "", at: run.createdAt, resume: { engine: "responses", responseId: "resp_k", callId: "call_k", call: { name: "use_app", arguments: "{}" } } }];
  };
  reset();
  await I.lookAtRunners();
  paused();
  orgo.mode = "mac";
  await I.lookAtRunners();
  assert.equal(runner().status, "stopping", "kept on for the run it paused");
  assert.deepEqual([orgo.ended, orgo.endedForGood], [[{ device, why: "Stopped: routines run on your Mac now." }], []], "the paused run waits on there");
  // Back on the computer, and someone else can use the workspace now.
  orgo.mode = "cloud";
  orgo.full = true;
  await I.lookAtRunners();
  assert.deepEqual(orgo.ended.at(-1), { device, why: "Stopped: someone else can use this workspace." });
  assert.deepEqual(orgo.endedForGood, [device], "ended for good, the paused run with it");
  assert.equal(pc(C1).program, false, "taken off its computer");
  assert.deepEqual([runner().status, runner().error], ["failed", "someone else can use this workspace"]);
  // A runner on its computer's identity (no key of Bops') that failed with a run it kept paused, then shared: the same.
  reset();
  state.runners = { [C1]: { status: "failed", version: "0.0.29", buildId: "buildA1", by: ME, error: "its runner didn't answer", at: Date.now() } };
  paused();
  orgo.full = true;
  await I.lookAtRunners();
  assert.deepEqual(orgo.endedForGood, [device], "its paused run ended for good");
  assert.deepEqual([runner().status, runner().error], ["failed", "someone else can use this workspace"]);
  state.sessions = [];
  state.appApprovals = [];
});

await check("a runner that failed with a run paused for the owner's OK, whose computer nobody wants any more (routines moved to the Mac, its bot moved off it): that run ends for good, its request resolved as Stop resolves it, as nothing is left there to read the answer; one that's up keeps its paused run as before", async () => {
  const device = `device:u1:${C1}`;
  const paused = () => {
    const run = { id: "ses_failed", botId: "boppy", chatId: "bot:boppy", sentVia: "routine", title: "Weekly email", goal: "x", host: "orgo", status: "queued", by: device, steps: [], replies: [], createdAt: Date.now() - 60_000 };
    state.sessions = [run];
    state.appApprovals = [{ id: "apr_failed", botId: "boppy", threadId: run.id, askedBy: device, action: "Send an email", resources: ["dana@acme.example"], preview: "", at: run.createdAt, resume: { engine: "responses", responseId: "resp_f", callId: "call_f", call: { name: "use_app", arguments: "{}" } } }];
  };
  for (const [what, before] of [
    ["routines moved to the Mac", () => (orgo.mode = "mac")],
    ["its bot moved off it", () => (state.bots = state.bots.map((b) => ({ ...b, computerId: undefined, computer: undefined })))],
  ]) {
    reset();
    // Its program died on the computer while the run waited (the Mac's look found it gone: stillRuns), the key Bops gave it still there.
    state.runners = { [C1]: { status: "failed", version: "0.0.29", buildId: "buildA1", by: ME, error: "it stopped on its computer", at: Date.now(), keyMade: true, keyId: "key-1" } };
    paused();
    before();
    await I.lookAtRunners();
    assert.deepEqual(orgo.endedForGood, [device], `${what}: its paused run ended for good`);
    assert.notEqual(runner()?.status, "running", what);
    // The next look keeps nothing on for it.
    await I.lookAtRunners();
    assert.ok(orgo.endedForGood.every((d) => d === device), what);
  }
  // A runner that's up keeps the run it paused (the owner's answer carries it on there), as before.
  reset();
  await I.lookAtRunners();
  paused();
  orgo.mode = "mac";
  await I.lookAtRunners();
  assert.deepEqual([runner().status, orgo.endedForGood], ["stopping", []], "kept on for it");
  state.sessions = [];
  state.appApprovals = [];
});

await check("a runner kept on for a run paused for the owner's OK whose program is gone from its computer (it died before the Mac noticed, or after it was kept): once the computer is up (woken for the owner's answer), the Mac asks, and that run ends for good, its request resolved as Stop resolves it, and the runner is taken off; a computer asleep is never asked, and one whose program is there keeps its run", async () => {
  const device = `device:u1:${C1}`;
  const paused = () => {
    const run = { id: "ses_dead", botId: "boppy", chatId: "bot:boppy", sentVia: "you", title: "Email Dana", goal: "x", host: "orgo", status: "queued", by: device, steps: [], replies: [], createdAt: Date.now() - 60_000 };
    state.sessions = [run];
    state.appApprovals = [{ id: "apr_dead", botId: "boppy", threadId: run.id, askedBy: device, action: "Send an email", resources: ["dana@acme.example"], preview: "", at: run.createdAt, resume: { engine: "responses", responseId: "resp_d", callId: "call_d", call: { name: "use_app", arguments: "{}" } } }];
  };
  const answer = () => (state.appApprovals[0].reply = { reply: "once", by: "mac-other", at: Date.now() });
  const asks = () => orgo.bash.filter((b) => /^supervisorctl status bops-runner/.test(b.command)).length;
  const gone = "bops-runner: ERROR (no such process)";
  for (const [what, before] of [
    ["routines moved to the Mac", () => (orgo.mode = "mac")],
    ["its bot moved off it", () => (state.bots = state.bots.map((b) => ({ ...b, computerId: undefined, computer: undefined })))],
  ]) {
    // B: its program died while the run waited, before any look found it (no routine overdue: a chat task), the computer asleep.
    reset();
    await I.lookAtRunners();
    paused();
    orgo.supervisor = gone;
    pc(C1).status = "suspended";
    orgo.bash.length = 0;
    before();
    await I.lookAtRunners();
    assert.deepEqual([runner().status, orgo.endedForGood, orgo.bash.length], ["stopping", [], 0], `${what}: asleep, kept, and never woken to ask`);
    // Sam answers: the computer is woken for it (permission.ts wakeForAnswers), and the next look asks.
    answer();
    pc(C1).status = "running";
    await I.lookAtRunners();
    assert.deepEqual(orgo.endedForGood, [device], `${what}: its run ended for good, nothing left to read the answer`);
    assert.match(orgo.ended.at(-1).why, /runner is down \(it stopped on its computer\)/, what);
    assert.equal(runner(), undefined, `${what}: taken off, its key revoked`);
  }
  // C: kept on, its program there (asked once the computer is up, answered or not); it dies after; Sam answers; the next look asks again.
  reset();
  await I.lookAtRunners();
  paused();
  orgo.mode = "mac";
  orgo.bash.length = 0;
  await I.lookAtRunners();
  assert.deepEqual([runner().status, orgo.endedForGood, asks()], ["stopping", [], 1], "up: asked, its program there, kept");
  await I.lookAtRunners();
  assert.deepEqual([runner().status, asks()], ["stopping", 1], "not asked again for nothing (at most once an hour)");
  orgo.supervisor = "bops-runner                      FATAL     Exited too quickly";
  answer();
  await I.lookAtRunners();
  assert.deepEqual([orgo.endedForGood, asks()], [[device], 2], "asked again for the answer: gone, so the run ended for good");
  assert.equal(runner(), undefined, "taken off");
  state.sessions = [];
  state.appApprovals = [];
});

await check("a runner marked up whose run waits on the owner's answer, with no routine overdue, is asked whether its program is still there once its computer is up: gone, it couldn't start (so Stop ends that run, and it's set up again later); there, it's left as it is", async () => {
  const device = `device:u1:${C1}`;
  reset();
  await I.lookAtRunners();
  const run = { id: "ses_chat", botId: "boppy", chatId: "bot:boppy", sentVia: "you", title: "Email Dana", goal: "x", host: "orgo", status: "queued", by: device, steps: [], replies: [], createdAt: Date.now() - 60_000 };
  state.sessions = [run];
  state.appApprovals = [{ id: "apr_chat", botId: "boppy", threadId: run.id, askedBy: device, action: "Send an email", resources: ["dana@acme.example"], preview: "", at: run.createdAt, reply: { reply: "once", by: "mac-other", at: Date.now() }, resume: { engine: "responses", responseId: "resp_c", callId: "call_c", call: { name: "use_app", arguments: "{}" } } }];
  orgo.bash.length = 0;
  await I.lookAtRunners();
  assert.deepEqual([runner().status, orgo.bash.filter((b) => /^supervisorctl status/.test(b.command)).length], ["running", 1], "asked: there, left as it is");
  reset();
  await I.lookAtRunners();
  state.sessions = [{ ...run }];
  state.appApprovals = [{ id: "apr_chat", botId: "boppy", threadId: run.id, askedBy: device, action: "Send an email", resources: [], preview: "", at: run.createdAt, reply: { reply: "once", by: "mac-other", at: Date.now() }, resume: { engine: "responses", responseId: "resp_c", callId: "call_c", call: { name: "use_app", arguments: "{}" } } }];
  orgo.supervisor = "bops-runner: ERROR (no such process)";
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().error], ["failed", "it stopped on its computer"]);
  state.sessions = [];
  state.appApprovals = [];
});

await check("Orgo's copy of the routines follows each runner going up or down", async () => {
  reset();
  await I.lookAtRunners();
  assert.deepEqual(orgo.changed.sort(), ["boppy", "otto"], "up: the bots on that computer (Otto shares it)");
  orgo.changed.length = 0;
  orgo.mode = "mac";
  await I.lookAtRunners();
  assert.deepEqual(orgo.changed.sort(), ["boppy", "otto"], "down");
});

await check("a runner marked up that left a routine well past its time, and is gone from its computer: Couldn't start (its routines go back to the Mac before their next run); asleep, it's never woken to ask, and its routines wait for it, saying why", async () => {
  reset();
  await I.lookAtRunners();
  orgo.bash.length = 0;
  // Overdue, but its program is there: left as it is.
  orgo.overdue = true;
  await I.lookAtRunners();
  assert.ok(orgo.bash.some((b) => /^supervisorctl status bops-runner/.test(b.command)));
  assert.equal(runner().status, "running");
  assert.deepEqual(orgo.down, [], "up: nothing waits on it");
  // Gone (it took itself off as if a copy, say): Couldn't start.
  reset();
  await I.lookAtRunners();
  orgo.overdue = true;
  orgo.supervisor = "bops-runner: ERROR (no such process)";
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().error], ["failed", "it stopped on its computer"]);
  // Asleep: never woken to ask, and nothing woke it for them: they wait for it, saying why (never the Mac's for it).
  reset();
  await I.lookAtRunners();
  orgo.overdue = true;
  orgo.supervisor = "bops-runner: ERROR (no such process)";
  pc(C1).status = "suspended";
  orgo.bash.length = 0;
  await I.lookAtRunners();
  assert.equal(orgo.bash.length, 0);
  assert.equal(runner().status, "running");
  assert.deepEqual(orgo.down, [[C1, "suspended"]]);
  assert.equal(runner().down?.status, "suspended", "in the state, for every Bops to show");
  // Up again at the next look: cleared.
  pc(C1).status = "running";
  orgo.supervisor = undefined;
  await I.lookAtRunners();
  assert.deepEqual(orgo.down, [[C1, "suspended"], [C1, null]]);
  assert.equal(runner().down, undefined);
});

await check("a computer its routines wait on is looked at each time: still asleep with one overdue, or down that way, why stays (noted once); asleep with nothing overdue, it waits on nothing; up again, cleared; nothing is ever sent to it meanwhile", async () => {
  reset();
  await I.lookAtRunners();
  orgo.overdue = true;
  pc(C1).status = "suspended";
  orgo.bash.length = 0;
  await I.lookAtRunners();
  await I.lookAtRunners();
  assert.deepEqual([orgo.down, orgo.bash.length], [[[C1, "suspended"]], 0], "asleep with one overdue: noted once, nothing sent to it");
  orgo.overdue = false;
  await I.lookAtRunners();
  assert.equal(runner().down?.status, "suspended", "nothing overdue now: still looked at (it was down), and still asleep");
  pc(C1).status = "frozen";
  await I.lookAtRunners();
  assert.deepEqual(orgo.down.at(-1), [C1, "frozen"], "down and not coming back by itself, overdue or not");
  pc(C1).status = "running";
  await I.lookAtRunners();
  assert.deepEqual(orgo.down.at(-1), [C1, null], "up: nothing waits on it");
  assert.equal(orgo.bash.length, 0);
  // Asleep with nothing overdue (Orgo's waker wakes it for its next time): nothing to say.
  reset();
  await I.lookAtRunners();
  pc(C1).status = "suspended";
  await I.lookAtRunners();
  assert.deepEqual(orgo.down, []);
});

await check("Orgo's map or the members check not answering: nothing is set up or stopped, but a computer asleep with one overdue still says why its routines wait", async () => {
  for (const what of ["map", "members"]) {
    reset();
    await I.lookAtRunners();
    orgo.overdue = true;
    pc(C1).status = "suspended";
    if (what === "map") orgo.mapStatus = 403;
    else globalThis.__fake.members.othersCanUse = async () => null;
    orgo.bash.length = 0;
    await I.lookAtRunners();
    assert.deepEqual(orgo.down, [[C1, "suspended"]], `${what}: why it waits`);
    assert.deepEqual([runner().status, orgo.bash.length], ["running", 0], `${what}: nothing set up or stopped`);
    orgo.mapStatus = undefined;
    globalThis.__fake.members.othersCanUse = async () => orgo.full;
  }
});

await check("a runner the Mac marks failed: the threads it was running end, so none holds its routine's next run", async () => {
  reset();
  await I.lookAtRunners();
  orgo.overdue = true;
  orgo.supervisor = "bops-runner: ERROR (no such process)";
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().error], ["failed", "it stopped on its computer"]);
  assert.deepEqual(orgo.ended.map((x) => x.device), [`device:u1:${C1}`]);
  assert.match(orgo.ended[0].why, /^Stopped: its computer's runner is down \(it stopped on its computer\)\.$/);
  // One that never got up (a set up that failed) had nothing running.
  reset();
  orgo.installFails = true;
  await I.lookAtRunners();
  assert.equal(runner()?.status, "failed");
  assert.deepEqual(orgo.ended, []);
});

await check("a runner marked up whose computer is down and doesn't come back by itself (stopped, frozen, in error): its overdue routines wait for it at each look, saying why, set up again or not, and are never taken over; one waking, or a status Bops doesn't know, says nothing", async () => {
  for (const status of ["frozen", "stopped", "error"]) {
    reset();
    await I.lookAtRunners();
    orgo.overdue = true;
    pc(C1).status = status;
    orgo.bash.length = 0;
    await I.lookAtRunners();
    assert.equal(orgo.bash.length, 0, `${status}: nothing sent to it`);
    assert.equal(runner().status, "running", `${status}: still marked up, for when it's started again`);
    assert.deepEqual(orgo.down, [[C1, status]], `${status}: its routines wait, saying why`);
    await I.lookAtRunners();
    assert.equal(runner().down?.status, status, `${status}: at each look`);
    assert.equal(pc(C1).status, status, `${status}: never started`);
  }
  // On its way up (or a status Bops doesn't know), or gone from Orgo: nothing to say.
  for (const status of ["starting", "resuming", "suspending", "gone"]) {
    reset();
    await I.lookAtRunners();
    orgo.overdue = true;
    if (status === "gone") delete orgo.computers[C1];
    else pc(C1).status = status;
    await I.lookAtRunners();
    assert.deepEqual(orgo.down, [], status);
  }
  // To be set up again (this app's build is newer) while its computer is frozen: nothing is tried on a computer
  // that isn't up, and it stays marked up as it was; its routines wait meanwhile, saying why.
  reset();
  pc(C1).key = true;
  pc(C1).current = "0.0.28-old";
  pc(C1).have = new Set(["0.0.28-old"]);
  pc(C1).status = "frozen";
  state.runners = { [C1]: { status: "running", version: "0.0.28", buildId: "old", by: ME, keyMade: true, keyId: "key-0", at: Date.now() } };
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().version, runner().upgrading], ["running", "0.0.28", undefined]);
  assert.equal(orgo.bash.length, 0, "nothing tried on it");
  orgo.overdue = true;
  orgo.bash.length = 0;
  await I.lookAtRunners();
  assert.deepEqual(orgo.down, [[C1, "frozen"]], "while it waits to try again");
  assert.equal(orgo.bash.length, 0);
  assert.equal(pc(C1).status, "frozen", "never started");
  // Its turn to be set up again, with routines overdue on its computer asleep or frozen: nothing is tried this
  // look (a try would wake it); a look that finds it up sets it up.
  for (const status of ["suspended", "frozen"]) {
    reset();
    pc(C1).key = true;
    pc(C1).current = "0.0.28-old";
    pc(C1).have = new Set(["0.0.28-old"]);
    pc(C1).status = status;
    state.runners = { [C1]: { status: "running", version: "0.0.28", buildId: "old", by: ME, keyMade: true, keyId: "key-0", at: Date.now() } };
    orgo.overdue = true;
    await I.lookAtRunners();
    assert.deepEqual(orgo.down, [[C1, status]], status);
    assert.deepEqual([orgo.bash.length, pc(C1).status, runner().version, T.retryAt(C1)], [0, status, "0.0.28", undefined], `${status}: not woken, nothing tried`);
    orgo.overdue = false;
    pc(C1).status = "running";
    await I.lookAtRunners();
    assert.equal(runner().version, "0.0.29", `${status}: set up again once it's up`);
  }
  // Another Mac's runner, and this Mac has no bundle to set one up with: its routines wait all the same.
  reset();
  rmSync(join(scratch, "dist-runner"), { recursive: true, force: true });
  pc(C1).status = "frozen";
  state.runners = { [C1]: { status: "running", version: "0.0.29", buildId: "buildA1", by: "other", at: Date.now() } };
  orgo.overdue = true;
  await I.lookAtRunners();
  assert.deepEqual(orgo.down, [[C1, "frozen"]]);
  assert.equal(runner().status, "running", "another Mac's, left as it is");
  // Another Mac setting it up again right now, its computer stopped: this Mac waits, and says why.
  reset();
  pc(C1).status = "stopped";
  state.runners = { [C1]: { status: "running", version: "0.0.28", buildId: "old", by: "other", at: Date.now(), upgrading: { version: "0.0.29", buildId: "b9", by: "other", at: Date.now() } } };
  orgo.overdue = true;
  await I.lookAtRunners();
  assert.equal(orgo.bash.length, 0, "this Mac waits");
  assert.deepEqual(orgo.down, [[C1, "stopped"]]);
});

await check("a thread its runner was running when its computer went down for good (stopped, frozen, in error) ends, saying so, so its routine's next run isn't held by it; asleep, it's left to carry on", async () => {
  const running = (by) => ({ id: "ses_run", botId: "boppy", chatId: "bot:boppy", sentVia: "routine", title: "Daily check", goal: "x", host: "orgo", status: "running", steps: [], replies: [], createdAt: 1, by });
  for (const [status, why] of [["stopped", "Stopped: its computer was stopped."], ["frozen", "Stopped: its computer was frozen."], ["error", "Stopped: its computer broke."]]) {
    reset();
    await I.lookAtRunners();
    state.sessions.push(running(`device:u1:${C1}`));
    pc(C1).status = status;
    // Nothing overdue yet: its thread is enough for a look at its computer.
    await I.lookAtRunners();
    assert.deepEqual(orgo.ended, [{ device: `device:u1:${C1}`, why }], status);
    assert.deepEqual(orgo.down, [[C1, status]], `${status}: its routines wait for it, saying why`);
  }
  // Asleep: the thread is paused, not over (it goes on when the computer wakes).
  reset();
  await I.lookAtRunners();
  state.sessions.push(running(`device:u1:${C1}`));
  pc(C1).status = "suspended";
  await I.lookAtRunners();
  assert.deepEqual(orgo.ended, []);
  // Another device's thread (the Mac's) is never this runner's to end.
  reset();
  await I.lookAtRunners();
  state.sessions.push(running("mac-device"));
  pc(C1).status = "frozen";
  await I.lookAtRunners();
  assert.deepEqual(orgo.ended, []);
});

/* ---------------- Its computer's identity ---------------- */

const keyCalls = (method) => orgo.calls.filter((c) => c.method === method && c.path === `/api/computers/${C1}/orgo-key`).length;

await check("phase 1: the key step is today's whatever identity answers, the probe never asks it, and the health check's auth= is kept", async () => {
  for (const ident of ["200", "403", "404", "503", "000"]) {
    reset();
    orgo.ident = ident;
    orgo.auth = ident === "200" ? "identity" : "key";
    await I.lookAtRunners();
    const x = runner();
    assert.deepEqual([x.status, x.keyMade, x.auth], ["running", true, orgo.auth], `ident=${ident}`);
    assert.equal(keyCalls("PUT"), 1, `a key given (ident=${ident})`);
    assert.equal(keyCalls("DELETE"), 0, "and never taken back");
    assert.ok(!orgo.bash.some((b) => b.command.includes("169.254.169.254")), "identity isn't asked at set-up in phase 1");
  }
  // The health check prints the runner's last auth word, the word alone.
  assert.ok(I.HEALTH_SCRIPT.includes("auth: (identity|key|none)$' /var/log/bops/runner.log"));
  const dir = mkdtempSync(join(tmpdir(), "bops-auth-line-"));
  const log = join(dir, "runner.log");
  const file = join(dir, "auth");
  const line = I.STILL_RUNS_SCRIPT.split("; ").find((l) => l.startsWith('echo "auth=')).replace("/var/log/bops/runner.log", log).replace("/opt/bops/runner/auth", file);
  assert.equal(line, I.AUTH_LINE.replace("/var/log/bops/runner.log", log).replace("/opt/bops/runner/auth", file), "the whole auth line");
  writeFileSync(log, "[runner] auth: none\n[runner] identity ok (desktop c1, expires in 52m)\n[runner] auth: identity\n[runner] running the routines of the bots on c1\n");
  assert.equal(spawnSync("bash", ["-c", line], { encoding: "utf8" }).stdout, "auth=identity\n", "no auth file (a runner from before it): the log's last word");
  writeFileSync(log, "[runner] auth: identity orgo_vm_secret\n");
  assert.equal(spawnSync("bash", ["-c", line], { encoding: "utf8" }).stdout, "auth=\n", "only a line that is the word alone");
  // The runner's auth file (orgo-auth.ts, at each change) wins: the log may have rotated past its last word.
  writeFileSync(log, "[runner] running the routines of the bots on c1\n");
  writeFileSync(file, "key\n");
  assert.equal(spawnSync("bash", ["-c", line], { encoding: "utf8" }).stdout, "auth=key\n", "the file's word, the log rotated past its line");
  writeFileSync(log, "[runner] auth: identity\n");
  assert.equal(spawnSync("bash", ["-c", line], { encoding: "utf8" }).stdout, "auth=key\n", "the file before the log");
  writeFileSync(file, "orgo_vm_secret\n");
  assert.equal(spawnSync("bash", ["-c", line], { encoding: "utf8" }).stdout, "auth=identity\n", "a file that isn't a word alone: the log");
  assert.ok(I.installScript({ name: "b.tgz", sha256: "0".repeat(64), version: "1", buildId: "x" }, "").includes("rm -f /opt/bops/runner/auth"), "a new start writes it afresh");
  rmSync(dir, { recursive: true, force: true });
  // Settings shows it (types.ts: a runner up on identity doesn't count on a key).
  const { runnerNeedsKey } = await import(`${root}/lib/types.ts`);
  assert.equal(runnerNeedsKey({ status: "running", auth: "identity" }), false);
  assert.equal(runnerNeedsKey({ status: "running", auth: "key" }), true);
});

await check("the way back: a runner with no key and no identity it can use gets its key again and is started; one on identity is asked every 15 minutes", async () => {
  reset();
  orgo.ident = "200";
  orgo.auth = "identity";
  pc(C1).key = true;
  await I.lookAtRunners();
  assert.equal(runner().auth, "identity");
  // Identity lost (paused, a host without it), the key taken off meanwhile, and the runner waiting with nothing: stopped by supervisord too.
  pc(C1).key = false;
  orgo.ident = "503";
  orgo.auth = "none";
  orgo.overdue = true;
  orgo.supervisor = "bops-runner                      FATAL     Exited too quickly";
  orgo.calls.length = 0;
  await I.lookAtRunners();
  assert.equal(keyCalls("PUT"), 1, "its key from Orgo again");
  assert.deepEqual([runner().status, runner().keyMade, runner().auth], ["running", true, undefined]);
  assert.equal(orgo.starts, 1, "and started");
  assert.equal(pc(C1).key, true);
  // Asked again within 15 minutes: not; a key runner waits an hour.
  orgo.calls.length = 0;
  pc(C1).key = false;
  await I.lookAtRunners();
  assert.equal(keyCalls("PUT"), 0, "not asked again so soon");
  // Up and waiting (not stopped): a key, and no start needed.
  reset();
  orgo.ident = "000";
  pc(C1).key = true;
  await I.lookAtRunners();
  pc(C1).key = false;
  orgo.auth = "none";
  orgo.overdue = true;
  await I.lookAtRunners();
  assert.equal(keyCalls("PUT"), 1);
  assert.equal(orgo.starts, 0, "it's up: it picks the key up itself");
  // Identity answers but the runner says it has nothing (Bops Cloud can't take it yet, say): a key all the same.
  reset();
  pc(C1).key = true;
  await I.lookAtRunners();
  pc(C1).key = false;
  orgo.ident = "200";
  orgo.auth = "none";
  orgo.overdue = true;
  await I.lookAtRunners();
  assert.equal(keyCalls("PUT"), 1);
  // A key in its files that isn't its own (an account's key someone put in /root/.env: the runner won't use it and says none): its own from Orgo.
  for (const ident of ["404", "200"]) {
    reset();
    pc(C1).key = true;
    await I.lookAtRunners();
    orgo.ident = ident;
    orgo.auth = "none";
    orgo.overdue = true;
    orgo.calls.length = 0;
    await I.lookAtRunners();
    assert.equal(keyCalls("PUT"), 1, `its own key, though key=yes (ident=${ident})`);
  }
  // Its key in its files and using it: nothing to give.
  reset();
  pc(C1).key = true;
  await I.lookAtRunners();
  orgo.ident = "404";
  orgo.auth = "key";
  orgo.overdue = true;
  orgo.calls.length = 0;
  await I.lookAtRunners();
  assert.equal(keyCalls("PUT"), 0, "a runner on its own key");
  // On identity and using it: nothing to give.
  reset();
  pc(C1).key = true;
  await I.lookAtRunners();
  pc(C1).key = false;
  orgo.ident = "200";
  orgo.auth = "identity";
  orgo.overdue = true;
  orgo.calls.length = 0;
  await I.lookAtRunners();
  assert.equal(keyCalls("PUT"), 0);
  assert.equal(runner().auth, "identity", "what it signs in with, kept");
  // Refused (403): no key; stopped, it couldn't start as before.
  reset();
  pc(C1).key = true;
  await I.lookAtRunners();
  pc(C1).key = false;
  orgo.ident = "403";
  orgo.overdue = true;
  orgo.supervisor = "bops-runner                      FATAL     Exited too quickly";
  orgo.calls.length = 0;
  await I.lookAtRunners();
  assert.equal(keyCalls("PUT"), 0);
  assert.deepEqual([runner().status, runner().error], ["failed", "it stopped on its computer"]);
  // Orgo refuses the key: it couldn't start, and why (its routines back to the Mac).
  reset();
  pc(C1).key = true;
  await I.lookAtRunners();
  pc(C1).key = false;
  orgo.auth = "none";
  orgo.overdue = true;
  orgo.keyRefusal = { status: 409, json: { code: "full_access_member" } };
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().error], ["failed", "someone else can use this workspace"]);
  noSecrets();
});

await check("phase 2 (IDENTITY_ONLY): no key where identity answers, none and no runner where it's refused, a key where it doesn't answer", async () => {
  // 200, no key: no PUT; it must say it runs on identity.
  reset();
  T.identityOnly(true);
  orgo.ident = "200";
  orgo.auth = "identity";
  await I.lookAtRunners();
  assert.equal(keyCalls("PUT"), 0, "no key");
  assert.deepEqual([runner().status, runner().keyMade, runner().auth], ["running", undefined, "identity"]);
  assert.ok(orgo.bash.find((b) => b.command.includes('echo "current=$c"')).command.includes(I.IDENT_LINE), "the probe asks identity");
  // ...and one that doesn't (it fell back, or none): unhealthy, stopped, tried again later.
  reset();
  T.identityOnly(true);
  orgo.ident = "200";
  orgo.auth = "none";
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().error], ["failed", "it couldn't sign in on its computer"]);
  assert.ok(orgo.bash.some((b) => /^supervisorctl stop bops-runner/.test(b.command)), "stopped");
  assert.equal(keyCalls("PUT"), 0);
  // 403: no key, no runner, and said why.
  reset();
  T.identityOnly(true);
  orgo.ident = "403";
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().error], ["failed", "someone else can use this workspace"]);
  assert.equal(keyCalls("PUT"), 0);
  assert.ok(!bashText().includes("__BOPS_INSTALLED__"));
  // Anything else, with no key: today's PUT (taken back later, once identity works); with a key: as today.
  for (const ident of ["503", "000", "404", ""]) {
    reset();
    T.identityOnly(true);
    orgo.ident = ident;
    await I.lookAtRunners();
    assert.deepEqual([runner().status, runner().keyMade], ["running", true], `ident=${ident}`);
    assert.equal(keyCalls("PUT"), 1);
    reset();
    T.identityOnly(true);
    orgo.ident = ident;
    pc(C1).key = true;
    await I.lookAtRunners();
    assert.deepEqual([runner().status, runner().keyMade, keyCalls("PUT"), keyCalls("DELETE")], ["running", undefined, 0, 0], `ident=${ident}, a key there`);
  }
});

await check("phase 2: the key Bops gave is taken back only once the new build runs on identity, never when its upload, install or health fails, and never one the computer came with", async () => {
  const upFrom = () => {
    reset();
    T.identityOnly(true);
    pc(C1).key = true;
    pc(C1).current = "0.0.28-old";
    state.runners = { [C1]: { status: "running", version: "0.0.28", buildId: "old", by: ME, keyMade: true, keyId: "key-0", at: Date.now() } };
    orgo.ident = "200";
    orgo.auth = "identity";
  };
  upFrom();
  let deletedDuring;
  orgo.duringInstall = () => (deletedDuring = keyCalls("DELETE"));
  await I.lookAtRunners();
  assert.equal(deletedDuring, 0, "the key stays through the key step and the install");
  assert.equal(keyCalls("DELETE"), 1, "taken back after health said auth=identity");
  assert.deepEqual([runner().status, runner().version, runner().keyMade, runner().keyId, runner().auth], ["running", "0.0.29", undefined, undefined, "identity"]);
  assert.equal(pc(C1).key, false);
  // The upload fails: the runner that was up, and its key, as they were.
  upFrom();
  orgo.uploadFails = true;
  await I.lookAtRunners();
  assert.equal(keyCalls("DELETE"), 0);
  assert.deepEqual([runner().status, runner().version, runner().keyMade], ["running", "0.0.28", true]);
  // The install fails: no take-back.
  upFrom();
  orgo.installFails = true;
  await I.lookAtRunners();
  assert.equal(keyCalls("DELETE"), 0);
  assert.equal(runner().keyMade, true);
  // Health fails, or passes on the key rather than identity: no take-back.
  upFrom();
  orgo.health = "__BOPS_DOWN__";
  await I.lookAtRunners();
  assert.equal(keyCalls("DELETE"), 0);
  assert.equal(runner().keyMade, true);
  upFrom();
  orgo.auth = "key";
  await I.lookAtRunners();
  assert.equal(keyCalls("DELETE"), 0);
  assert.deepEqual([runner().status, runner().keyMade, runner().auth], ["running", true, "key"]);
  // A key the computer came with (not keyMade): Orgo's, never taken back.
  upFrom();
  state.runners[C1] = { ...state.runners[C1], keyMade: undefined, keyId: undefined };
  await I.lookAtRunners();
  assert.equal(keyCalls("DELETE"), 0);
  assert.equal(pc(C1).key, true);
  // Phase 1 (the default): never taken back.
  upFrom();
  T.identityOnly(undefined);
  await I.lookAtRunners();
  assert.equal(keyCalls("DELETE"), 0);
  assert.equal(runner().keyMade, true);
  noSecrets();
});

/* ---------------- The commands as shell ---------------- */

await check("every command it sends is shell that parses, and the wrapper too", () => {
  const scripts = [
    I.installScript({ name: BUNDLE, sha256: SHA, version: "0.0.29", buildId: "buildA1" }, I.wrapperScript({ computerId: C1, timeZone: "America/New_York", orgo: "https://orgo.example", cloud: "https://bops.example/api" })),
    I.HEALTH_SCRIPT,
    I.UNINSTALL_SCRIPT,
    I.probeScript("0.0.29-buildA1"),
    I.probeScript("0.0.29-buildA1", { ident: true }),
    I.STILL_RUNS_SCRIPT,
  ];
  for (const s of scripts) {
    const r = spawnSync("bash", ["-n"], { input: s, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  const w = spawnSync("sh", ["-n"], { input: I.wrapperScript({ computerId: C1, orgo: "https://orgo.example", cloud: "https://bops.example/api" }), encoding: "utf8" });
  assert.equal(w.status, 0, w.stderr);
  assert.ok(!I.SUPERVISOR_CONF.includes("environment="), "no settings in the program (they're in the wrapper, none secret)");
});

await check("the probe says key=yes only for a line that sets a non-empty ORGO_API_KEY, in either file, and prints nothing of it", () => {
  const dir = mkdtempSync(join(tmpdir(), "bops-probe-key-"));
  const secrets = join(dir, ".orgo-secrets.env");
  const env = join(dir, ".env");
  // The probe's own key line, pointed at these files.
  const line = I.probeScript("x").split("; ").find((l) => l.startsWith("grep "));
  const probe = line.replace("/root/.orgo-secrets.env /root/.env", `${secrets} ${env}`);
  const ask = () => spawnSync("bash", ["-c", probe], { encoding: "utf8" }).stdout;
  const says = (files) => {
    rmSync(secrets, { force: true });
    rmSync(env, { force: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(f === "secrets" ? secrets : env, text);
    return ask();
  };
  // As metal writes it at create, as Orgo's PUT writes it (shlex.quote), and either file alone.
  assert.equal(says({ env: "export PATH=/usr/bin\nexport ORGO_API_KEY='sk_live_a'\\''b'\n[ -f /root/.orgo-secrets.env ] && . /root/.orgo-secrets.env\n" }), "key=yes\n");
  assert.equal(says({ secrets: "export ORGO_API_KEY=sk_live_plain\n" }), "key=yes\n");
  assert.equal(says({ secrets: "export ANTHROPIC_API_KEY=x\nexport ORGO_API_KEY='sk live'\"'\"'s'\n" }), "key=yes\n");
  assert.equal(says({ env: "ORGO_API_KEY=sk_no_export\n" }), "key=yes\n");
  // None: no files, an empty value, a comment, another name.
  assert.equal(says({}), "key=no\n");
  assert.equal(says({ secrets: "export ORGO_API_KEY=''\n", env: 'export ORGO_API_KEY=""\n' }), "key=no\n");
  assert.equal(says({ env: "# export ORGO_API_KEY=sk_old\nexport MY_ORGO_API_KEY=sk_x\nexport ORGO_API_KEY_OLD=sk_y\n" }), "key=no\n");
  assert.ok(!ask().includes("sk_"), "never a value");
  rmSync(dir, { recursive: true, force: true });
});

rmSync(scratch, { recursive: true, force: true });
console.log(`runner install: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
