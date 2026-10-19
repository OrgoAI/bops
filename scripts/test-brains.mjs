// Tests for brains (lib/types.ts Brain and brainOf, lib/server/brains.ts, app/api/brains, vm/bin/bops-brain,
// components/app/brains.tsx): a bot's brain is Bops agent unless it picked one it's still on; the saved state
// is brought to the current shape; brains are added, renamed, given bots and removed (its bots back on Bops
// agent, signed out on its computers); Claude Code is installed at its pinned version from npm, unchanged,
// once per computer; Claude Code's own sign-in opens in a terminal on a free screen of the bot's computer,
// which the user is handed, its page in that screen's Chrome, and Bops asks Claude Code until it's signed in,
// then keeps only who's signed in (never the login, nor anything else Claude Code says) and hands the screen
// back; a sign-in that fails, or that the user leaves, says why; a login folder copied to another computer is
// never used there; sign-out is Claude Code's own; every Claude Code here runs with no Anthropic key or token
// from its environment, and a key brain's key comes in a file that's read and deleted, never on a command
// line; the routes are for the Bops window only; Settings' Brain section and a bot's Brain read right; a
// thread and a bot's profile say which brain ran it (or its tasks run on), and a thread Claude Code ran offers
// Open in terminal, and while it's open there says where and that a reply closes it; all with no long dashes.
//
// Orgo is a fake fetch on a made-up origin whose computers run each command here, in a throwaway folder: the
// real vm/bin/bops-brain (as Bops installed it on the fake computer) with a fake Claude Code, Codex, terminal
// and Chrome, in an environment with Anthropic keys and tokens planted in it. Nothing reaches a real service.
// Usage: node scripts/test-brains.mjs
//        REAL_CLAUDE=1 node scripts/test-brains.mjs   (also asks this Mac's own Claude Code about an empty folder)
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const REAL_CLAUDE = process.env.REAL_CLAUDE === "1";
for (const k of Object.keys(process.env))
  if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG|ANTHROPIC|CLAUDE_CODE)_/.test(k) || k === "CLAUDECODE" || k === "REAL_CLAUDE") delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
process.env.BOPS_APP_VERSION = "9.9.9";
const UI = "ui-token-test-brains";
process.env.BOPS_UI_TOKEN = UI;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-brains-"));
const fakebin = join(scratch, "fakebin");
mkdirSync(fakebin);
writeFileSync(join(fakebin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${fakebin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
globalThis.bopsOrgoKey = "sk_orgo_test_brains";
// The app's own files (vm/bin) are read from where it runs: here, a throwaway folder with them in it.
const work = join(scratch, "work");
mkdirSync(work);
symlinkSync(join(root, "vm"), join(work, "vm"));
process.chdir(work);

/* ---------------- Loading the app's modules ---------------- */

const fileUrl = (p) => pathToFileURL(`${root}/${p}`).href;
// sessions.ts is the app's task runner: here, the takeover and the computer's setup, as calls written down.
const SESSIONS_OWN = `
import { update } from ${JSON.stringify(fileUrl("lib/server/store.ts"))};
const calls = (globalThis.__sessionCalls ??= []);
export function takeOver(botId, display) {
  calls.push(["takeOver", botId, display]);
  update((s) => void (s.takeover = { botId, display, since: Date.now() }));
  return Promise.resolve().then(() => {
    if (globalThis.__wakeFails) update((s) => void (s.takeover = undefined));
  });
}
export function returnControl() {
  calls.push(["returnControl"]);
  update((s) => void (s.takeover = undefined));
}
export async function ensureComputer(botId) { calls.push(["ensureComputer", botId]); }
export async function ensureScreens(computerId) { calls.push(["ensureScreens", computerId]); }
export function brainLeft(brainId, name) { calls.push(["brainLeft", brainId, name]); return globalThis.__brainLeft?.(brainId) ?? []; }
`;
const OWN = new Set(["takeOver", "returnControl", "ensureComputer", "ensureScreens", "brainLeft"]);
// Modules that start processes when loaded do nothing.
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
registerHooks({
  resolve(specifier, context, next) {
    // Only the server may import these; here everything is the server, and the window's code too.
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
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (name && (STAND_INS.has(name) || name === "sessions")) {
      const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
      const rest = names.filter((n) => name !== "sessions" || !OWN.has(n)).map((n) => `export const ${n} = function () { return Promise.resolve(); };`);
      return { format: "module", shortCircuit: true, source: [...rest, name === "sessions" ? SESSIONS_OWN : ""].join("\n") };
    }
    if (!url.endsWith(".tsx")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});
const logged = [];
for (const k of ["info", "warn", "error", "debug"]) console[k] = (...a) => void logged.push(a.map(String).join(" "));

/* ---------------- Fakes: Claude Code, Codex, a terminal, Chrome, Chrome's DevTools, bops-chrome ---------------- */

const LOG = join(scratch, "logs");
mkdirSync(LOG);
const SLOW = join(scratch, "slow-login");
const STOP = join(scratch, "stop");
const fake = (name, body) => writeFileSync(join(fakebin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
// Claude Code as far as Bops uses it: its version, and its own auth status, login and logout, writing down
// every run (its arguments, then its whole environment). Its login is a file in its folder, as the real one's is.
fake(
  "claude",
  `D="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
# One write per run, so runs at the same time (a login and a status) don't interleave.
printf '%s\n' "=== $*"$'\n'"$(env | LC_ALL=C sort)" >> ${LOG}/claude.log
[ "$1" = --version ] && { echo "2.1.292 (Claude Code)"; exit 0; }
case "$1 \${2:-}" in
  "auth status")
    if [ -f "$D/.credentials.json" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"maya@acme.test","orgId":"org-7f3a","orgName":"Acme","subscriptionType":"max","configDirectory":"'"$D"'","accessToken":"sk-ant-oat01-NEVER-KEPT"}'
    else echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'; exit 1; fi ;;
  "auth login")
    if [ -f ${SLOW} ]; then for _ in $(seq 1 300); do [ -f ${STOP} ] && exit 1; sleep 0.1; done; exit 1; fi
    echo "Opening the browser to sign in"
    "$BROWSER" "https://claude.ai/oauth/authorize?code=true&state=s1&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback" || echo "no browser"
    # The user signs in on the page it opened (its Chrome, started in the background, up first).
    for _ in $(seq 1 60); do [ -s ${LOG}/signin-chrome.log ] && break; sleep 0.05; done
    printf '%s' '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-NEVER-KEPT"}}' > "$D/.credentials.json"
    echo "Login successful." ;;
  "auth logout") rm -f "$D/.credentials.json"; echo "Successfully logged out." ;;
  *) echo "ran claude $*" ;;
esac`,
);
fake("codex", `printf '%s\\n' "=== $*"$'\\n'"$(env | LC_ALL=C sort)" >> ${LOG}/codex.log\necho "ran codex $*"`);
// xfce4-terminal: what it was asked, then the command after -x, in its place.
fake("xfce4-terminal", `echo "$*" >> ${LOG}/terminal.log\nwhile [ $# -gt 0 ] && [ "$1" != -x ]; do shift; done\nshift\nexec "$@"`);
fake("setsid", `exec "$@"`);
fake("xdotool", "exit 0");
// The screen's Chrome answers on its DevTools port: /json/version, and /json/new with the page to open.
fake("curl", `echo "$*" >> ${LOG}/curl.log\nfor a in "$@"; do case "$a" in */json/version) exit 0 ;; esac; done\nexit 0`);
fake("bops-chrome", `echo "$*" >> ${LOG}/chrome.log`);
// The sign-in's own Chrome (bops-brain-browser): what it was asked, and the profile it would write to.
fake("google-chrome-stable", `echo "$*" >> ${LOG}/signin-chrome.log\nfor a in "$@"; do case "$a" in --user-data-dir=*) mkdir -p "\${a#--user-data-dir=}/Default" && echo cookie > "\${a#--user-data-dir=}/Default/Cookies" ;; esac; done`);
const lines = (name) => (existsSync(join(LOG, name)) ? readFileSync(join(LOG, name), "utf8") : "");
/** Every run of the fake Claude Code so far: its arguments and its environment. */
const claudeRuns = () =>
  lines("claude.log")
    .split(/^=== /m)
    .filter(Boolean)
    .map((block) => {
      const [args, ...env] = block.split("\n");
      return { args, env: Object.fromEntries(env.filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])) };
    });

/* ---------------- A fake Orgo whose computers run commands here ---------------- */

/** What a computer's environment has besides Bops' own: keys and tokens Claude Code would use first. */
const PLANTED = { ANTHROPIC_API_KEY: "sk-ant-api03-PLANTED", ANTHROPIC_AUTH_TOKEN: "planted-auth-token", CLAUDE_CODE_OAUTH_TOKEN: "planted-oauth-token", ANTHROPIC_BASE_URL: "https://planted.test", CLAUDECODE: "1" };
const pcs = new Map();
const pc = (id) => {
  if (!pcs.has(id)) {
    const dir = join(scratch, "pcs", id);
    for (const d of ["bin", "brains", "logs", "home"]) mkdirSync(join(dir, d), { recursive: true });
    pcs.set(id, { id, dir, bin: join(dir, "bin"), brains: join(dir, "brains"), commands: [], installs: 0, installFails: false, fresh: true });
  }
  return pcs.get(id);
};
/** A path on a fake computer: its /usr/local/bin is its own folder. */
const onPc = (c, path) => (path.startsWith("/usr/local/bin/") ? join(c.bin, path.slice("/usr/local/bin/".length)) : null);
const runHere = (c, command) =>
  new Promise((resolve) =>
    execFile(
      "/bin/bash",
      ["-c", command],
      {
        env: {
          PATH: `${c.bin}:${fakebin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          HOME: join(c.dir, "home"),
          BOPS_BRAINS: c.brains,
          BOPS_CLAUDE: join(fakebin, "claude"),
          BOPS_CODEX: join(fakebin, "codex"),
          BOPS_LOGS: join(c.dir, "logs"),
          BOPS_HOME: join(c.dir, "home"),
          BOPS_CHROME: join(fakebin, "bops-chrome"),
          ...PLANTED,
        },
        timeout: 20_000,
      },
      (err, stdout, stderr) => resolve({ output: `${stdout}${stderr}`, exit_code: err ? (typeof err.code === "number" ? err.code : 1) : 0 }),
    ),
  );
async function bash(id, command) {
  const c = pc(id);
  c.commands.push(command);
  if (command.startsWith("md5sum "))
    return {
      output: command
        .split(" ")
        .slice(1)
        .filter((p) => p.startsWith("/"))
        .map((p) => onPc(c, p))
        .filter((f) => f && existsSync(f))
        .map((f) => `${createHash("md5").update(readFileSync(f)).digest("hex")}  /usr/local/bin/${f.slice(c.bin.length + 1)}`)
        .join("\n"),
      exit_code: 0,
    };
  const write = /^echo ([A-Za-z0-9+/=]+) \| base64 -d > (\S+) && chmod (\d+) \2 && echo ok$/.exec(command);
  if (write) {
    writeFileSync(onPc(c, write[2]), Buffer.from(write[1], "base64"), { mode: parseInt(write[3], 8) });
    return { output: "ok\n", exit_code: 0 };
  }
  if (command.includes("npm install -g --prefix /opt/bops/claude")) {
    c.installs++;
    return c.installFails ? { output: "npm ERR! network request failed\n", exit_code: 0 } : { output: "claude 2.1.292\n", exit_code: 0 };
  }
  if (/(^|\n|; )bops-brain /.test(command)) return runHere(c, command);
  return { output: "", exit_code: 0 };
}
const orgoCalls = [];
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
/** The Vault, by where each key is ("<Orgo project>/<name>"; no project: for all workspaces), and what was revealed. */
const vault = new Map([["/ANTHROPIC_API_KEY", "sk-ant-api03-VAULT-KEY"]]);
const reveals = [];
globalThis.fetch = async (input, init = {}) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin !== "https://orgo.test") throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
  const text = req.body ? await req.text() : "";
  const body = text ? JSON.parse(text) : undefined;
  orgoCalls.push({ method: req.method, path: url.pathname, body });
  const m = /^\/api\/computers\/([^/]+)\/bash$/.exec(url.pathname);
  if (m && req.method === "POST") return json(200, await bash(m[1], body.command));
  if (url.pathname === "/api/secrets/reveal" && req.method === "POST") {
    const k = `${body.workspace_id ?? ""}/${body.name}`;
    reveals.push(k);
    return vault.has(k) ? json(200, { name: body.name, value: vault.get(k) }) : json(404, { error: "Secret not set" });
  }
  if (url.pathname === "/api/secrets" && req.method === "GET")
    return json(200, { secrets: [...vault.keys()].map((k) => ({ name: k.split("/")[1], workspace_id: k.split("/")[0] || null, updated_at: "2026-10-01T00:00:00Z" })) });
  if (url.pathname === "/api/bops/computer/active") return json(200, { ok: true });
  return json(404, { error: "Not found" });
};

/* ---------------- The app ---------------- */

const T = await import(fileUrl("lib/types.ts"));
const A = await import(fileUrl("lib/asks.ts"));
const S = await import(fileUrl("lib/server/store.ts"));
const B = await import(fileUrl("lib/server/brains.ts"));
const R = await import(fileUrl("app/api/brains/route.ts"));
const RB = await import(fileUrl("app/api/brains/bot/route.ts"));
const RS = await import(fileUrl("app/api/brains/sign-in/route.ts"));
const RO = await import(fileUrl("app/api/brains/sign-out/route.ts"));
const { userDataDir } = await import(fileUrl("lib/server/user-paths.ts"));
const sessionCalls = (globalThis.__sessionCalls ??= []);

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok ${name}`);
};
const until = async (what, ok, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};
const noDashes = (text, where) => assert.ok(!/[–—]/.test(text), `no long dashes in ${where}: ${text.match(/.{0,40}[–—].{0,40}/)?.[0]}`);
const fromWindow = (url, body, method = "POST") =>
  new Request(`http://localhost:3210${url}`, { method, headers: { "content-type": "application/json", cookie: `bops_window=${UI}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const bot = (id) => S.bot(id);
const brain = (id) => S.getState().brains?.find((x) => x.id === id);
B.signInTiming.pollMs = 20;
B.signInTiming.afterHandBackMs = 150;
B.signInTiming.maxMs = 8000;

// Boppy has its computer; Otto works on it too; Rook has its own; Kai is in another workspace.
S.update((s) => {
  s.host = "orgo";
  s.workspaces = [{ id: "ws_main", name: "Main", createdAt: 1 }, { id: "ws_two", name: "Two", createdAt: 2 }];
  s.workspace = "ws_main";
  Object.assign(s.bots.find((b) => b.isMain), { computerId: "pc-main", computerStatus: "ready" });
  s.bots.push(
    { id: "otto", name: "Otto", role: "Outbound", color: "#E9FF3B", isMain: false, computerStatus: "none", computer: "shared" },
    { id: "rook", name: "Rook", role: "Recruiting", color: "#47C46B", isMain: false, computerStatus: "ready", computer: "own", computerId: "pc-rook" },
    { id: "kai", name: "Kai", role: "Ops", color: "#5B8CFF", isMain: true, computerStatus: "none", workspaceId: "ws_two" },
  );
});

/* ---------------- The model ---------------- */

await test("a bot's brain is Bops agent unless it picked one that's there and still has it", () => {
  const x = { id: "brain_a", kind: "claude", name: "Claude Code", auth: "plan", bots: ["otto"], workspaceId: "ws_main", createdAt: 1 };
  const state = { brains: [x] };
  assert.equal(T.brainOf({ id: "otto" }, state), undefined, "no brain picked: Bops agent");
  assert.equal(T.brainOf({ id: "otto", brain: "brain_a" }, state), x);
  assert.equal(T.brainOf({ id: "rook", brain: "brain_a" }, state), undefined, "taken off its chips: Bops agent");
  assert.equal(T.brainOf({ id: "otto", brain: "brain_gone" }, state), undefined, "a brain that's gone: Bops agent");
  assert.equal(T.brainOf({ id: "otto", brain: "brain_a" }, {}), undefined);
  assert.deepEqual(T.BRAIN_KEYS, { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY" });
});

await test("a plan brain is ready where it's signed in on the computer the bot works on; a key brain, with its key named", () => {
  const plan = { id: "brain_p", kind: "claude", name: "Claude Code", auth: "plan", bots: ["otto", "rook"], workspaceId: "ws_main", createdAt: 1, signIns: [{ computerId: "pc-main", at: 1 }] };
  const st = S.getState();
  assert.equal(T.signInOn(plan, "pc-main")?.computerId, "pc-main");
  assert.equal(T.signInOn(plan, undefined), undefined);
  assert.equal(T.brainReady(plan, bot("otto"), st), true, "Otto works on Boppy's computer");
  assert.equal(T.brainReady(plan, bot("rook"), st), false, "Rook's own computer needs its own sign-in");
  assert.equal(T.brainReady(plan, bot("otto"), { ...st, host: "mac" }), false, "no bot computer on this Mac");
  assert.equal(T.brainReady({ ...plan, auth: "key", keyName: "ANTHROPIC_API_KEY" }, bot("rook"), st), true);
});

await test("a saved state's brains come back in shape: real bots only, Codex on a key, no sign-in left going, a gone brain is Bops agent", async () => {
  const file = join(userDataDir("u-norm"), "state.json");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      bots: [
        { id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", computerId: "pc-now", brain: "brain_ok" },
        { id: "otto", name: "Otto", role: "Outbound", color: "#E9FF3B", isMain: false, computerStatus: "none", brain: "brain_lost" },
      ],
      brains: [
        { id: "brain_ok", kind: "claude", name: "Claude Code", auth: "plan", bots: ["boppy", "ghost"], createdAt: 1, signingIn: { botId: "boppy", computerId: "pc", display: 100, at: 1 } },
        { id: "brain_cx", kind: "codex", name: "Codex", auth: "plan", bots: "boppy", workspaceId: "ws_main", createdAt: 2, signingIn: { botId: "boppy", computerId: "pc", display: 101, at: 1, failed: "it took too long." } },
        { id: "brain_bad", kind: "gemini", name: "?", auth: "plan", bots: [], createdAt: 3 },
        { id: "brain_away", kind: "claude", name: "Claude Code", auth: "plan", bots: [], workspaceId: "ws_deleted", createdAt: 4 },
        { id: "brain_old", kind: "claude", name: "Claude Code 2", auth: "plan", bots: ["boppy"], createdAt: 5, signIns: [{ computerId: "pc-replaced", at: 1, account: { plan: "pro" } }, { computerId: "pc-now", at: 2, account: { plan: "max" } }] },
        null,
      ],
      workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }],
    }),
  );
  const before = structuredClone(S.getState());
  await S.bindSignIn("u-norm");
  const st = S.getState();
  assert.deepEqual(st.brains.map((x) => x.id), ["brain_ok", "brain_cx", "brain_old"], "a deleted workspace's brain goes with it");
  assert.deepEqual(st.brains[2].signIns.map((x) => x.computerId), ["pc-now"], "signed in only on a computer a bot has");
  const [ok, cx] = st.brains;
  assert.deepEqual(ok.bots, ["boppy"], "a bot that isn't here is dropped");
  assert.equal(ok.workspaceId, "ws_main");
  assert.equal(ok.signingIn, undefined, "a sign-in that was going can't be watched now");
  assert.equal(cx.auth, "key", "Codex signs in with a key only");
  assert.deepEqual(cx.bots, []);
  assert.equal(cx.signingIn.failed, "it took too long.", "a failed one stays, saying why");
  assert.equal(st.bots.find((b) => b.id === "boppy").brain, "brain_ok");
  assert.equal(st.bots.find((b) => b.id === "otto").brain, undefined, "its brain is gone: Bops agent");
  // Back to the state the rest of the tests use.
  await S.releaseSignOut();
  S.update((s) => Object.assign(s, before));
});

/* ---------------- Adding, changing, removing ---------------- */

let planId;
await test("brains are added to the workspace with the bots picked, named after what they are", () => {
  assert.throws(() => B.addBrain({ kind: "codex", auth: "plan" }), /OpenAI API key only/);
  assert.throws(() => B.addBrain({ kind: "gemini", auth: "key" }), /Claude Code or Codex/);
  const x = B.addBrain({ kind: "claude", auth: "plan", bots: ["otto", "rook", "kai", "otto", "nobody"], use: true });
  planId = x.id;
  assert.equal(x.name, "Claude Code");
  assert.equal(x.workspaceId, "ws_main");
  assert.deepEqual(x.bots, ["otto", "rook"], "only this workspace's bots, each once");
  assert.equal(x.keyName, undefined);
  assert.equal(bot("otto").brain, x.id, "use: the bots picked use it now");
  assert.equal(bot("rook").brain, x.id);
  const y = B.addBrain({ kind: "claude", auth: "key", keyScope: "workspace", bots: ["boppy"] });
  assert.equal(y.name, "Claude Code 2");
  assert.equal(y.keyName, "ANTHROPIC_API_KEY");
  assert.equal(y.keyScope, "workspace");
  assert.equal(bot("boppy").brain, undefined, "without use, the bot may pick it but still has Bops agent");
  const z = B.addBrain({ kind: "codex", auth: "key", bots: ["boppy"] });
  assert.equal(z.name, "Codex");
  assert.equal(z.keyName, "OPENAI_API_KEY");
  assert.equal(z.keyScope, "all");
  B.removeBrain(y.id);
  B.removeBrain(z.id);
});

await test("a brain is renamed, and its bots set one by one: uses it, can pick it, or neither", async () => {
  assert.equal(B.updateBrain(planId, { name: "  Claude Code — work  " }).name, "Claude Code - work", "one line, no long dash");
  assert.throws(() => B.updateBrain(planId, { name: "   " }), /Give it a name/);
  assert.equal(B.setBrainBot(planId, "boppy", "may").bots.includes("boppy"), true);
  assert.equal(bot("boppy").brain, undefined);
  B.setBrainBot(planId, "boppy", "use");
  assert.equal(bot("boppy").brain, planId);
  B.setBrainBot(planId, "boppy", "none");
  assert.equal(bot("boppy").brain, undefined, "taken off: back on Bops agent");
  assert.equal(brain(planId).bots.includes("boppy"), false);
  assert.throws(() => B.setBrainBot(planId, "kai", "use"), /No such bot here/);
  B.updateBrain(planId, { bots: ["otto"] });
  assert.equal(bot("rook").brain, undefined, "a bot taken off the list goes back to Bops agent");
  B.updateBrain(planId, { bots: ["otto", "rook"], name: "Claude Code" });
  assert.throws(() => B.setBotBrain("boppy", planId), /isn't on that brain/);
  B.setBotBrain("rook", planId);
  assert.equal(bot("rook").brain, planId);
  B.setBotBrain("rook", null);
  assert.equal(bot("rook").brain, undefined);
  B.setBotBrain("rook", planId);
  // Each change that takes a bot off it stops what it runs for that bot now (sessions.ts brainLeft).
  await until("the threads it runs to be let go", () => sessionCalls.filter((c) => c[0] === "brainLeft" && c[1] === planId).length >= 4);
  assert.ok(sessionCalls.some((c) => c[0] === "brainLeft" && c[2] === "Claude Code"));
});

/* ---------------- Claude Code on a computer ---------------- */

await test("Claude Code is npm's own package at the pinned version, into Bops' folder, once per computer", async () => {
  const cmd = B.claudeInstallCommand();
  assert.equal(B.CLAUDE_CODE_VERSION, "2.1.292");
  assert.match(cmd, /npm install -g --prefix \/opt\/bops\/claude --no-audit --no-fund --loglevel=error @anthropic-ai\/claude-code@2\.1\.292 /);
  assert.doesNotMatch(cmd, /ignore-scripts|--force|patch|sed /, "installed as it comes");
  assert.match(cmd, /DISABLE_AUTOUPDATER=1 \/opt\/bops\/claude\/bin\/claude --version/);
  assert.match(readFileSync(join(root, "orgo/bops-base.mjs"), "utf8"), /const CLAUDE_CODE_VERSION = "2\.1\.292";/, "the next image has the same one");
  await B.ensureClaudeCode("pc-x");
  await B.ensureClaudeCode("pc-x");
  assert.equal(pc("pc-x").installs, 1, "asked once per computer");
  pc("pc-y").installFails = true;
  await assert.rejects(B.ensureClaudeCode("pc-y"), /Claude Code didn't install on the computer \(npm ERR! network request failed\)/);
  pc("pc-y").installFails = false;
  await B.ensureClaudeCode("pc-y");
  assert.equal(pc("pc-y").installs, 2, "one that failed is tried again");
});

await test("the brain scripts go on a computer as they are in vm/bin, and only when they changed", async () => {
  await B.ensureBrainTools("pc-main");
  for (const f of ["bops-brain", "bops-brain-browser"]) assert.equal(readFileSync(join(pc("pc-main").bin, f), "utf8"), readFileSync(join(root, "vm/bin", f), "utf8"));
  const n = pc("pc-main").commands.length;
  await B.ensureBrainTools("pc-main");
  assert.equal(pc("pc-main").commands.length, n, "checked once per run of Bops");
});

await test("Claude Code's status is kept to whether it's signed in, how, and whose account", () => {
  const st = B.parseStatus(
    'warning: something\n{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"maya@acme.test","orgId":"org-1","orgName":"Acme","subscriptionType":"Max","configDirectory":"/root/.bops/brains/b","accessToken":"sk-ant-oat01-x","refreshToken":"r"}\n',
  );
  assert.deepEqual(st, { loggedIn: true, method: "claude.ai", account: { email: "maya@acme.test", orgName: "Acme", plan: "max" } });
  assert.deepEqual(B.parseStatus('{"loggedIn":false,"authMethod":"none","email":"x@y.z"}'), { loggedIn: false });
  assert.deepEqual(B.parseStatus('{"loggedIn":true}'), { loggedIn: true });
  assert.equal(B.parseStatus("claude: command not found"), null);
  assert.equal(B.parseStatus('{"loggedIn":"yes"}'), null);
});

/* ---------------- Signing in ---------------- */

await test("a sign-in opens Claude Code's own on a free screen of the bot's computer, which the user is handed", async () => {
  // Boppy is working on screen 1 of the computer Otto shares.
  S.update((s) => s.sessions.push({ id: "s_busy", botId: "boppy", chatId: T.botChatId("boppy"), sentVia: "you", title: "Busy", goal: "Busy", host: "orgo", status: "running", display: 100, steps: [], replies: [], createdAt: Date.now() }));
  const at = await B.startSignIn(planId, "otto");
  assert.deepEqual(at, { botId: "otto", display: 101 }, "the first free screen");
  assert.deepEqual(S.getState().takeover && { botId: S.getState().takeover.botId, display: S.getState().takeover.display }, { botId: "otto", display: 101 }, "the user has it at once, so no task starts there");
  assert.equal(brain(planId).signingIn.display, 101);
  assert.equal(brain(planId).signingIn.computerId, "pc-main");
  await until("the sign-in to finish", () => brain(planId).signIns?.length);
  const c = pc("pc-main");
  assert.ok(c.commands.some((x) => x === `bops-brain login ${planId} 101 pc-main`), "Claude Code's sign-in, on that screen");
  assert.ok(sessionCalls.some((x) => x[0] === "ensureScreens" && x[1] === "pc-main"));
  // The terminal on screen 101, running Claude Code's own login.
  assert.match(lines("terminal.log"), new RegExp(`--disable-server --title Sign in to Claude Code .* -x .*bops-brain sign-in ${planId} 101`));
  // Claude Code's own sign-in as it is by default (its Claude subscription one): Bops adds no choice of its own.
  const login = claudeRuns().find((r) => r.args === "auth login");
  assert.ok(login, "claude auth login");
  assert.equal(login.env.DISPLAY, ":101");
  assert.equal(login.env.CLAUDE_CONFIG_DIR, join(c.brains, planId));
  assert.match(login.env.BROWSER, /bops-brain-browser$/);
  // Its page in a Chrome of its own on that screen: a throwaway profile beside the brain's folder, incognito,
  // no DevTools port, a window class of its own. Never the bots' Chrome there (its DevTools, bops-chrome).
  const page = lines("signin-chrome.log");
  assert.ok(page.includes(`--user-data-dir=${join(c.brains, `.signin-${planId}`)} `), page);
  for (const want of ["--incognito", "--class=BopsSignIn", "--no-first-run", "https://claude.ai/oauth/authorize?code=true&state=s1&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback"]) assert.ok(page.includes(want), `${want}: ${page}`);
  assert.ok(!/remote-debugging-port|BopsBrowser|profiles\/s/.test(page), page);
  assert.ok(!lines("curl.log").includes("json/new") && !lines("chrome.log"), "nothing went to the bots' Chrome");
  // Signed in: only who, kept; the screen handed back; the chat says so.
  const x = brain(planId);
  assert.equal(x.signingIn, undefined);
  assert.deepEqual(
    x.signIns.map((s) => ({ ...s, at: typeof s.at })),
    [{ computerId: "pc-main", at: "number", method: "claude.ai", account: { email: "maya@acme.test", orgName: "Acme", plan: "max" } }],
  );
  await until("the screen to be handed back", () => !S.getState().takeover);
  const note = S.getState().messages.filter((m) => m.chatId === T.botChatId("otto")).at(-1);
  assert.equal(note.text, "Claude Code is signed in on Boppy's computer with your Max plan.");
  assert.equal(note.role, "system");
  assert.equal(readFileSync(join(c.brains, planId, ".computer"), "utf8"), "pc-main", "the folder knows its computer");
  assert.ok(!existsSync(join(c.brains, `.signin-${planId}`)), "the sign-in's Chrome profile (its claude.ai cookies) is gone");
  assert.ok(T.brainReady(x, bot("otto"), S.getState()));
  assert.ok(!T.brainReady(x, bot("rook"), S.getState()), "Rook's computer is another one");
  S.update((s) => (s.sessions = s.sessions.filter((y) => y.id !== "s_busy")));
});

await test("nothing of the login, and nothing planted, is in the state, a log or a command", () => {
  const all = JSON.stringify(S.getState());
  for (const bad of ["sk-ant", "NEVER-KEPT", "PLANTED", "planted", "org-7f3a", "configDirectory", "firstParty", "credentials"]) assert.ok(!all.includes(bad), `not in the state: ${bad}`);
  for (const l of logged) assert.ok(!/sk-ant|NEVER-KEPT/.test(l), `not logged: ${l}`);
  for (const cmd of [...pcs.values()].flatMap((c) => c.commands)) assert.ok(!/sk-ant|NEVER-KEPT|VAULT-KEY/.test(cmd), "no key or token in a command");
});

await test("every Claude Code run here starts with no Anthropic key or token from its environment", () => {
  const runs = claudeRuns();
  assert.ok(runs.length >= 3);
  for (const r of runs) {
    for (const k of Object.keys(r.env)) assert.ok(!/^ANTHROPIC_|^CLAUDE_CODE_OAUTH|^CLAUDECODE$|^BOPS_/.test(k), `${r.args}: ${k} reached Claude Code`);
    assert.ok(!Object.values(r.env).some((v) => /PLANTED|planted/.test(v)), `${r.args}: something planted reached it`);
    assert.equal(r.env.DISABLE_AUTOUPDATER, "1", "the pinned version stays");
    assert.ok(r.env.CLAUDE_CONFIG_DIR?.startsWith(pc("pc-main").brains), "its own folder");
  }
});

await test("a folder copied to another computer is never signed in there: it's deleted", async () => {
  const c = pc("pc-main");
  const out = await runHere(c, `bops-brain status ${planId} pc-copy`);
  assert.equal(B.parseStatus(out.output).loggedIn, false);
  assert.ok(!existsSync(join(c.brains, planId)), "the copy's login is gone");
  // As the real computer sees it again: Claude Code says it's signed out there.
  assert.equal((await B.signInStatus(planId, "pc-main")).loggedIn, false);
  assert.equal(brain(planId).signIns, undefined);
});

await test("a sign-in that can't get Claude Code on the computer says why, and gives the screen back", async () => {
  pc("pc-rook").installFails = true;
  const at = await B.startSignIn(planId, "rook");
  assert.equal(at.botId, "rook");
  await until("the sign-in to fail", () => brain(planId).signingIn?.failed);
  assert.match(brain(planId).signingIn.failed, /Claude Code didn't install on the computer/);
  assert.equal(S.getState().takeover, undefined);
  assert.match(S.getState().messages.filter((m) => m.chatId === T.botChatId("rook")).at(-1).text, /^Claude Code didn't sign in on Rook's computer: Claude Code didn't install/);
  pc("pc-rook").installFails = false;
});

await test("a computer that couldn't wake ends the sign-in, saying so", async () => {
  globalThis.__wakeFails = true;
  await B.startSignIn(planId, "rook");
  await until("the sign-in to fail", () => brain(planId).signingIn?.failed);
  assert.equal(brain(planId).signingIn.failed, "Rook's computer is asleep and couldn't wake up.");
  globalThis.__wakeFails = false;
});

await test("a sign-in the user leaves (the screen handed back) ends a little after, with its terminal closed", async () => {
  writeFileSync(SLOW, "");
  await B.startSignIn(planId, "rook");
  const c = pc("pc-rook");
  await until("the sign-in to open", () => c.commands.some((x) => x.startsWith(`bops-brain login ${planId}`)));
  (await import(fileUrl("lib/server/sessions.ts"))).returnControl();
  await until("the sign-in to end", () => brain(planId).signingIn?.failed);
  assert.equal(brain(planId).signingIn.failed, "the screen was handed back before signing in finished.");
  assert.ok(c.commands.includes(`bops-brain cancel ${planId}`), "its terminal closed");
  await until("the terminal to go", () => !execFileSync("/bin/ps", ["-axo", "command"], { encoding: "utf8" }).includes(`bops-brain sign-in ${planId}`));
  rmSync(SLOW);
});

await test("a sign-in can be stopped, and tried again on a bot with no free screen says so", async () => {
  writeFileSync(SLOW, "");
  await B.startSignIn(planId, "rook");
  const again = await B.startSignIn(planId, "rook");
  assert.equal(again.display, brain(planId).signingIn.display, "the same one again while it's going");
  await B.cancelSignIn(planId);
  assert.equal(brain(planId).signingIn, undefined);
  assert.equal(S.getState().takeover, undefined);
  rmSync(SLOW);
  S.update((s) => {
    s.watches = [100, 101, 102, 99].map((d, i) => ({ id: `w${i}`, botId: "rook", site: "x.com", display: d, lookFor: "", createdAt: 1 }));
  });
  await assert.rejects(B.startSignIn(planId, "rook"), /All of Rook's screens are in use/);
  S.update((s) => (s.watches = []));
  await assert.rejects(B.startSignIn(planId, "boppy"), /Let Boppy use Claude Code first/);
  S.update((s) => (s.host = "mac"));
  await assert.rejects(B.startSignIn(planId, "rook"), /browsers on this Mac/);
  S.update((s) => (s.host = "orgo"));
});

await test("signing in again works, and signing out is Claude Code's own sign-out", async () => {
  await B.startSignIn(planId, "rook");
  await until("the sign-in to finish", () => T.signInOn(brain(planId), "pc-rook"));
  assert.ok(existsSync(join(pc("pc-rook").brains, planId, ".credentials.json")));
  await B.signOut(planId, "rook");
  assert.equal(T.signInOn(brain(planId), "pc-rook"), undefined);
  assert.ok(!existsSync(join(pc("pc-rook").brains, planId, ".credentials.json")), "Claude Code signed out");
  assert.ok(claudeRuns().some((r) => r.args === "auth logout" && r.env.CLAUDE_CONFIG_DIR === join(pc("pc-rook").brains, planId)));
});

/* ---------------- Runs ---------------- */

await test("a run takes a key brain's key from a file it deletes, never from a command line; a plan run gets none", async () => {
  const c = pc("pc-run");
  await B.ensureBrainTools("pc-run");
  const keyFile = join(c.dir, "key-1");
  writeFileSync(keyFile, "sk-ant-api03-FROM-FILE", { mode: 0o600 });
  const keyed = await runHere(c, `bops-brain run brain_k claude --key-file ${keyFile} -- -p "say hi" --output-format stream-json`);
  assert.match(keyed.output, /ran claude -p say hi --output-format stream-json/);
  assert.ok(!existsSync(keyFile), "the key file is deleted");
  const run = claudeRuns().at(-1);
  assert.equal(run.env.ANTHROPIC_API_KEY, "sk-ant-api03-FROM-FILE");
  assert.ok(!run.args.includes("sk-ant"), "not on its command line");
  assert.equal(run.env.ANTHROPIC_AUTH_TOKEN, undefined, "nothing else planted");
  await runHere(c, "DISPLAY=:102 bops-brain run brain_p claude -- -p hi");
  assert.ok(!Object.keys(claudeRuns().at(-1).env).some((k) => /^ANTHROPIC_/.test(k)), "a plan run has no Anthropic variables at all");
  assert.equal(claudeRuns().at(-1).env.DISPLAY, ":102", "the screen its tools work on carries over");
  writeFileSync(keyFile, "sk-openai-FROM-FILE", { mode: 0o600 });
  await runHere(c, `bops-brain run brain_c codex --key-file ${keyFile} -- exec --json hi`);
  const cx = lines("codex.log").split(/^=== /m).filter(Boolean).at(-1);
  assert.match(cx, /^exec --json hi\n/);
  assert.match(cx, /\nCODEX_API_KEY=sk-openai-FROM-FILE\n/);
  assert.match(cx, new RegExp(`\\nCODEX_HOME=${join(c.brains, "brain_c")}\\n`));
  assert.doesNotMatch(cx, /ANTHROPIC_|PLANTED/);
  assert.equal((await runHere(c, "bops-brain run ../etc claude")).exit_code, 2, "a brain is a plain name");
  // A plan brain's folder that came with a copy of another computer: gone before Claude Code runs.
  mkdirSync(join(c.brains, "brain_cp"), { recursive: true });
  writeFileSync(join(c.brains, "brain_cp", ".computer"), "pc-elsewhere");
  writeFileSync(join(c.brains, "brain_cp", ".credentials.json"), "{}");
  await runHere(c, "bops-brain run brain_cp claude --computer pc-run -- -p hi");
  assert.ok(!existsSync(join(c.brains, "brain_cp", ".credentials.json")), "the copied login is gone");
  assert.equal(claudeRuns().at(-1).args, "-p hi");
});

await test("a key brain's key comes from the Vault for its run only, and isn't kept", async () => {
  const k = B.addBrain({ kind: "claude", auth: "key", bots: ["boppy"] });
  assert.equal(await B.revealBrainKey(k), "sk-ant-api03-VAULT-KEY");
  assert.ok(!JSON.stringify(S.getState()).includes("VAULT-KEY"));
  await assert.rejects(B.revealBrainKey(brain(planId)), /doesn't run on a key/);
  // Added while the key was for all workspaces; now this workspace has its own, and the other is gone: its own.
  S.update((s) => (s.workspaces.find((w) => w.id === "ws_main").orgoProjectId = "proj_main"));
  vault.delete("/ANTHROPIC_API_KEY");
  vault.set("proj_main/ANTHROPIC_API_KEY", "sk-ant-api03-WS-KEY");
  assert.equal(brain(k.id).keyScope, "all");
  assert.equal(await B.revealBrainKey(brain(k.id)), "sk-ant-api03-WS-KEY", "the workspace's own, as the bots' calls find it");
  assert.equal(reveals.at(-1), "proj_main/ANTHROPIC_API_KEY");
  // Both there: the workspace's own first.
  vault.set("/ANTHROPIC_API_KEY", "sk-ant-api03-VAULT-KEY");
  assert.equal(await B.revealBrainKey({ ...brain(k.id), keyScope: "all" }), "sk-ant-api03-WS-KEY");
  vault.delete("proj_main/ANTHROPIC_API_KEY");
  S.update((s) => delete s.workspaces.find((w) => w.id === "ws_main").orgoProjectId);
  B.removeBrain(k.id);
});

await test("a sign-in asked for on another computer closes the one going first: its terminal and page, and its screen back", async () => {
  writeFileSync(SLOW, "");
  const first = await B.startSignIn(planId, "otto");
  await until("the first sign-in to open", () => pc("pc-main").commands.includes(`bops-brain login ${planId} ${first.display} pc-main`));
  assert.equal(S.getState().takeover?.display, first.display);
  const n = pc("pc-main").commands.length;
  const handed = sessionCalls.filter((c) => c[0] === "returnControl").length;
  const at = await B.startSignIn(planId, "rook");
  assert.equal(at.botId, "rook");
  assert.ok(pc("pc-main").commands.slice(n).includes(`bops-brain cancel ${planId}`), "closed on Boppy's computer");
  assert.equal(brain(planId).signingIn.computerId, "pc-rook");
  assert.equal(sessionCalls.filter((c) => c[0] === "returnControl").length, handed + 1, "Boppy's screen went back before Rook's was taken");
  await B.cancelSignIn(planId);
  rmSync(SLOW, { force: true });
});

/* ---------------- Routes ---------------- */

await test("the routes are the Bops window's only, and add, change, sign in and remove brains", async () => {
  const outside = await R.POST(new Request("http://localhost:3210/api/brains", { method: "POST", body: JSON.stringify({ kind: "claude", auth: "plan" }) }));
  assert.equal(outside.status, 403);
  assert.equal((await RS.POST(new Request("http://localhost:3210/api/brains/sign-in", { method: "POST", body: JSON.stringify({ brainId: planId, botId: "otto" }) }))).status, 403);
  assert.equal((await RB.POST(new Request("http://localhost:3210/api/brains/bot", { method: "POST", body: "{}" }))).status, 403);
  const add = await R.POST(fromWindow("/api/brains", { kind: "codex", auth: "key", bots: ["boppy"], use: true }));
  const { brain: cx } = await add.json();
  assert.equal(cx.name, "Codex");
  assert.equal(bot("boppy").brain, cx.id);
  assert.equal((await R.POST(fromWindow("/api/brains", { kind: "codex", auth: "plan" }))).status, 400);
  assert.deepEqual((await (await R.GET(fromWindow("/api/brains", undefined, "GET"))).json()).brains.map((x) => x.id), [planId, cx.id]);
  assert.equal((await (await R.PATCH(fromWindow("/api/brains", { id: cx.id, name: "Codex (work)" }, "PATCH"))).json()).brain.name, "Codex (work)");
  assert.equal((await R.PATCH(fromWindow("/api/brains", { id: cx.id, botId: "otto", level: "sure" }, "PATCH"))).status, 400);
  await R.PATCH(fromWindow("/api/brains", { id: cx.id, botId: "otto", level: "may" }, "PATCH"));
  assert.ok(brain(cx.id).bots.includes("otto"));
  assert.equal((await RB.POST(fromWindow("/api/brains/bot", { botId: "otto", brainId: cx.id }))).status, 200);
  assert.equal(bot("otto").brain, cx.id);
  assert.equal((await RB.POST(fromWindow("/api/brains/bot", { botId: "rook", brainId: cx.id }))).status, 400, "not on it");
  await RB.POST(fromWindow("/api/brains/bot", { botId: "otto", brainId: planId }));
  // Sign in through the route: the screen comes back at once.
  const started = await (await RS.POST(fromWindow("/api/brains/sign-in", { brainId: planId, botId: "otto" }))).json();
  assert.deepEqual({ botId: started.botId, display: started.display }, { botId: "otto", display: 100 });
  await until("the sign-in to finish", () => T.signInOn(brain(planId), "pc-main"));
  const now = await (await RS.GET(fromWindow(`/api/brains/sign-in?brain=${planId}&bot=otto`, undefined, "GET"))).json();
  assert.deepEqual(now, { loggedIn: true, method: "claude.ai", account: { email: "maya@acme.test", orgName: "Acme", plan: "max" } });
  assert.equal((await RS.GET(fromWindow(`/api/brains/sign-in?brain=${cx.id}&bot=otto`, undefined, "GET"))).status, 400, "a key brain doesn't sign in");
  assert.equal((await RS.DELETE(fromWindow("/api/brains/sign-in", { brainId: planId }, "DELETE"))).status, 200);
  assert.equal((await RO.POST(fromWindow("/api/brains/sign-out", { brainId: planId, botId: "otto" }))).status, 200);
  assert.equal(T.signInOn(brain(planId), "pc-main"), undefined);
  // Removing one: its bots back on Bops agent.
  assert.equal((await R.DELETE(fromWindow("/api/brains", { id: cx.id }, "DELETE"))).status, 200);
  assert.equal(brain(cx.id), undefined);
  assert.equal(bot("boppy").brain, undefined);
});

await test("removing a plan brain signs it out and deletes its folder on the computers it was on", async () => {
  await B.startSignIn(planId, "otto");
  await until("the sign-in to finish", () => T.signInOn(brain(planId), "pc-main"));
  assert.ok(existsSync(join(pc("pc-main").brains, planId)));
  const x = B.addBrain({ kind: "claude", auth: "plan", bots: ["otto"] });
  B.removeBrain(planId);
  assert.equal(bot("otto").brain, undefined);
  assert.equal(bot("rook").brain, undefined);
  await until("its folder to go", () => !existsSync(join(pc("pc-main").brains, planId)));
  assert.ok(pc("pc-main").commands.includes(`bops-brain cancel ${planId}; bops-brain forget ${planId}`));
  planId = x.id;
});

/* ---------------- Real Claude Code on this Mac (REAL_CLAUDE=1 only) ---------------- */

if (REAL_CLAUDE)
  await test("this Mac's own Claude Code says an empty brain folder isn't signed in, as Bops reads it", async () => {
    const real = execFileSync("/bin/bash", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
    const brains = join(scratch, "real-brains");
    mkdirSync(join(brains, "brain_real"), { recursive: true });
    writeFileSync(join(brains, "brain_real", ".computer"), "this-mac");
    const out = await new Promise((resolve) =>
      execFile(join(root, "vm/bin/bops-brain"), ["status", "brain_real", "this-mac"], { env: { PATH: process.env.PATH, BOPS_BRAINS: brains, BOPS_CLAUDE: real, BOPS_HOME: process.env.HOME, ...PLANTED } }, (_e, so, se) => resolve(`${so}${se}`)),
    );
    assert.deepEqual(B.parseStatus(out), { loggedIn: false });
  });

/* ---------------- The window: Settings, Brain, and a bot's Brain ---------------- */

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { BrainSettings, BotBrain, AddBrain, brainLine } = await import(fileUrl("components/app/brains.tsx"));
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};
const view = (brains, extra = {}) => ({ ...structuredClone(S.getState()), brains, ...extra });
const withBrain = (st, botId, brainId) => ({ ...st, bots: st.bots.map((b) => (b.id === botId ? { ...b, brain: brainId } : b)) });
const BRAINS = [
  { id: "b_max", kind: "claude", name: "Claude Code", auth: "plan", bots: ["otto", "rook"], workspaceId: "ws_main", createdAt: 1, signIns: [{ computerId: "pc-main", at: 1, method: "claude.ai", account: { email: "maya@acme.test", orgName: "Acme", plan: "max" } }] },
  { id: "b_new", kind: "claude", name: "Claude Code (work)", auth: "plan", bots: [], workspaceId: "ws_main", createdAt: 2 },
  { id: "b_key", kind: "claude", name: "Claude Code 2", auth: "key", keyName: "ANTHROPIC_API_KEY", keyScope: "all", bots: ["boppy"], workspaceId: "ws_main", createdAt: 3 },
  { id: "b_going", kind: "claude", name: "Claude Code 3", auth: "plan", bots: ["rook"], workspaceId: "ws_main", createdAt: 4, signingIn: { botId: "rook", computerId: "pc-rook", display: 102, at: 5 } },
  { id: "b_other", kind: "codex", name: "Codex elsewhere", auth: "key", keyName: "OPENAI_API_KEY", bots: [], workspaceId: "ws_two", createdAt: 5 },
];

await test("Settings, Brain: Bops agent first with its bots, then each brain and how it signs in", () => {
  const html = renderToStaticMarkup(h(BrainSettings, { state: withBrain(view(BRAINS), "otto", "b_max"), onShowScreen: noop, onOpenVault: noop }));
  const t = text(html);
  noDashes(t, "Settings, Brain");
  assert.match(t, /^Brain What your bots work with\. Bops agent runs on AI credit\. Claude Code and Codex run on your own plan or key\. Add a brain/);
  assert.match(t, /Bops agent AI credit Boppy Rook Claude Code/, "Bops agent's bots: those on no brain");
  assert.match(t, /Claude Code Max plan · signed in on Boppy's computer Sign in on Rook's computer/, "Rook's own computer isn't signed in");
  assert.match(t, /Otto .*Rook not picked/);
  assert.match(t, /Sign out on Boppy's computer/);
  assert.match(t, /Claude Code \(work\) Not signed in/);
  assert.match(t, /No bot can use it/);
  assert.match(t, /Claude Code 2 Key: ANTHROPIC_API_KEY/);
  assert.match(t, /Claude Code 3 Signing in on Rook's computer Show Cancel/);
  assert.doesNotMatch(t, /Codex elsewhere/, "another workspace's brain isn't here");
  assert.match(html, /data-tip="maya@acme.test, Acme"/, "whose account, on hover");
  assert.match(html, /aria-label="Rename"/);
  assert.match(html, /aria-label="Remove"/);
  assert.equal(brainLine(view(BRAINS), BRAINS[2], []), "Key: ANTHROPIC_API_KEY · not in your Vault");
  assert.equal(brainLine(view(BRAINS), { ...BRAINS[1], signingIn: { botId: "rook", computerId: "pc-rook", display: 100, at: 1, failed: "it took too long." } }), "Sign-in didn't finish");
  // A plan per computer, when they differ; one, when they agree; never a computer no bot has now.
  assert.equal(brainLine(view(BRAINS), { ...BRAINS[0], signIns: [...BRAINS[0].signIns, { computerId: "pc-rook", at: 2, account: { plan: "pro" } }] }), "Max plan on Boppy's computer, Pro plan on Rook's computer");
  assert.equal(brainLine(view(BRAINS), { ...BRAINS[0], signIns: [...BRAINS[0].signIns, { computerId: "pc-rook", at: 2, account: { plan: "max" } }] }), "Max plan · signed in on Boppy's and Rook's computers");
  assert.equal(brainLine(view(BRAINS), { ...BRAINS[0], signIns: [{ computerId: "pc-gone", at: 0, account: { plan: "pro" } }, ...BRAINS[0].signIns] }), "Max plan · signed in on Boppy's computer");
});

await test("adding a brain asks how it signs in, in Claude Code's own words, even with a key saved; Codex takes a key", () => {
  const st = view([]);
  const first = text(renderToStaticMarkup(h(AddBrain, { state: st, keys: [], onShowScreen: noop, onOpenVault: noop, onDone: noop })));
  noDashes(first, "Add a brain");
  assert.match(first, /^Which one\? Claude Code Anthropic's coding agent Codex OpenAI's coding agent Cancel$/);
  const claudeHtml = renderToStaticMarkup(h(AddBrain, { state: st, keys: [{ name: "ANTHROPIC_API_KEY", scope: "all" }], kind: "claude", onShowScreen: noop, onOpenVault: noop, onDone: noop }));
  const claude = text(claudeHtml);
  noDashes(claude, "Add Claude Code");
  assert.match(claude, /How should it sign in\? You have an Anthropic key saved\. Use it, or sign in with your Claude plan\? Claude account with subscription Pro, Max, Team, or Enterprise\. .* Anthropic API key /);
  assert.equal((claudeHtml.match(/aria-pressed="true"/g) ?? []).length, 1, "only Claude Code is picked, not a way to sign in");
  const codex = text(renderToStaticMarkup(h(AddBrain, { state: st, keys: [], kind: "codex", onShowScreen: noop, onOpenVault: noop, onDone: noop })));
  noDashes(codex, "Add Codex");
  assert.match(codex, /How should it sign in\? OpenAI API key Your key from the Vault\. Usage is billed to your OpenAI account\. Add your OpenAI key in the Vault first\. Only Codex on the bot's computer gets it\. Open the Vault Bots that use it Boppy Otto Rook Add/);
  assert.doesNotMatch(codex, /Claude plan/);
});

await test("a bot's Brain: Bops agent or the brains it's on, and Sign in where its plan brain isn't signed in", () => {
  const none = renderToStaticMarkup(h(BotBrain, { state: view([]), bot: bot("otto"), onShowScreen: noop, className: "" }));
  assert.equal(none, "", "no brain has it: nothing");
  const signed = text(renderToStaticMarkup(h(BotBrain, { state: withBrain(view(BRAINS), "otto", "b_max"), bot: { ...bot("otto"), brain: "b_max" }, onShowScreen: noop, className: "" })));
  noDashes(signed, "a bot's Brain");
  assert.equal(signed, "Brain Claude Code on your Max plan Bops agent Claude Code");
  const notHere = text(renderToStaticMarkup(h(BotBrain, { state: withBrain(view(BRAINS), "rook", "b_max"), bot: { ...bot("rook"), brain: "b_max" }, onShowScreen: noop, className: "" })));
  noDashes(notHere, "a bot's Brain, not signed in");
  assert.match(notHere, /^Brain Not signed in on Rook's computer Bops agent Claude Code Claude Code 3 Sign in with your Claude plan on Rook's computer to use it\. Sign in$/);
  const agent = text(renderToStaticMarkup(h(BotBrain, { state: view(BRAINS), bot: bot("boppy"), onShowScreen: noop, className: "" })));
  assert.equal(agent, "Brain Bops agent, on AI credit Bops agent Claude Code 2");
  const key = text(renderToStaticMarkup(h(BotBrain, { state: withBrain(view(BRAINS), "boppy", "b_key"), bot: { ...bot("boppy"), brain: "b_key" }, onShowScreen: noop, className: "" })));
  assert.equal(key, "Brain Claude Code on your Anthropic key Bops agent Claude Code 2");
  // A sign-in going on Rook's computer: Otto, signed in on Boppy's, still says so, with no Show of Rook's screen.
  const going = BRAINS.map((x) => (x.id === "b_max" ? { ...x, signingIn: { botId: "rook", computerId: "pc-rook", display: 102, at: 5 } } : x));
  const otto = text(renderToStaticMarkup(h(BotBrain, { state: withBrain(view(going), "otto", "b_max"), bot: { ...bot("otto"), brain: "b_max" }, onShowScreen: noop, className: "" })));
  assert.equal(otto, "Brain Claude Code on your Max plan Bops agent Claude Code");
  const rook = text(renderToStaticMarkup(h(BotBrain, { state: withBrain(view(going), "rook", "b_max"), bot: { ...bot("rook"), brain: "b_max" }, onShowScreen: noop, className: "" })));
  assert.match(rook, /^Brain Signing in on Rook's computer .* Claude Code's sign-in is open on its screen\. Show$/);
  // Its tasks on this Mac run on Bops agent, on AI credit, whatever its brain: it says so.
  const onMac = text(renderToStaticMarkup(h(BotBrain, { state: { ...withBrain(view(BRAINS), "boppy", "b_key"), host: "mac" }, bot: { ...bot("boppy"), brain: "b_key" }, onShowScreen: noop, className: "" })));
  assert.equal(onMac, "Brain Your bots work on this Mac, so they run on Bops agent, on AI credit Bops agent Claude Code 2");
  const macBot = text(renderToStaticMarkup(h(BotBrain, { state: withBrain(view(BRAINS), "rook", "b_max"), bot: { ...bot("rook"), brain: "b_max", runsOn: "mac" }, onShowScreen: noop, className: "" })));
  assert.match(macBot, /^Brain Rook works on your Mac, so its tasks run on Bops agent, on AI credit Bops agent Claude Code Claude Code 3$/, macBot);
  const some = text(renderToStaticMarkup(h(BotBrain, { state: { ...withBrain(view(BRAINS), "boppy", "b_key"), mac: { ready: true } }, bot: { ...bot("boppy"), brain: "b_key", runsOn: "auto" }, onShowScreen: noop, className: "" })));
  assert.equal(some, "Brain Claude Code on your Anthropic key · tasks on your Mac run on Bops agent Bops agent Claude Code 2");
  noDashes(onMac + macBot + some, "a bot's Brain on the Mac");
});

await test("a thread says which brain ran it; one Claude Code ran opens in a terminal on its screen, which says where and that a reply closes it", async () => {
  const { ThreadSheet, ChatView } = await import(fileUrl("components/app/chat-view.tsx"));
  const thread = (id, more = {}) => ({
    id,
    botId: "otto",
    chatId: "bot:otto",
    sentVia: "you",
    title: "Cart total",
    goal: "Fix the cart total",
    host: "orgo",
    status: "done",
    steps: [{ tool: "command", detail: "ran npm test", at: 2 }],
    replies: [],
    answer: "Fixed.",
    createdAt: 1,
    startedAt: 1,
    endedAt: 3,
    lastDisplay: 101,
    brainRun: { brainId: "b_max", kind: "claude", computerId: "pc-main", cli: "0f6c3d2e-1111-4a2b-9c3d-123456789abc", started: true },
    ...more,
  });
  const st = (sessions, more = {}) => ({ ...withBrain(view(BRAINS), "otto", "b_max"), sessions, messages: [], ...more });
  const sheetHtml = (s, more) => renderToStaticMarkup(h(ThreadSheet, { state: st([s], more), session: s, onClose: noop, onShowComputer: noop, onShowScreen: noop }));
  const sheet = (s, more) => text(sheetHtml(s, more));
  const no = T.DISPLAYS.indexOf(101) + 1;
  // Claude Code ran it: its name by the title, and Open in terminal.
  const done = sheet(thread("ses_a"));
  noDashes(done, "a Claude Code thread");
  assert.match(done, new RegExp(`^Cart total Claude Code Otto · finished · 1 steps · left off on screen ${no} Open in terminal Delete `), done);
  // Open in the terminal there: it says so, with Show, and a reply closes it.
  const open = { botId: "otto", display: 101, sessionId: "ses_a", since: 5, terminal: {} };
  const html = sheetHtml(thread("ses_a"), { takeover: open });
  const inTerminal = text(html);
  noDashes(inTerminal, "a thread open in the terminal");
  assert.match(inTerminal, /^Cart total Claude Code Otto · in the terminal · /);
  assert.match(inTerminal, new RegExp(`Open in the terminal on screen ${no}\\. Your next reply closes it, and it carries on here\\. Show`));
  assert.doesNotMatch(inTerminal, /Open in terminal/, "it's open already");
  assert.match(html, /Reply in thread · closes the terminal and carries on/);
  // Paused as it worked: the terminal, not why it stopped.
  const paused = sheet(thread("ses_a", { status: "failed", error: "Paused while it's open in the terminal" }), { takeover: { ...open, terminal: { paused: true } } });
  assert.doesNotMatch(paused, /Paused while/);
  assert.equal(A.needsYou(thread("ses_a", { status: "failed", error: "Paused while it's open in the terminal" })), false, "paused, not waiting on the user");
  // A terminal for another thread isn't this one's.
  assert.match(sheet(thread("ses_a"), { takeover: { ...open, sessionId: "ses_b" } }), /Open in terminal/);
  // Bops agent finished it, Codex ran it, Bops agent ran it, or the bots work on this Mac: no terminal.
  // Bops agent finishes it while Otto is on Claude Code: it says so, as it's on AI credit.
  const finished = sheet(thread("ses_a", { onBopsAgent: true }));
  assert.match(finished, /^Cart total Bops agent Otto/, finished);
  assert.doesNotMatch(finished, /Open in terminal|Claude Code/);
  // So does one Bops agent took over (its response chain) or began, and Otto off Claude Code has no terminal.
  assert.match(sheet(thread("ses_a", { responseId: "resp_1" })), /^Cart total Bops agent Otto/);
  assert.match(sheet(thread("ses_e", { brainRun: undefined, agentSessionId: "sesn_1" })), /^Cart total Bops agent Otto/);
  assert.match(sheet(thread("ses_e", { brainRun: undefined, agentSessionId: "sesn_1" }), { bots: view(BRAINS).bots }), /^Cart total Otto · finished/, "no badge when Otto isn't on a brain");
  assert.doesNotMatch(sheet(thread("ses_a"), { bots: view(BRAINS).bots }), /Open in terminal/, "Otto doesn't use Claude Code now");
  const codexHtml = sheetHtml(thread("ses_c", { status: "running", display: 101, brainRun: { brainId: "b_codex", kind: "codex", computerId: "pc-main", cli: "019a0000-1111-7a2b-9c3d-123456789abc", started: true } }));
  const codex = text(codexHtml);
  assert.match(codex, /^Cart total Codex Otto · working · /);
  assert.doesNotMatch(codex, /Open in terminal|Claude Code/);
  assert.match(codexHtml, /Reply in thread · it takes this next/, "a reply waits for its next turn");
  assert.match(sheet(thread("ses_d", { brainRun: undefined })), /^Cart total Otto · finished/, "Bops agent's has no badge");
  assert.doesNotMatch(sheet(thread("ses_a"), { host: "mac" }), /Open in terminal/);
  // Its chip in the chat says so too.
  const s = thread("ses_a");
  const chat = { id: "bot:otto", kind: "bot", botIds: ["otto"], createdAt: 1, typing: [] };
  const msg = { id: "msg_1", chatId: "bot:otto", role: "bot", botId: "otto", text: "Fixed.", at: 3, sessionIds: [s.id], resultOf: s.id };
  const chip = text(renderToStaticMarkup(h(ChatView, { state: st([s], { messages: [msg], chats: [chat] }), chat, wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop })));
  assert.match(chip, /Cart total Claude Code/, chip);
});

await test("a bot's profile says which brain its tasks run on, by its role", async () => {
  const { BotPanel } = await import(fileUrl("components/app/bot-panel.tsx"));
  const panel = (st, b, section = "details") =>
    text(
      renderToStaticMarkup(
        h(BotPanel, { state: st, bot: b, section, onSection: noop, onOpenChat: noop, onOpenThread: noop, onOpenVault: noop, onOpenComputer: noop, onOpenKeys: noop, onShowScreen: noop, onOpenAutopilot: noop, onOpenSkills: noop, onAsk: noop, onUpgrade: noop, onClose: noop }),
      ),
    );
  const st = withBrain(view(BRAINS), "otto", "b_max");
  const otto = st.bots.find((b) => b.id === "otto");
  assert.match(panel(st, otto), /Otto Outbound · Bops team Claude Code /);
  assert.match(panel(st, otto, "skills"), /Otto Outbound · Bops team Claude Code /, "on its other tabs too");
  const codexSt = { ...view([...BRAINS, { id: "b_codex", kind: "codex", name: "Codex", auth: "key", keyName: "OPENAI_API_KEY", keyScope: "all", bots: ["rook"], workspaceId: "ws_main", createdAt: 6 }]) };
  const rook = { ...codexSt.bots.find((b) => b.id === "rook"), brain: "b_codex" };
  assert.match(panel({ ...codexSt, bots: codexSt.bots.map((b) => (b.id === "rook" ? rook : b)) }, rook), /Rook Recruiting · Bops team Codex /);
  const agent = view(BRAINS);
  assert.doesNotMatch(panel(agent, agent.bots.find((b) => b.id === "otto")), /Bops team (Claude Code|Codex)/, "Bops agent: none");
  assert.doesNotMatch(panel({ ...st, host: "mac" }, otto), /Bops team Claude Code/, "on this Mac its tasks run on Bops agent");
  assert.doesNotMatch(panel(st, { ...otto, runsOn: "mac" }), /Bops team Claude Code/, "nor for a bot that works on the user's Mac");
});

await test("the brain files have no long dashes in what they say", () => {
  for (const f of ["components/app/brains.tsx", "lib/server/brains.ts", "lib/server/cli-agents.ts", "vm/bin/bops-brain", "vm/bin/bops-brain-browser", "vm/bin/bops-agent", "app/api/brains/route.ts", "app/api/brains/bot/route.ts", "app/api/brains/sign-in/route.ts", "app/api/brains/sign-out/route.ts", "app/api/sessions/[sessionId]/terminal/route.ts"])
    noDashes(readFileSync(join(root, f), "utf8"), f);
});

// Fake sign-ins still waiting stop before their folder goes.
writeFileSync(STOP, "");
await new Promise((r) => setTimeout(r, 300));
console.log(`\n${passed} passed`);
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
