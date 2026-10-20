// Tests for setting Bops runners up on the bots' computers and stopping them (lib/server/runner-install.ts),
// against a fake Orgo: which computers get one (each a bot works on, as Orgo's map and this Mac both have
// it), what goes to a computer (no command ever carries a key, the window token or the upload's link), the
// version rules (never an older one over a newer; the same version again only from the Mac that set it up
// last; one that's up stays up while it's set up again), a copy of a computer that has the build already,
// the computer's own Orgo key (one it came with is left alone; one without is given it by Orgo, and only
// that one is taken back at the stop, an entry from before keyMade too), none where someone else can use
// the workspace, the health check (loopback only), a runner marked up that's gone from its computer,
// Orgo's copy of the routines following each runner up or down, and the stop (This Mac, the bots in
// browsers on the Mac, a computer deleted, no bot on it any more: taken off, the key Bops gave revoked by
// any Mac, its threads ended). The commands it sends are checked as shell too.
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

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
process.env.BOPS_ORGO_ORIGIN = "https://orgo.example";
process.env.BOPS_CLOUD_URL = "https://bops.example/api";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const FAKES = {
  store: ["flushState", "getState", "stateDevice", "stateInCloud", "stateReady", "stateTooNew", "update"],
  members: ["othersCanUse"],
  orgo: ["apiKey", "callOrgo", "orgo"],
  "orgo-auth": ["orgoOrigin"],
  "persist-cloud": ["deviceIdFor"],
  runner: ["heardRunsOn", "overdueOn", "runsOnMissing", "RUNNER_CONF", "RUNNER_WRAPPER"],
  sessions: ["computerGone", "endSessionsOf"],
  "routine-sync": ["routineChanged"],
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
    changed: [],
    overdue: false,
    uploadFails: false,
    duringInstall: null,
    supervisor: "bops-runner                      RUNNING   pid 812, uptime 1:02:03",
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
  members: { othersCanUse: async () => orgo.full },
  "orgo-auth": { orgoOrigin: () => process.env.BOPS_ORGO_ORIGIN },
  "persist-cloud": { deviceIdFor: (user, seed) => `device:${user}:${seed}` },
  runner: { heardRunsOn: () => orgo.mode, runsOnMissing: () => orgo.missing, overdueOn: () => orgo.overdue },
  "routine-sync": { routineChanged: (botId) => orgo.changed.push(botId) },
  sessions: {
    computerGone: (e) => e?.status === 404,
    endSessionsOf: (device, why) => orgo.ended.push({ device, why }),
  },
  orgo: {
    apiKey: async () => MAC_KEY,
    callOrgo: async (key, path, init = {}) => {
      const c = { key, path, method: init.method ?? "GET", body: init.body };
      orgo.calls.push(c);
      if (path === `/api/projects/${PID}/bops`) return { status: 200, json: { bots: orgo.map.map((d, i) => ({ bopsId: `b${i}`, desktopId: d })) } };
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
        // A command wakes a computer that's asleep (Orgo's auto-resume).
        x.status = "running";
        if (command.includes('echo "current=$c"')) {
          const dir = /\/opt\/bops\/runner\/([^/ ]+)\/server\.js/.exec(command)[1];
          return { output: `current=${x.current}\nkey=${x.key ? "yes" : "no"}\nhave=${x.have.has(dir) ? "yes" : "no"}\nsup=yes\n`, exit_code: 0 };
        }
        if (command.includes("__BOPS_INSTALLED__")) {
          orgo.duringInstall?.();
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
        if (command.includes("__BOPS_HEALTHY__")) return { output: `${orgo.health}\n`, exit_code: 0 };
        if (command.includes("__BOPS_OFF__")) {
          // As the script does: the program, its script and the builds, never the computer's key.
          Object.assign(x, { current: "", have: new Set(), program: false });
          return { output: "__BOPS_OFF__\n", exit_code: 0 };
        }
        if (/^supervisorctl stop bops-runner/.test(command)) {
          x.program = false;
          return { output: "", exit_code: 0 };
        }
        if (/^supervisorctl status bops-runner/.test(command)) return { output: `${orgo.supervisor}\n__BOPS_STATUS_END__\n`, exit_code: 0 };
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
  // Orgo says so itself (it sees a share link too): the same, with no wait before the next look.
  reset();
  orgo.keyRefusal = { status: 409, json: { code: "full_access_member", error: "Someone else can use this workspace." } };
  await I.lookAtRunners();
  assert.equal(runner().error, "someone else can use this workspace");
  assert.equal(runner().keyMade, undefined);
  assert.equal(T.retryAt(C1), undefined, "looked at again on the next look");
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

await check("Orgo's copy of the routines follows each runner going up or down", async () => {
  reset();
  await I.lookAtRunners();
  assert.deepEqual(orgo.changed.sort(), ["boppy", "otto"], "up: the bots on that computer (Otto shares it)");
  orgo.changed.length = 0;
  orgo.mode = "mac";
  await I.lookAtRunners();
  assert.deepEqual(orgo.changed.sort(), ["boppy", "otto"], "down");
});

await check("a runner marked up that left a routine well past its time, and is gone from its computer: its routines go back to the Mac", async () => {
  reset();
  await I.lookAtRunners();
  orgo.bash.length = 0;
  // Overdue, but its program is there: left as it is.
  orgo.overdue = true;
  await I.lookAtRunners();
  assert.ok(orgo.bash.some((b) => /^supervisorctl status bops-runner/.test(b.command)));
  assert.equal(runner().status, "running");
  // Gone (it took itself off as if a copy, say): Couldn't start.
  reset();
  await I.lookAtRunners();
  orgo.overdue = true;
  orgo.supervisor = "bops-runner: ERROR (no such process)";
  await I.lookAtRunners();
  assert.deepEqual([runner().status, runner().error], ["failed", "it stopped on its computer"]);
  // Asleep: never woken to ask.
  reset();
  await I.lookAtRunners();
  orgo.overdue = true;
  orgo.supervisor = "bops-runner: ERROR (no such process)";
  pc(C1).status = "suspended";
  orgo.bash.length = 0;
  await I.lookAtRunners();
  assert.equal(orgo.bash.length, 0);
  assert.equal(runner().status, "running");
});

/* ---------------- The commands as shell ---------------- */

await check("every command it sends is shell that parses, and the wrapper too", () => {
  const scripts = [
    I.installScript({ name: BUNDLE, sha256: SHA, version: "0.0.29", buildId: "buildA1" }, I.wrapperScript({ computerId: C1, timeZone: "America/New_York", orgo: "https://orgo.example", cloud: "https://bops.example/api" })),
    I.HEALTH_SCRIPT,
    I.UNINSTALL_SCRIPT,
    I.probeScript("0.0.29-buildA1"),
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
