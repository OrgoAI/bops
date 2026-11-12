// Tests for Ingot on a computer's runner (lib/server/ingot.ts, BOPS_RUNNER=1): it signs in to Ingot only with the
// token its computer has for the workspace (root's tokens folder there, which the owner's Bops wrote), never with an
// Orgo key (Ingot takes a computer's own Orgo sign in for nothing); with no token there, or one Ingot turned away, it
// says so in plain words and changes nothing; getting the computer ready there never makes, lists or revokes a token
// (only the owner's account can); and a token is never dropped from a runner.
//
// The store and Orgo's client are fakes (a state with one workspace, and the computer's commands answered here), and
// Ingot is a fake on localhost, so nothing reaches Orgo, Bops Cloud or Ingot.
// Usage: node --conditions=react-server scripts/test-runner-ingot.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-runner-ingot-"));
process.chdir(scratch);
process.env.HOME = scratch;
process.env.BOPS_RUNNER = "1";
process.env.BOPS_RUNNER_COMPUTER = "c1c1c1c1-0000-4000-8000-000000000001";
const TOKENS = join(scratch, "tokens");
process.env.BOPS_INGOT_TOKENS = TOKENS;

const PROJECT = "3f6c2a1e-8b4d-4c7a-9e21-5d0b7a9c4f13";
const COMPUTER = process.env.BOPS_RUNNER_COMPUTER;
const TOKEN = "ingot_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Ingot: what each call carried, answered as a repo list (and 401 when a test says so).
const calls = [];
let turnAway = false;
const ingotServer = createServer((req, res) => {
  calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
  res.writeHead(turnAway ? 401 : 200, { "content-type": "application/json" });
  res.end(JSON.stringify(turnAway ? { error: "unauthorized" } : { repos: [{ name: "recipe-box", head: null, updated_at: null }] }));
});
await new Promise((r) => ingotServer.listen(0, "127.0.0.1", r));
process.env.BOPS_INGOT_URL = `http://127.0.0.1:${ingotServer.address().port}`;

// The fakes: the state (one workspace on Orgo, whose token on this computer the owner's Bops made), and Orgo's client
// (no Orgo key is ever asked for Ingot; the computer's commands answered by `bash`).
const state = { bots: [], workspaces: [{ id: "ws_main", orgoProjectId: PROJECT, ingotTokens: { [COMPUTER]: { id: "7", sum: "x", at: 1 } } }] };
const ran = [];
let probe = "";
globalThis.__fake = {
  store: {
    getState: () => state,
    update: (fn) => fn(state),
    bot: () => undefined,
    sameState: () => () => true,
    watchChanges: () => {},
  },
  orgo: {
    apiKey: async () => {
      throw new Error("an Orgo key was asked for");
    },
    orgo: {
      bash: async (computerId, script) => {
        ran.push({ computerId, kind: /^# bops-ingot (\w+)/.exec(script)?.[1] ?? "?" });
        if (script.startsWith("# bops-ingot probe")) return { output: probe, exit_code: 0 };
        if (script.startsWith("# bops-ingot git")) return { output: "INGOT_GIT=ok", exit_code: 0 };
        if (script.startsWith("# bops-ingot config")) return { output: "INGOT_CONFIG=ok", exit_code: 0 };
        return { output: "", exit_code: 1 };
      },
      computer: async () => null,
    },
  },
};
// Each fake module: a call to globalThis.__fake[module][name] for a function, the value itself for an object.
const fakeOf = (name) => {
  const all = globalThis.__fake[name];
  const line = (n) => (typeof all[n] === "function" ? `export const ${n} = (...a) => globalThis.__fake.${name}.${n}(...a);` : `export const ${n} = globalThis.__fake.${name}.${n};`);
  return `data:text/javascript,${encodeURIComponent(Object.keys(all).map(line).join("\n"))}`;
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
    if (specifier === "./store") return { url: fakeOf("store"), shortCircuit: true };
    if (specifier === "./orgo") return { url: fakeOf("orgo"), shortCircuit: true };
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
});

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 4).join("\n  ") ?? e.message}`);
  }
}

const I = await import(`${root}/lib/server/ingot.ts`);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const configSum = sha(`${JSON.stringify({ url: process.env.BOPS_INGOT_URL })}\n`);
const probeWith = (token) => [`INGOT_ARCH=amd64`, `INGOT_BIN=${"b".repeat(64)}`, `INGOT_CONFIG=${configSum}`, `INGOT_TOKEN_FILE=${token}`].join("\n");

await check("with no token of the workspace's on this computer: Ingot isn't called with an Orgo key, and it says so in plain words", async () => {
  await assert.rejects(I.ingot.repos("ws_main"), (e) => e instanceof I.IngotError && e.message === I.NO_TOKEN_HERE);
  assert.equal(calls.length, 0, "nothing sent");
  assert.doesNotMatch(I.NO_TOKEN_HERE, /Mac|in this chat|[‒–—―]/);
});

await check("with the workspace's token in root's tokens folder: Ingot is called with it, and only it", async () => {
  mkdirSync(TOKENS, { recursive: true });
  writeFileSync(join(TOKENS, PROJECT), `${TOKEN}\n`, { mode: 0o600 });
  const repos = await I.ingot.repos("ws_main");
  assert.deepEqual(repos.map((r) => r.name), ["recipe-box"]);
  assert.equal(calls.at(-1).auth, `Bearer ${TOKEN}`);
  assert.equal(calls.at(-1).url, `/api/v1/w/${PROJECT}/repos`);
});

await check("a token Ingot turns away: said as one this computer can't replace (refused), nothing more sent", async () => {
  turnAway = true;
  try {
    await assert.rejects(I.ingot.repos("ws_main"), (e) => e instanceof I.IngotError && e.refused && /can't make a new one with its own Orgo sign in/.test(e.message));
  } finally {
    turnAway = false;
  }
});

await check("getting the computer ready: never a token made, listed or revoked; none there is said plainly; one there, the computer is ready with no call to Ingot", async () => {
  const before = calls.length;
  probe = probeWith("none");
  await assert.rejects(I.ensureIngotCli(COMPUTER, "ws_main"), (e) => e instanceof I.IngotError && e.message === I.NO_TOKEN_HERE);
  assert.equal(calls.length, before, "Ingot not asked for a token");
  probe = probeWith(sha(`${TOKEN}\n`));
  ran.length = 0;
  await I.ensureIngotCli(COMPUTER, "ws_main");
  assert.deepEqual(ran.map((r) => r.kind), ["probe", "git"], "looked at, git set up, nothing else");
  assert.equal(calls.length, before, "and Ingot not asked at all");
  // Asked again within the minute: nothing run.
  ran.length = 0;
  await I.ensureIngotCli(COMPUTER, "ws_main");
  assert.deepEqual(ran, []);
  // One Ingot turned away (renew): it can't make a new one, said so.
  await assert.rejects(I.ensureIngotCli(COMPUTER, "ws_main", { renew: true }), (e) => e instanceof I.IngotError && e.refused);
  assert.equal(calls.length, before);
});

await check("a token is never dropped from a runner (revoking is the owner's account's)", async () => {
  const before = calls.length;
  await I.dropToken("ws_main", COMPUTER);
  assert.equal(calls.length, before, "no revoke sent");
  assert.ok(state.workspaces[0].ingotTokens[COMPUTER], "and the workspace's record of it stays");
});

ingotServer.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`runner ingot: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
