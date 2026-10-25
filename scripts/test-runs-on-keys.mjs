// Tests for whether each of the bots' computers holds its own Orgo key, as Settings asks Bops for it
// (app/api/runs-on/keys, lib/server/computer-keys.ts): orgo-web's GET /api/computers/{id}/orgo-key with the
// signed-in key, and nothing else about the computer (an asleep one is never woken); a key (what names it,
// its prefix only when it's no more than one, never the key), none (404 key_not_found), and nothing said
// when Orgo couldn't say (405 from an orgo-web before that GET, 403 owner_only, 404 not_found, a 500, no
// answer within a few seconds, Orgo unreachable); only computers some bot works on; each answer kept a
// minute per computer and user, asked once when two look at once; nothing asked when no one is signed in.
// Orgo is a fake fetch on a made-up origin and the state a throwaway file store in a temporary folder:
// nothing reaches Orgo.
// Usage: node --conditions=react-server scripts/test-runs-on-keys.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A file store, loaded at once and always ready (lib/server/persist.ts).
process.env.BOPS_SELF_HOSTED = "1";
for (const k of ["ORGO_API_KEY", "BOPS_ORGO_WORKSPACE", "BOPS_ORGO_TEMPLATE", "BOPS_DATABASE_URL", "AGENTMAIL_API_KEY", "BOPS_MAIL_DOMAIN", "OPENAI_API_KEY", "TAILSCALE_AUTH_KEY", "BOPS_RUNNER"]) delete process.env[k];
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Modules that would start processes when loaded are stand-ins whose exports do nothing (as in test-plan.mjs).
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
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
const scratch = mkdtempSync(join(tmpdir(), "bops-test-runs-on-keys-"));
process.chdir(scratch);
// Signed in already: the key is in memory, so the Keychain is never asked (lib/server/orgo-auth.ts).
const KEY = "sk_live_" + "signedin0123456789abcdef0123456789abcdef";
globalThis.bopsOrgoKey = KEY;

// The clock, moved on by the tests (each answer is kept a minute).
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
// How long each call to Orgo may take: seen, and a few milliseconds here, so one Orgo never answers ends soon.
const timeouts = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => (timeouts.push(ms), realTimeout(30));

/* ---------------- A fake orgo-web ---------------- */

const id = (n) => `c0c0c0c0-0000-4000-8000-00000000000${n}`;
const [HAS, NONE, OLD, SLOW, DOWN, MEMBER, UNKNOWN, BROKEN, CLONING, ELSEWHERE] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id).concat("c0c0c0c0-0000-4000-8000-000000000010");
const COMPUTER_KEY = "sk_live_" + "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34";
const USED = new Date(realNow() - 2 * 60_000).toISOString();
const MADE = "2026-10-01T12:00:00.000Z";
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
/** orgo-web's answer for each computer's GET /api/computers/{id}/orgo-key. */
const answers = {
  // A key (and a careless orgo-web that sent the key itself too, which never goes on).
  [HAS]: () => json(200, { keyId: "key_1", prefix: "sk_live_ab12", name: "Computer key for boppy", createdAt: MADE, lastUsed: USED, expiresAt: null, key: COMPUTER_KEY }),
  [NONE]: () => json(404, { error: "This computer has no Orgo key.", code: "key_not_found" }),
  // An orgo-web from before this GET (only PUT and DELETE).
  [OLD]: () => new Response(null, { status: 405 }),
  // Never answers: aborted by the timeout.
  [SLOW]: (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")))),
  [DOWN]: () => {
    throw new TypeError("fetch failed");
  },
  [MEMBER]: () => json(403, { error: "Only the owner of this workspace can do that.", code: "owner_only" }),
  [UNKNOWN]: () => json(404, { error: "Computer not found.", code: "not_found" }),
  [BROKEN]: () => json(500, { error: "boom" }),
};
const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin !== "https://orgo.test") throw new TypeError(`fetch failed (not the fake Orgo: ${url})`);
  calls.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization") });
  const m = /^\/api\/computers\/([^/]+)\/orgo-key$/.exec(url.pathname);
  if (req.method === "GET" && m && answers[m[1]]) return answers[m[1]](init.signal);
  return json(404, { error: "Not found" });
};
/** Everything logged, to check the keys never are. */
const logged = [];
for (const level of ["log", "info", "warn", "error"]) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    logged.push(args.map(String).join(" "));
    real(...args);
  };
}

const S = await import(`${root}/lib/server/store.ts`);
const R = await import(`${root}/app/api/runs-on/keys/route.ts`);
delete process.env.BOPS_SELF_HOSTED;

// Each computer some bot works on (one still being made, and one bot sharing the main bot's), and the signed-in user.
const bot = (n, computerId, more = {}) => ({ id: `bot${n}`, name: `Bot ${n}`, color: "#0A0A0A", isMain: n === 1, computer: "own", computerId, computerStatus: "ready", ...more });
S.update((s) => {
  s.host = "orgo";
  s.account = { user: { id: "u1", email: "sam@example.com" }, signedInAt: 1 };
  s.bots = [
    bot(1, HAS),
    bot(2, NONE),
    bot(3, OLD),
    bot(4, SLOW),
    bot(5, DOWN),
    bot(6, MEMBER),
    bot(7, UNKNOWN),
    bot(8, BROKEN),
    bot(9, CLONING, { computerStatus: "cloning" }),
    { id: "max", name: "Max", color: "#E9FF3B", isMain: false, computerStatus: "none" },
  ];
});

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const get = async (ids) => {
  const res = await R.GET(new Request(`http://localhost:3210/api/runs-on/keys${ids === undefined ? "" : `?ids=${encodeURIComponent(ids.join(","))}`}`));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
};
const asked = (since) => calls.slice(since).map((c) => `${c.method} ${c.path}`);
const ALL = [HAS, NONE, OLD, SLOW, DOWN, MEMBER, UNKNOWN, BROKEN];

await test("a key, none (404 key_not_found), and nothing said for 405, 403, 404 not_found, a 500, a timeout or no Orgo", async () => {
  const n = calls.length;
  const r = await get([...ALL, CLONING, ELSEWHERE, "not-a-uuid"]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    keys: {
      [HAS]: { keyId: "key_1", prefix: "sk_live_ab12", name: "Computer key for boppy", createdAt: Date.parse(MADE), lastUsed: Date.parse(USED), expiresAt: null },
      [NONE]: null,
    },
    manage: "https://orgo.test/settings/api-keys",
  });
  // Only that GET, once for each computer some bot works on: none still being made, none no bot works on, nothing else about any computer.
  assert.deepEqual(asked(n).sort(), ALL.map((c) => `GET /api/computers/${c}/orgo-key`).sort());
  assert.ok(calls.slice(n).every((c) => c.auth === `Bearer ${KEY}`), "asked with the signed-in key");
  assert.ok(timeouts.length >= ALL.length && timeouts.every((ms) => ms <= 5000), `a short timeout: ${timeouts}`);
  // Never a key in the answer: not the signed-in one, not the computer's (which a careless Orgo sent).
  assert.ok(!r.text.includes(KEY) && !r.text.includes(COMPUTER_KEY), r.text);
  assert.ok(!logged.some((l) => l.includes(KEY) || l.includes(COMPUTER_KEY)), "nor in a log");
});

await test("kept a minute per computer: asked again only after it, and once when two look at once", async () => {
  let n = calls.length;
  const again = await get([HAS, NONE, OLD, SLOW]);
  assert.deepEqual(Object.keys(again.body.keys).sort(), [HAS, NONE].sort());
  assert.deepEqual(asked(n), [], "within the minute: nothing asked, the timeout and 405 included");
  shift += 61_000;
  n = calls.length;
  const [a, b] = await Promise.all([get([HAS, OLD]), get([HAS, OLD])]);
  assert.deepEqual(a.body, b.body);
  assert.equal(a.body.keys[HAS].prefix, "sk_live_ab12");
  assert.deepEqual(asked(n).sort(), [`GET /api/computers/${HAS}/orgo-key`, `GET /api/computers/${OLD}/orgo-key`].sort(), "a minute on: asked again, once");
});

await test("never more of a key than its prefix; times Orgo didn't give are null", async () => {
  shift += 61_000;
  answers[HAS] = () => json(200, { keyId: "key_2", prefix: COMPUTER_KEY, name: "Computer key for boppy", createdAt: "not a date", lastUsed: null, expiresAt: "2027-01-01T00:00:00.000Z" });
  const r = await get([HAS]);
  assert.deepEqual(r.body.keys[HAS], { keyId: "key_2", prefix: "", name: "Computer key for boppy", createdAt: null, lastUsed: null, expiresAt: Date.parse("2027-01-01T00:00:00.000Z") });
  assert.ok(!r.text.includes(COMPUTER_KEY), r.text);
  // As orgo-web keeps it (key_prefix: its first 12 characters and an ellipsis).
  shift += 61_000;
  answers[HAS] = () => json(200, { keyId: "key_3", prefix: "sk_live_ab12…", name: "Computer key for boppy", createdAt: MADE, lastUsed: USED, expiresAt: null });
  assert.equal((await get([HAS])).body.keys[HAS].prefix, "sk_live_ab12");
});

await test("nothing asked with no computers, or when no one is signed in; another user's answers aren't kept for them", async () => {
  shift += 61_000;
  let n = calls.length;
  assert.deepEqual((await get(undefined)).body, { keys: {}, manage: "https://orgo.test/settings/api-keys" });
  assert.deepEqual((await get([])).body.keys, {});
  assert.deepEqual(asked(n), []);
  const user = S.getState().account;
  S.update((s) => void (s.account = undefined));
  n = calls.length;
  assert.deepEqual((await get([HAS])).body.keys, {});
  assert.deepEqual(asked(n), [], "signed out: Orgo isn't asked");
  // Someone else signed in: their own answer, not the last user's kept one.
  S.update((s) => void (s.account = user));
  n = calls.length;
  await get([HAS]);
  assert.deepEqual(asked(n), [`GET /api/computers/${HAS}/orgo-key`], "signed in again: asked");
  S.update((s) => void (s.account = { ...user, user: { id: "u2" } }));
  n = calls.length;
  await get([HAS]);
  assert.deepEqual(asked(n), [`GET /api/computers/${HAS}/orgo-key`]);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`runs on keys: ${passed} passed`);
