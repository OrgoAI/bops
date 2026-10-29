// Each bot's own settings on a computer (vm/bin/bops-brain, bops-agent, bops-ai-gate, bops-exec): several bots
// on one computer, each running several agents at once, and every process each thread starts sees only its own
// bot's and agent's settings. A Claude plan thread has its account's folder and model and no key; a key thread
// has a run token and a 127.0.0.1 gate, never the key; claude, codex, opencode and agy in a thread are that
// bot's own wrappers (or stubs that say why not); nothing is written to a shared place (/root/.bashrc,
// /etc/environment, ~/.claude, ~/.codex, OpenCode's or Gemini's own folders); switching an agent clears its
// folder and stops its gate; and a bot on the default (no profile) runs exactly as before.
//
// The computer is a throwaway folder here: the real scripts, as Bops installs them, with fake claude, codex
// and opencode that write down what they were run with (their environment, what claude, codex, opencode and
// agy resolve to, a nested call of each, and what their base address answers), a fake provider on 127.0.0.1
// behind the gate, and a fake terminal. No real CLI, provider or key is used: the keys are planted fakes.
//
// Usage: node scripts/test-bot-env.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-bot-env-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const v = check();
    if (v) return v;
  }
  throw new Error(`timed out: ${what}`);
}

/* ---------------- The computer ---------------- */

const ROOT = join(scratch, "pc");
const d = {
  bin: join(ROOT, "usr-local-bin"),
  home: join(ROOT, "root"),
  bops: join(ROOT, "root/.bops"),
  brains: join(ROOT, "root/.bops/brains"),
  bots: join(ROOT, "root/.bops/bots"),
  agents: join(ROOT, "root/.bops/agents"),
  work: join(ROOT, "workspace"),
  logs: join(ROOT, "logs"),
  opt: join(ROOT, "opt"),
  etc: join(ROOT, "etc"),
  rec: join(scratch, "rec"),
  fakebin: join(scratch, "fakebin"),
};
for (const p of Object.values(d)) mkdirSync(p, { recursive: true });
// What Bops installs on a computer (brains.ts BRAIN_TOOLS), copied as it is.
for (const f of ["bops-brain", "bops-agent", "bops-ai-gate", "bops-exec"]) copyFileSync(join(repo, "vm/bin", f), join(d.bin, f));
for (const f of readdirSync(d.bin)) chmodSync(join(d.bin, f), 0o755);
// The computer's own /root/.bashrc reads /root/.env, where Orgo keeps the computer's key: a bot's shell never sources it.
// (Bash reads it for a command whose input is a socket, as this test's own commands are: those name no bot.)
const BASHRC = `echo "BASHRC_WAS_READ bot=\${BOPS_BOT:-}" >> ${join(d.rec, "bashrc-hits")}\n`;
const bashrcRead = () => existsSync(join(d.rec, "bashrc-hits")) && /bot=\S/.test(readFileSync(join(d.rec, "bashrc-hits"), "utf8"));
writeFileSync(join(d.home, ".bashrc"), BASHRC);

/** The planted keys: the Vault's, as Bops would reveal them, and the executor's. They must never show up anywhere on the computer. */
const KEYS = { anthropic: "sk-ant-test-PLANTED-anthropic-key-0001", openai: "sk-test-PLANTED-openai-key-0002", exec: "sk-test-PLANTED-executor-0003" };

/* A fake CLI: writes down what it was run with, then acts as the CLI does in a thread. */
const FAKE = `#!/bin/bash
NAME="$1"; shift
REC=${JSON.stringify(d.rec)}
nested=0; for a in "$@"; do [ "$a" = --nested ] && nested=1; done
f="$REC/$NAME.\${BOPS_BOT:-none}.\${BOPS_AGENT:-none}.$([ $nested = 1 ] && echo nested || echo top).$$"
{
  echo "@ARGS"; printf '%s\\n' "$@"
  echo "@ENV"; env | LC_ALL=C sort
  echo "@WHICH"; for c in claude codex opencode agy; do echo "$c=$(command -v $c || echo none)"; done
} > "$f"
[ $nested = 1 ] && exit 0
if [ "$1" = exec-server ]; then echo "@END" >> "$f"; exit 0; fi
{
  echo "@NESTED"
  export BOPS_TEST_PARENT=$$
  for c in claude codex opencode agy; do out="$($c --nested 2>&1)"; echo "$c=$?|$(echo "$out" | head -1)"; done
  echo "@PROBE"
  probe() { echo "$1=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' -m 5 "\${@:2}" 2>/dev/null)"; }
  if [ -n "\${BOPS_GATE:-}" ]; then
    case "$NAME" in
      claude) U="$ANTHROPIC_BASE_URL"; probe good -H "x-api-key: $ANTHROPIC_API_KEY" -d '{}' "$U/v1/messages"; probe notoken -d '{}' "$U/v1/probe-notoken"; probe wrong -H "x-api-key: bopsrun_wrong" -d '{}' "$U/v1/probe-wrong"; probe route -H "x-api-key: $ANTHROPIC_API_KEY" -d '{}' "$BOPS_GATE/openai/v1/probe-route"; probe notv1 -H "x-api-key: $ANTHROPIC_API_KEY" "$BOPS_GATE/anthropic/probe-notv1" ;; # gitleaks:allow (fake key: bopsrun_wrong)
      codex) probe good -H "Authorization: Bearer $OPENAI_API_KEY" -d '{}' "$OPENAI_BASE_URL/responses" ;;
      opencode) probe good -H "x-api-key: $ANTHROPIC_API_KEY" -d '{}' "$ANTHROPIC_BASE_URL/v1/messages" ;;
    esac
  fi
  echo "@END"
} >> "$f"
case "$NAME" in
  claude)
    # -p --input-format stream-json: a result per message, until its input ends.
    for a in "$@"; do [ "$a" = -p ] && headless=1; done
    if [ -z "\${headless:-}" ]; then echo "claude closes"; exit 0; fi
    while IFS= read -r line; do [ -n "$line" ] && echo '{"type":"result","subtype":"success","is_error":false,"result":"done"}'; done
    ;;
  codex)
    cat > /dev/null
    echo '{"type":"thread.started","thread_id":"0b7c2f9e-1d2a-4c3b-9e8f-112233445566"}'
    echo '{"type":"turn.completed"}'
    ;;
  opencode)
    if [ "$1" != run ]; then echo "opencode closes"; exit 0; fi
    cat > /dev/null
    echo '{"type":"text","sessionID":"ses_x","part":{"type":"text","text":"done"}}'
    ;;
esac
sleep 0.3
`;
writeFileSync(join(d.fakebin, "fake-cli"), FAKE, { mode: 0o755 });
for (const n of ["claude", "codex", "opencode"]) writeFileSync(join(d.opt, n), `#!/bin/bash\nexec ${join(d.fakebin, "fake-cli")} ${n} "$@"\n`, { mode: 0o755 });
writeFileSync(join(d.fakebin, "setsid"), `#!/bin/bash\nexec "$@"\n`, { mode: 0o755 });
// The terminal: runs what it was given after -x (or -e), its input the user's typing: here, a script.
const TYPED = join(scratch, "typed");
writeFileSync(join(d.fakebin, "xterm"), `#!/bin/bash\nwhile [ $# -gt 0 ] && [ "$1" != -x ] && [ "$1" != -e ]; do shift; done\nshift\nexec "$@" < ${JSON.stringify(TYPED)}\n`, { mode: 0o755 });

/* The provider behind the gate: what it got, by path. */
const got = [];
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    got.push({ path: req.url, headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;

/** A command on the computer, as Orgo's bash runs it there (with the test's paths for /root and its tools). */
const ENV = {
  PATH: `${d.bin}:${d.fakebin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: d.home,
  BOPS_BRAINS: d.brains,
  BOPS_BOTS: d.bots,
  BOPS_AGENTS: d.agents,
  BOPS_WORKSPACE: d.work,
  BOPS_HOME: d.home,
  BOPS_LOGS: d.logs,
  BOPS_CLAUDE: join(d.opt, "claude"),
  BOPS_CODEX: join(d.opt, "codex"),
  BOPS_OPENCODE: join(d.opt, "opencode"),
  BOPS_EXEC_ROOT: d.bops,
  BOPS_TERMINAL: join(d.fakebin, "xterm"),
  BOPS_GATE_TEST: "1",
  BOPS_GATE_UPSTREAM: UPSTREAM,
  // What a computer's environment may have that no bot's agent may get.
  ANTHROPIC_API_KEY: "sk-ant-test-PLANTED-ambient",
  OPENAI_API_KEY: "sk-test-PLANTED-ambient",
  CLAUDE_CONFIG_DIR: "/planted/claude",
  CODEX_HOME: "/planted/codex",
};
const sh = (command, input) =>
  new Promise((resolve) => {
    const p = execFile("/bin/bash", ["-c", command], { env: ENV, cwd: scratch, timeout: 60_000 }, (err, stdout, stderr) => resolve({ out: `${stdout}${stderr}`, code: err ? (typeof err.code === "number" ? err.code : 1) : 0 }));
    if (input !== undefined) p.stdin.end(input);
  });
const ok = async (command, input) => {
  const r = await sh(command, input);
  assert.equal(r.code, 0, `${command}\n${r.out}`);
  return r.out;
};

/* ---------------- What the fakes wrote down ---------------- */

function parse(file) {
  const out = { file, args: [], env: {}, which: {}, nested: {}, probe: {} };
  let at = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("@")) {
      at = line.slice(1);
      continue;
    }
    if (!line && at !== "ARGS") continue;
    if (at === "ARGS") out.args.push(line);
    else {
      const i = line.indexOf("=");
      if (i < 0) continue;
      const k = line.slice(0, i), v = line.slice(i + 1);
      if (at === "ENV") out.env[k] = v;
      else if (at === "WHICH") out.which[k] = v;
      else if (at === "NESTED") out.nested[k] = { code: Number(v.split("|")[0]), said: v.slice(v.indexOf("|") + 1) };
      else if (at === "PROBE") out.probe[k] = v;
    }
  }
  if (out.args.at(-1) === "") out.args.pop();
  return out;
}
// Oldest first, by when each was written (not by name: a pid with more digits sorts before one with fewer).
const records = (name, bot, agent, kind = "top") =>
  readdirSync(d.rec)
    .filter((f) => f.startsWith(`${name}.${bot}.${agent}.${kind}.`))
    .map((f) => parse(join(d.rec, f)))
    .sort((x, y) => statSync(x.file).mtimeMs - statSync(y.file).mtimeMs);
const one = async (name, bot, agent, kind = "top", n = 1) => {
  // A record whose last part (its probes) is written.
  const all = await until(() => {
    const r = records(name, bot, agent, kind).filter((x) => kind === "nested" || readFileSync(x.file, "utf8").includes("@END"));
    return r.length >= n ? r : null;
  }, `${name} for ${bot}/${agent}`);
  return all.at(-1);
};

/* ---------------- The bots ---------------- */

// Sam: Claude Code on a Claude plan (account brain_x, Opus 5.5) and Codex on its OpenAI key (account brain_y).
// Rook: OpenCode on an Anthropic key (Sonnet 5.5) and Claude Code on its Anthropic key (account brain_z).
// Boppy: no profile. All on one computer.
const SAM_ALSO = "claude:plan:brain_x:claude-opus-5-5,codex:key:brain_y:gpt-6.1-sol";
const ROOK_ALSO = "opencode:key:-:anthropic/claude-sonnet-5-5,claude:key:brain_z:claude-sonnet-5-5";
const threads = {
  samClaude: { id: "s_samclaude", brain: "brain_x", kind: "claude", session: "11111111-1111-4111-8111-111111111111", prof: `--bot sam --agent ag_samclaude1 --model claude-opus-5-5 --also ${SAM_ALSO} --label sam` },
  samCodex: { id: "s_samcodex", brain: "brain_y", kind: "codex", session: "22222222-2222-4222-8222-222222222222", key: KEYS.openai, prof: `--bot sam --agent ag_samcodex01 --model gpt-6.1-sol --effort high --route openai --also ${SAM_ALSO} --label sam` },
  rookOc: { id: "s_rookoc", brain: "-", kind: "opencode", session: "ses_rookThread0001", key: KEYS.anthropic, prof: `--bot rook --agent ag_rookopenc1 --model anthropic/claude-sonnet-5-5 --route anthropic --also ${ROOK_ALSO} --label rook` },
  rookClaude: { id: "s_rookclaude", brain: "brain_z", kind: "claude", session: "33333333-3333-4333-8333-333333333333", key: KEYS.anthropic, prof: `--bot rook --agent ag_rookclaud1 --model claude-sonnet-5-5 --route anthropic --also ${ROOK_ALSO} --label rook` },
};
const MCP = JSON.stringify({ mcpServers: { screen: { type: "stdio", command: "/bin/echo", args: ["screen"], env: { DISPLAY: ":3" } } } });
async function start(t, display) {
  await ok(`bops-agent put ${t.id} mcp.json`, MCP);
  await ok(`bops-agent put ${t.id} prompt.md`, "You are a bot for Bops.");
  if (t.key) await ok(`bops-agent put ${t.id} key`, t.key);
  const out = await ok(`bops-agent start ${t.id} ${t.brain} ${t.kind} ${display} pc_1 ${t.session} ${t.prof}`);
  assert.match(out, /started (fresh|resumed)/);
  // The key's file is gone as soon as the run has it.
  await until(() => !existsSync(join(d.agents, t.id, "key")) && !existsSync(join(d.agents, t.id, "key.run")), `${t.id}'s key file gone`);
}
const send = (t, text) => ok(`bops-agent send ${t.id}`, t.kind === "claude" ? `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n` : `${JSON.stringify({ text })}\n`);

try {
  // 1. Many at once: four threads of two bots on four agents start together.
  await Promise.all([start(threads.samClaude, 1), start(threads.samCodex, 2), start(threads.rookOc, 3), start(threads.rookClaude, 4)]);
  await Promise.all(Object.values(threads).map((t) => send(t, "Do the thing.")));
  const sc = await one("claude", "sam", "ag_samclaude1");
  const sx = await one("codex", "sam", "ag_samcodex01");
  const ro = await one("opencode", "rook", "ag_rookopenc1");
  const rc = await one("claude", "rook", "ag_rookclaud1");
  console.log("ok many at once: two bots, four agents, four threads on one computer at the same time");

  const bin = (bot, agent) => join(d.bots, bot, "agents", agent, "bin");
  const none = (r, ...names) => {
    for (const n of names) assert.equal(r.env[n], undefined, `${r.file}: ${n}=${r.env[n]}`);
  };
  const onlyBot = (r, bot) => {
    assert.ok(r.env.PATH.startsWith(`${bin(bot, r.env.BOPS_AGENT)}:`), r.env.PATH);
    for (const other of ["sam", "rook", "boppy"].filter((x) => x !== bot)) assert.ok(!JSON.stringify(r.env).includes(`/bots/${other}/`), `${r.file} names ${other}`);
    assert.equal(r.env.BOPS_BOT, bot);
    assert.equal(r.env.HOME, d.home);
    assert.equal(r.env.TMPDIR, join(d.bots, bot, "tmp"));
    // Nothing from the computer's own environment.
    for (const [k, v] of Object.entries(r.env)) assert.ok(!/PLANTED-ambient|\/planted\//.test(v), `${r.file}: ${k} came from the computer's environment`);
  };

  // 2. Sam's Claude plan thread.
  assert.equal(sc.env.CLAUDE_CONFIG_DIR, join(d.brains, "brain_x"));
  assert.equal(sc.env.ANTHROPIC_MODEL, "claude-opus-5-5");
  assert.ok(sc.args.join(" ").includes("--model claude-opus-5-5"), sc.args.join(" "));
  none(sc, "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME", "CODEX_API_KEY", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "GEMINI_API_KEY", "BOPS_GATE", "OPENCODE_CONFIG");
  onlyBot(sc, "sam");
  assert.equal(sc.which.claude, join(bin("sam", "ag_samclaude1"), "claude"));
  assert.equal(sc.which.codex, join(bin("sam", "ag_samclaude1"), "codex"));
  const scNested = await one("claude", "sam", "ag_samclaude1", "nested");
  assert.equal(scNested.env.CLAUDE_CONFIG_DIR, join(d.brains, "brain_x"));
  assert.equal(scNested.env.ANTHROPIC_MODEL, "claude-opus-5-5");
  none(scNested, "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL");
  assert.equal(sc.nested.codex.code, 1);
  assert.match(sc.nested.codex.said, /Codex runs on this bot's key only in a thread with Codex/);
  assert.equal(sc.nested.opencode.code, 127);
  assert.match(sc.nested.opencode.said, /This bot doesn't run OpenCode/);
  assert.equal(sc.nested.agy.code, 127);
  assert.match(sc.nested.agy.said, /agy isn't in Bops yet/);
  console.log("ok Claude plan thread: its account's folder and model, no key, nested claude is the same, codex and opencode say why not");

  // 3. Sam's Codex thread.
  assert.equal(sx.env.CODEX_HOME, join(d.brains, "brain_y"));
  const sxArgs = sx.args.join(" ");
  assert.ok(sxArgs.startsWith("exec "), sxArgs);
  assert.match(sxArgs, /-c model="gpt-6\.1-sol"/);
  assert.match(sxArgs, /-c openai_base_url="http:\/\/127\.0\.0\.1:\d+\/openai\/v1"/);
  assert.match(sxArgs, /-c model_reasoning_effort="high"/);
  assert.match(sx.env.OPENAI_API_KEY, /^bopsrun_[0-9a-f]{64}$/);
  assert.equal(sx.env.CODEX_API_KEY, sx.env.OPENAI_API_KEY, "Codex itself gets the token too (its commands don't: config.toml)");
  assert.match(sx.env.OPENAI_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/openai\/v1$/);
  none(sx, "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "XDG_DATA_HOME");
  onlyBot(sx, "sam");
  const cfg = readFileSync(join(d.brains, "brain_y", "config.toml"), "utf8");
  assert.match(cfg, /ignore_default_excludes = true/);
  assert.match(cfg, /exclude = \["CODEX_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"\]/);
  assert.equal(sx.probe.good, "200");
  const sxNested = await one("codex", "sam", "ag_samcodex01", "nested");
  assert.equal(sxNested.env.CODEX_HOME, join(d.brains, "brain_y"));
  assert.match(sxNested.args.join(" "), /-c model="gpt-6\.1-sol" -c openai_base_url="http:\/\/127\.0\.0\.1:\d+\/openai\/v1"/);
  const sxClaude = await one("claude", "sam", "ag_samcodex01", "nested");
  assert.equal(sxClaude.env.CLAUDE_CONFIG_DIR, join(d.brains, "brain_x"), "a Claude plan works in any of Sam's threads");
  none(sxClaude, "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL");
  assert.equal(sx.nested.opencode.code, 127);
  console.log("ok Codex thread: its account's folder, model and gate on its command line, a token for its commands, nested claude on Sam's plan");

  // 4. Rook's OpenCode thread.
  const ocCfg = join(d.bots, "rook", "agents", "ag_rookopenc1", "opencode.json");
  assert.equal(ro.env.OPENCODE_CONFIG, ocCfg);
  assert.equal(statSync(ocCfg).mode & 0o777, 0o600);
  const ocBody = readFileSync(ocCfg, "utf8");
  assert.ok(!/sk-|bopsrun_/.test(ocBody), ocBody);
  assert.match(ocBody, /"baseURL": "\{env:BOPS_GATE\}\/anthropic\/v1"/);
  assert.ok(!/"model"|enabled_providers/.test(ocBody), "the agent's file picks no model or provider: its threads may run on two");
  const roRun = JSON.parse(ro.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual([roRun.model, roRun.enabled_providers, Object.keys(roRun.provider.anthropic.models)], ["anthropic/claude-sonnet-5-5", ["anthropic"], ["claude-sonnet-5-5"]]);
  assert.equal(roRun.provider.anthropic.options, undefined, "a provider's address only ever comes from the agent's file");
  for (const x of ["CONFIG", "DATA", "STATE", "CACHE"]) assert.equal(ro.env[`XDG_${x}_HOME`], join(d.bots, "rook", "opencode", x.toLowerCase()));
  assert.equal(ro.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(ro.env.OPENCODE_DISABLE_MODELS_FETCH, "1");
  assert.match(ro.env.ANTHROPIC_API_KEY, /^bopsrun_/);
  assert.match(ro.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/anthropic$/);
  assert.ok(JSON.parse(ro.env.OPENCODE_CONFIG_CONTENT).mcp.screen, "its MCP servers come per run");
  const roArgs = ro.args.join(" ");
  assert.match(roArgs, /^run --standalone --format json --auto --session ses_rookThread0001 --model anthropic\/claude-sonnet-5-5/);
  none(ro, "CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENAI_API_KEY");
  onlyBot(ro, "rook");
  assert.equal(ro.probe.good, "200");
  const roNested = await one("opencode", "rook", "ag_rookopenc1", "nested");
  assert.ok(roNested.args.includes("--standalone"), "a bare opencode runs on a private server");
  // Rook's claude in its OpenCode thread is the key stub: its Claude key isn't in this run.
  assert.equal(ro.nested.claude.code, 1);
  assert.match(ro.nested.claude.said, /Claude Code runs on this bot's key only in a thread with Claude Code/);
  console.log("ok OpenCode thread: its own config (no key in it), its own folders, a token for its provider, --standalone always");

  // 5. Rook's Claude key thread.
  assert.equal(rc.env.CLAUDE_CONFIG_DIR, join(d.brains, "brain_z"));
  assert.match(rc.env.ANTHROPIC_API_KEY, /^bopsrun_[0-9a-f]{64}$/);
  assert.notEqual(rc.env.ANTHROPIC_API_KEY, ro.env.ANTHROPIC_API_KEY, "each run its own token");
  assert.match(rc.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/anthropic$/);
  onlyBot(rc, "rook");
  for (const r of [ro, rc]) assert.ok(!JSON.stringify(r.env).includes("brain_x") && !JSON.stringify(r.env).includes("brain_y"), "Rook never sees Sam's accounts");
  const rcNested = await one("claude", "rook", "ag_rookclaud1", "nested");
  assert.equal(rcNested.env.CLAUDE_CONFIG_DIR, join(d.brains, "brain_z"));
  assert.equal(rcNested.env.ANTHROPIC_API_KEY, rc.env.ANTHROPIC_API_KEY);
  console.log("ok Claude key thread: a token and the gate, never the key; nested claude on its own account");

  // 5b. Claude Code's shell commands start from a snapshot of the login shell's: one whose /root/.bashrc put the
  // computer's own CLIs first on its PATH and made aliases of them. Its CLAUDE_ENV_FILE runs before each command,
  // so claude, codex, opencode and agy there are still the bot's own, on the plan and on a key.
  for (const [r, bot] of [
    [sc, "sam"],
    [rc, "rook"],
  ]) {
    const snap = join(scratch, `snapshot-${bot}.sh`);
    writeFileSync(
      snap,
      [
        `export PATH=${d.opt}:${r.env.PATH}`,
        "shopt -s expand_aliases",
        `alias claude=${join(d.opt, "claude")} codex=${join(d.opt, "codex")}`,
        `. ${r.env.CLAUDE_ENV_FILE} || echo "its env file failed"`,
        'for c in claude codex opencode agy; do echo "$c=$(command -v $c)"; done',
        "",
      ].join("\n"),
    );
    const found = Object.fromEntries(
      (await ok(`bash --noprofile --norc ${snap}`))
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    for (const c of ["claude", "codex", "opencode", "agy"]) assert.equal(found[c], join(bin(bot, r.env.BOPS_AGENT), c), `${bot}'s ${c} in Claude Code's shell: ${JSON.stringify(found)}`);
    rmSync(snap);
  }
  console.log("ok Claude Code's shell commands: claude, codex, opencode and agy are the bot's own, whatever /root/.bashrc put first");

  // 6. The gate: the token reaches the provider as the key; anything else is turned away before it.
  assert.equal(rc.probe.good, "200");
  assert.equal(rc.probe.notoken, "401");
  assert.equal(rc.probe.wrong, "401");
  assert.equal(rc.probe.route, "404");
  assert.equal(rc.probe.notv1, "404");
  assert.ok(!got.some((g) => g.path.includes("probe-")), "nothing turned away reached the provider");
  const toAnthropic = got.filter((g) => g.path === "/v1/messages");
  assert.ok(toAnthropic.length >= 2 && toAnthropic.every((g) => g.headers["x-api-key"] === KEYS.anthropic && !g.headers.authorization), "Anthropic's route: the key as x-api-key");
  const toOpenai = got.filter((g) => g.path === "/v1/responses");
  assert.ok(toOpenai.length >= 1 && toOpenai.every((g) => g.headers.authorization === `Bearer ${KEYS.openai}` && !g.headers["x-api-key"]), "OpenAI's route: the key as a Bearer");
  console.log("ok gate: the run's token reaches the provider as the key; no token, a wrong one, another route or a path off /v1 never does");

  // Modes (10), while they run.
  const mode = (p) => statSync(p).mode & 0o777;
  for (const b of ["sam", "rook"]) assert.equal(mode(join(d.bots, b)), 0o700);
  for (const [b, a] of [["sam", "ag_samclaude1"], ["sam", "ag_samcodex01"], ["rook", "ag_rookopenc1"], ["rook", "ag_rookclaud1"]]) {
    assert.equal(mode(join(d.bots, b, "agents", a)), 0o700);
    for (const f of readdirSync(bin(b, a))) assert.equal(mode(join(bin(b, a), f)), 0o700, `${b}/${a}/bin/${f}`);
    for (const f of readdirSync(join(d.bots, b, "agents", a)).filter((x) => x.endsWith(".port"))) assert.equal(mode(join(d.bots, b, "agents", a, f)), 0o600);
  }
  for (const x of ["brain_x", "brain_y", "brain_z"]) assert.equal(mode(join(d.brains, x)), 0o700);
  console.log("ok modes: bots' and accounts' folders 0700, wrappers 0700, port files 0600");

  // The runs end: each gate goes with its CLI, and a finished run's token is refused.
  const gates = [sx.env.BOPS_GATE, ro.env.BOPS_GATE, rc.env.BOPS_GATE];
  await Promise.all(Object.values(threads).map((t) => ok(`bops-agent close ${t.id}`)));
  await until(() => Object.values(threads).every((t) => readFileSync(join(d.agents, t.id, "out.jsonl"), "utf8").includes('"exited"')), "every thread's process gone");
  const ports = () => ["sam", "rook"].flatMap((b) => readdirSync(join(d.bots, b, "agents")).flatMap((a) => readdirSync(join(d.bots, b, "agents", a)).filter((f) => f.endsWith(".port"))));
  await until(() => !ports().length, "every gate gone");
  for (const g of gates) {
    const r = await sh(`/usr/bin/curl -s -o /dev/null -w '%{http_code}' -m 3 -H 'x-api-key: ${rc.env.ANTHROPIC_API_KEY}' -d '{}' ${g}/anthropic/v1/messages`);
    assert.equal(r.out.trim(), "000", `the gate at ${g} still answers`);
  }
  console.log("ok gate lifetime: each gate goes with its run, and its token is worth nothing after");

  // Two threads of one agent on two models at once (New thread's model): each thread and what it runs keeps its own.
  const two = [
    { ...threads.samClaude, id: "s_twoclaude1", session: "55555555-5555-4555-8555-555555555555", model: "claude-opus-5-5" },
    { ...threads.samClaude, id: "s_twoclaude2", session: "66666666-6666-4666-8666-666666666666", model: "claude-sonnet-5-5", prof: threads.samClaude.prof.replace("--model claude-opus-5-5", "--model claude-sonnet-5-5") },
    { ...threads.samCodex, id: "s_twocodex1", model: "gpt-6.1-sol" },
    { ...threads.samCodex, id: "s_twocodex2", model: "gpt-6-astra", prof: threads.samCodex.prof.replace("--model gpt-6.1-sol", "--model gpt-6-astra") },
    { ...threads.rookOc, id: "s_twooc1", session: "ses_rookThread0002", model: "anthropic/claude-sonnet-5-5" },
    { ...threads.rookOc, id: "s_twooc2", session: "ses_rookThread0003", model: "openai/gpt-6.1-sol", key: KEYS.openai, prof: threads.rookOc.prof.replace("--model anthropic/claude-sonnet-5-5 --route anthropic", "--model openai/gpt-6.1-sol --route openai") },
  ];
  const recBefore = new Set(readdirSync(d.rec));
  await Promise.all(two.map((t, i) => start(t, i + 1)));
  await Promise.all(two.map((t) => send(t, "Side by side.")));
  const pidOf = (r) => r.file.split(".").at(-1);
  const topFor = (t) =>
    until(() => {
      const [bot, agent] = [/--bot (\S+)/.exec(t.prof)[1], /--agent (\S+)/.exec(t.prof)[1]];
      return records(t.kind, bot, agent).find((r) => r.args.join(" ").includes(t.kind === "codex" ? t.model : t.session) && readFileSync(r.file, "utf8").includes("@END"));
    }, `${t.id}'s run`);
  const nestedOf = (top, name) => until(() => readdirSync(d.rec).filter((f) => f.startsWith(`${name}.`) && f.includes(".nested.")).map((f) => parse(join(d.rec, f))).find((r) => r.env.BOPS_TEST_PARENT === pidOf(top)), `${top.file}'s nested ${name}`);
  for (const t of two) {
    const top = await topFor(t);
    assert.equal(top.env.BOPS_MODEL, t.model, `${t.id}'s run has its own model`);
    if (t.kind === "claude") {
      assert.equal(top.env.ANTHROPIC_MODEL, t.model);
      assert.equal((await nestedOf(top, "claude")).env.ANTHROPIC_MODEL, t.model, `${t.id}'s nested claude is on its model`);
    } else if (t.kind === "codex") {
      assert.ok(top.args.join(" ").includes(`-c model="${t.model}"`), top.args.join(" "));
      assert.ok((await nestedOf(top, "codex")).args.join(" ").includes(`-c model="${t.model}"`), `${t.id}'s nested codex is on its model`);
    } else {
      const run = JSON.parse(top.env.OPENCODE_CONFIG_CONTENT);
      const route = t.model.split("/")[0];
      assert.deepEqual([run.model, run.enabled_providers], [t.model, [route]], `${t.id}'s OpenCode run is on its model and provider`);
      assert.ok(run.mcp.screen, "with the thread's own MCP servers");
      assert.ok(top.args.join(" ").includes(`--model ${t.model}`));
      assert.equal(JSON.parse((await nestedOf(top, "opencode")).env.OPENCODE_CONFIG_CONTENT).model, t.model, `${t.id}'s nested opencode is on its model`);
    }
  }
  assert.ok(!/"model"/.test(readFileSync(ocCfg, "utf8")), "the agent's file still names no model");
  await Promise.all(two.map((t) => ok(`bops-agent close ${t.id}`)));
  await until(() => two.every((t) => readFileSync(join(d.agents, t.id, "out.jsonl"), "utf8").includes('"exited"')), "the side by side threads gone");
  // Their records go, so the checks below count only their own.
  for (const f of readdirSync(d.rec)) if (!recBefore.has(f)) rmSync(join(d.rec, f));
  console.log("ok two threads of one agent on two models at once: each run, and the claude, codex or opencode it runs, keeps its own model and provider");

  // 11. Terminal and the bot's shell: the CLI, then the bot's own shell with the same settings, never /root/.bashrc.
  writeFileSync(TYPED, `env | LC_ALL=C sort > ${join(d.rec, "shell-env.txt")}\ncommand -v claude >> ${join(d.rec, "shell-env.txt")}\nsleep 1\nexit\n`);
  await ok(`bops-agent put ${threads.rookClaude.id} key`, KEYS.anthropic);
  const term = await ok(`bops-agent terminal ${threads.rookClaude.id} brain_z 4 pc_1 ${threads.rookClaude.session} --kind claude ${threads.rookClaude.prof}`);
  assert.match(term, /terminal on :4/);
  await until(() => existsSync(join(d.rec, "shell-env.txt")) && readFileSync(join(d.rec, "shell-env.txt"), "utf8").includes("/claude\n"), "the bot's shell ran");
  const shellEnv = Object.fromEntries(readFileSync(join(d.rec, "shell-env.txt"), "utf8").split("\n").filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const termCli = await one("claude", "rook", "ag_rookclaud1", "top", 2);
  assert.ok(termCli.args.includes("--resume") && !termCli.args.includes("-p"), termCli.args.join(" "));
  for (const k of ["PATH", "CLAUDE_CONFIG_DIR", "ANTHROPIC_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "BOPS_GATE", "BOPS_BOT", "BOPS_AGENT", "TMPDIR", "HOME"])
    assert.equal(shellEnv[k], termCli.env[k], `the shell's ${k} is the run's`);
  assert.ok(readFileSync(join(d.rec, "shell-env.txt"), "utf8").includes(join(bin("rook", "ag_rookclaud1"), "claude")));
  assert.ok(!bashrcRead(), "/root/.bashrc was never read");
  await until(() => !existsSync(join(d.agents, threads.rookClaude.id, "term.pid")), "the terminal closed");
  // The bot's own terminal with no thread (Open its terminal): its shell on its Default.
  rmSync(join(d.rec, "shell-env.txt"));
  const shell = await ok(`bops-agent shell sam brain_x claude 5 pc_1 --bot sam --agent ag_samclaude1 --model claude-opus-5-5 --also ${SAM_ALSO} --label sam`);
  assert.match(shell, /terminal on :5/);
  await until(() => existsSync(join(d.rec, "shell-env.txt")) && readFileSync(join(d.rec, "shell-env.txt"), "utf8").includes("/claude\n"), "Sam's shell ran");
  const samShell = readFileSync(join(d.rec, "shell-env.txt"), "utf8");
  assert.match(samShell, new RegExp(`CLAUDE_CONFIG_DIR=${join(d.brains, "brain_x")}`));
  assert.ok(samShell.includes(join(bin("sam", "ag_samclaude1"), "claude")));
  assert.ok(!/ANTHROPIC_API_KEY|BOPS_GATE/.test(samShell));
  assert.ok(!bashrcRead());
  console.log("ok terminal: the CLI, then the bot's own shell with the run's settings; /root/.bashrc never read");

  // 8. Default unchanged: Boppy (no profile) gets today's executor, with only the screen and its key added.
  writeFileSync(join(d.bops, "executor-key-6"), KEYS.exec, { mode: 0o600 });
  await ok(`bops-exec 6 'env_boppy' 'wss://cloud.test/exec'`);
  const boppy = await one("codex", "none", "none");
  assert.deepEqual(boppy.args, ["exec-server", "--remote", "wss://cloud.test/exec", "--environment-id", "env_boppy"]);
  const strip = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(k)));
  assert.deepEqual(strip(boppy.env), strip({ ...ENV, DISPLAY: ":6", CODEX_API_KEY: KEYS.exec }));
  assert.ok(!existsSync(join(d.bots, "boppy")));
  console.log("ok default bot: today's executor, byte for byte the same environment; nothing of it under bots/");

  // Sam's Bops agent: its bin first on the executor's PATH, so claude there is Sam's plan.
  const samBin = (await ok(`bops-brain bin sam --also ${SAM_ALSO}`)).trim();
  assert.equal(samBin, bin("sam", "bops"));
  writeFileSync(join(d.bops, "executor-key-7"), KEYS.exec, { mode: 0o600 });
  await ok(`bops-exec 7 'env_sam' 'wss://cloud.test/exec' '${samBin}'`);
  const samExec = await one("codex", "none", "none", "top", 2);
  assert.ok(samExec.env.PATH.startsWith(`${samBin}:`));
  assert.equal(samExec.which.claude, join(samBin, "claude"));
  assert.match(readFileSync(join(samBin, "claude"), "utf8"), /CLAUDE_CONFIG_DIR='[^']*brain_x'/);
  assert.match(readFileSync(join(samBin, "codex"), "utf8"), /Codex runs on this bot's key only in a thread with Codex/);
  const bad = await sh(`bops-exec 7 'env_sam' 'wss://cloud.test/exec' '/tmp/evil'`);
  assert.notEqual(bad.code, 0);
  console.log("ok Bops agent on a bot with a profile: its executor's claude is the bot's, and nothing else goes first on its PATH");

  // A Claude key listed ahead of a Claude plan: the plan is still claude in the bot's other agents' threads.
  const pipBin = (await ok(`bops-brain bin pip --also claude:key:brain_k:claude-sonnet-5-5,claude:plan:brain_p:claude-haiku-5-5`)).trim();
  assert.match(readFileSync(join(pipBin, "claude"), "utf8"), /CLAUDE_CONFIG_DIR='[^']*brain_p'.*ANTHROPIC_MODEL='claude-haiku-5-5'/s);
  await ok(`bops-brain bot-clear pip`);
  // Sam's Claude plan agent goes: every one of Sam's agents' bins (its Bops agent's, its Codex's) has its claude
  // rewritten in place, while the Claude agent's own wrapper stays its own.
  const ownClaude = readFileSync(join(bin("sam", "ag_samclaude1"), "claude"), "utf8");
  assert.match(readFileSync(join(bin("sam", "ag_samcodex01"), "claude"), "utf8"), /brain_x/, "before: Sam's Codex threads run claude on its plan");
  assert.match(await ok(`bops-brain rebin sam --also codex:key:brain_y:`), /rebinned/);
  for (const a of ["bops", "ag_samcodex01"]) assert.match(readFileSync(join(bin("sam", a), "claude"), "utf8"), /This bot doesn't run Claude Code/, `${a}'s claude`);
  assert.equal(readFileSync(join(bin("sam", "ag_samclaude1"), "claude"), "utf8"), ownClaude);
  assert.match(readFileSync(join(bin("sam", "bops"), "codex"), "utf8"), /Codex runs on this bot's key only in a thread with Codex/);
  await ok(`bops-brain rebin sam --also ${SAM_ALSO}`);
  assert.match(readFileSync(join(bin("sam", "bops"), "claude"), "utf8"), /brain_x/);
  // A Codex thread already going when the plan goes: its next message's run takes the bot's agents as they are now.
  const going = { ...threads.samCodex, id: "s_rebincodex" };
  const recAt = new Set(readdirSync(d.rec));
  await start(going, 2);
  await send(going, "One.");
  const firstRun = await until(() => readdirSync(d.rec).filter((f) => !recAt.has(f) && f.startsWith("codex.sam.ag_samcodex01.top.")).map((f) => parse(join(d.rec, f))).find((r) => readFileSync(r.file, "utf8").includes("@END")), "its first run");
  assert.equal(firstRun.nested.claude.code, 0, "on Sam's plan while Sam has it");
  await until(() => readFileSync(join(d.agents, going.id, "out.jsonl"), "utf8").includes("turn.completed"), "its first turn done");
  await sleep(20);
  await ok(`bops-brain rebin sam --also codex:key:brain_y:`);
  await send(going, "Two.");
  const secondRun = await until(() => readdirSync(d.rec).filter((f) => !recAt.has(f) && f.startsWith("codex.sam.ag_samcodex01.top.")).map((f) => parse(join(d.rec, f))).find((r) => r.file !== firstRun.file && readFileSync(r.file, "utf8").includes("@END")), "its second run");
  assert.equal(secondRun.nested.claude.code, 127, "its next run's claude: Sam doesn't run a Claude plan now");
  assert.match(readFileSync(join(bin("sam", "ag_samcodex01"), "claude"), "utf8"), /This bot doesn't run Claude Code/);
  await ok(`bops-agent close ${going.id}`);
  await until(() => readFileSync(join(d.agents, going.id, "out.jsonl"), "utf8").includes('"exited"'), "it ended");
  for (const f of readdirSync(d.rec)) if (!recAt.has(f)) rmSync(join(d.rec, f));
  await ok(`bops-brain rebin sam --also ${SAM_ALSO}`);
  console.log("ok rebin: a Claude plan the bot doesn't run anymore leaves every one of its agents' claude at once, and a Codex thread going takes it at its next message; a plan comes ahead of a key");

  // 7. Switch: Sam's Codex agent removed.
  await ok(`bops-brain bot-clear sam ag_samcodex01`);
  assert.ok(!existsSync(join(d.bots, "sam", "agents", "ag_samcodex01")));
  assert.ok(existsSync(join(d.brains, "brain_y", "config.toml")), "its account's folder stays");
  const after = { ...threads.samClaude, id: "s_samclaude2", session: "44444444-4444-4444-8444-444444444444", prof: "--bot sam --agent ag_samclaude1 --model claude-opus-5-5 --also claude:plan:brain_x:claude-opus-5-5 --label sam" };
  await start(after, 1);
  await send(after, "Again.");
  const sc2 = await one("claude", "sam", "ag_samclaude1", "top", 2);
  assert.equal(sc2.nested.codex.code, 127);
  assert.match(sc2.nested.codex.said, /This bot doesn't run Codex/);
  await ok(`bops-agent close ${after.id}`);
  // Sam back to the default profile: its folder goes, and its executor is today's again.
  await until(() => readFileSync(join(d.agents, after.id, "out.jsonl"), "utf8").includes('"exited"'), "Sam's thread gone");
  await ok(`bops-brain bot-clear sam`);
  assert.ok(!existsSync(join(d.bots, "sam")));
  writeFileSync(join(d.bops, "executor-key-6"), KEYS.exec, { mode: 0o600 });
  await ok(`bops-exec 6 'env_boppy' 'wss://cloud.test/exec'`);
  const samDefault = await one("codex", "none", "none", "top", 3);
  assert.deepEqual(strip(samDefault.env), strip(boppy.env));
  console.log("ok switching: a removed agent's folder and gate go, the next thread's codex says Sam doesn't run it; back to the default is today's");

  // 9. No shared places, and no key or token anywhere on the computer.
  for (const p of [".profile", ".bash_profile", ".claude", ".codex", ".config/opencode", ".gemini", ".local/share/opencode"]) assert.ok(!existsSync(join(d.home, p)), `${p} was written`);
  assert.equal(readFileSync(join(d.home, ".bashrc"), "utf8"), BASHRC);
  assert.ok(!existsSync(join(d.etc, "environment")) && !existsSync(join(d.etc, "profile.d")));
  const tokens = [sx.env.OPENAI_API_KEY, ro.env.ANTHROPIC_API_KEY, rc.env.ANTHROPIC_API_KEY];
  const scan = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) scan(p);
      else if (f.isFile()) {
        const body = readFileSync(p, "utf8");
        for (const k of [KEYS.anthropic, KEYS.openai, KEYS.exec, ...tokens]) assert.ok(!body.includes(k), `${p} has a key or token in it`);
        assert.ok(!/bopsrun_[0-9a-f]{16,}/.test(body), `${p} has a run token in it`);
      }
    }
  };
  scan(ROOT);
  console.log("ok nothing shared written (.bashrc, .profile, .claude, .codex, OpenCode, Gemini), no key or token in any file on the computer");
} finally {
  for (const t of [...Object.values(threads), { id: "s_samclaude2" }, ...["s_twoclaude1", "s_twoclaude2", "s_twocodex1", "s_twocodex2", "s_twooc1", "s_twooc2", "s_rebincodex"].map((id) => ({ id }))]) await sh(`bops-agent stop ${t.id}`);
  await sh(`pkill -f '[b]ops-ai-gate .*${d.bots}/' ; true`);
  upstream.close();
  if (!process.env.KEEP) rmSync(scratch, { recursive: true, force: true });
  else console.log("kept", scratch);
}
console.log("all ok");
