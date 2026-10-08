// Tests for starting a sign-in (app/api/auth/start, lib/server/orgo-sign-in.ts): the page the browser
// opens for Continue with Google, Continue with email and Sign in with Orgo. It always carries the code
// (nobody types one) and app=bops, Google and email add provider=, and an Orgo login names no provider. Then what isn't a web page, what Orgo leaves out, and Orgo's errors. Orgo is a fake fetch on a
// made-up origin and the state a throwaway file store in a temporary folder: nothing reaches Orgo, and
// the Keychain, the cloud and the relay are stand-ins.
// Usage: node --conditions=react-server scripts/test-sign-in.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// Orgo is the fake below, on its own origin; the state goes to a throwaway file store.
for (const k of ["ORGO_API_KEY", "BOPS_DATABASE_URL", "BOPS_SELF_HOSTED"]) delete process.env[k];
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ts = createRequire(import.meta.url)("typescript");
// Modules that would start something when called or loaded (the Keychain, Bops Cloud, the relay, the
// bots' sessions and what they load) are stand-ins: each of their exports does nothing.
const STAND_INS = new Set(["keychain", "cloud-tunnel", "relay", "sessions", "mac", "desktop", "mirror"]);
// The server modules import "@/lib/…" and "./store" (no extension), the way Next resolves them. Node only
// strips types and can't run parameter properties (SignInError has one), so the project's TypeScript
// compiles each file instead.
const project = pathToFileURL(root).href + "/";
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
    if (!url.startsWith(project) || url.includes("/node_modules/") || !/\.tsx?$/.test(url)) return next(url, context);
    const file = fileURLToPath(url);
    const source = readFileSync(file, "utf8");
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (name && STAND_INS.has(name)) {
      const names = [...source.matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
      return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
    }
    const { outputText } = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});
// The file store writes to .data/ under the working folder: a temporary one, removed at the end.
const scratch = mkdtempSync(join(tmpdir(), "bops-test-sign-in-"));
process.chdir(scratch);

/** Orgo's device-code start, faked: `answer` is what it says next (a Response, or a thrown error for no connection). */
const orgo = { calls: [], answer: null };
const CODE = "ABC-DEF-GHJ";
const started = (extra = {}) =>
  Response.json({
    device_code: "device-secret-1",
    user_code: CODE,
    verification_uri: "https://orgo.test/cli/approve",
    verification_uri_complete: `https://orgo.test/cli/approve?code=${CODE}`,
    interval_seconds: 2,
    expires_in_seconds: 600,
    ...extra,
  });
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  orgo.calls.push({ method: req.method, url: req.url, body: req.body ? await req.json() : null });
  const out = typeof orgo.answer === "function" ? orgo.answer() : orgo.answer;
  if (!out) throw new TypeError("fetch failed (the test is offline)");
  return out;
};

const L = await import(`${root}/lib/server/orgo-sign-in.ts`);
const route = await import(`${root}/app/api/auth/start/route.ts`);
/** POST /api/auth/start the way the app does: a JSON body naming the way in, or none at all. */
const start = async (body) => {
  const init = body === undefined ? { method: "POST" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) };
  const res = await route.POST(new Request("http://localhost/api/auth/start", init));
  return { status: res.status, json: await res.json() };
};
const params = (u) => Object.fromEntries(new URL(u).searchParams);

// The ways in: only Google and email are hints; anything else is a plain Orgo sign-in.
assert.equal(L.signInProvider("google"), "google");
assert.equal(L.signInProvider("email"), "email");
for (const v of ["orgo", "apple", "Google", "", undefined, null, 1, {}, ["google"]]) assert.equal(L.signInProvider(v), undefined, `${JSON.stringify(v)} is no way in`);

// approvalPage: the code and app=bops always on the page, provider= only with a way in.
const page = `https://orgo.test/cli/approve?code=${CODE}`;
assert.equal(L.approvalPage(page, CODE), `${page}&app=bops`, "an Orgo login names no way in, still as Bops");
assert.deepEqual(params(L.approvalPage(`${page}&provider=google`, CODE)), { code: CODE, app: "bops" }, "an Orgo login never carries a way in");
assert.equal(L.approvalPage(page, CODE, "google"), `${page}&provider=google&app=bops`);
assert.equal(L.approvalPage(page, CODE, "email"), `${page}&provider=email&app=bops`);
assert.equal(L.approvalPage("https://orgo.test/cli/approve", CODE, "google"), `${page}&provider=google&app=bops`, "a page without the code gets it");
assert.equal(L.approvalPage("https://orgo.test/cli/approve", CODE), `${page}&app=bops`);
assert.deepEqual(params(L.approvalPage("https://orgo.test/cli/approve?code=OLD-OLD-OLD&x=1", CODE, "email")), { code: CODE, x: "1", provider: "email", app: "bops" }, "the code is the one the app shows");
assert.deepEqual(params(L.approvalPage(`${page}&provider=email&app=orgo`, CODE, "google")), { code: CODE, provider: "google", app: "bops" }, "the way asked for wins");

// Continue with Google: Orgo is asked for a code as Bops, and the page opens on Google with the code.
orgo.answer = () => started();
let r = await start({ provider: "google" });
assert.equal(r.status, 200);
assert.equal(r.json.verificationUrl, `https://orgo.test/cli/approve?code=${CODE}&provider=google&app=bops`);
assert.equal(r.json.userCode, CODE);
assert.equal(r.json.interval, 2);
assert.ok(Math.abs(r.json.expiresAt - (Date.now() + 600_000)) < 5_000, "the code lasts what Orgo says");
assert.equal(r.json.deviceCode, undefined, "the device code stays on the server");
assert.ok(!JSON.stringify(r.json).includes("device-secret-1"), "the device code stays on the server");
assert.equal(orgo.calls.length, 1);
assert.equal(orgo.calls[0].url, "https://orgo.test/api/cli/auth/start");
assert.equal(orgo.calls[0].body.client, "Bops");
assert.equal(typeof orgo.calls[0].body.hostname, "string");

// Continue with email.
r = await start({ provider: "email" });
assert.equal(r.json.verificationUrl, `https://orgo.test/cli/approve?code=${CODE}&provider=email&app=bops`);

// Sign in with Orgo: no body, an empty one, or a way in that isn't one, all open Orgo's page with no way in.
for (const body of [undefined, {}, { provider: "apple" }, { provider: null }, "null", "not json"]) {
  r = await start(body);
  assert.equal(r.status, 200, `start with ${JSON.stringify(body)}`);
  assert.equal(r.json.verificationUrl, `https://orgo.test/cli/approve?code=${CODE}&app=bops`, `start with ${JSON.stringify(body)}`);
}

// Orgo leaves out the complete page, or sends one that isn't a web page: Orgo's approve page with the code, then the hints.
orgo.answer = () => started({ verification_uri_complete: undefined });
r = await start({ provider: "google" });
assert.equal(r.json.verificationUrl, `https://orgo.test/cli/approve?code=${CODE}&provider=google&app=bops`);
orgo.answer = () => started({ verification_uri_complete: "javascript:alert(1)" });
r = await start({ provider: "email" });
assert.equal(r.json.verificationUrl, `https://orgo.test/cli/approve?code=${CODE}&provider=email&app=bops`);
orgo.answer = () => started({ verification_uri_complete: "file:///etc/passwd" });
r = await start();
assert.equal(r.json.verificationUrl, `https://orgo.test/cli/approve?code=${CODE}&app=bops`);
// Orgo's complete page on another host (a preview or staging Orgo) is kept, with the code and hints on it.
orgo.answer = () => started({ verification_uri_complete: `https://staging.orgo.test/cli/approve?code=${CODE}` });
r = await start({ provider: "google" });
assert.equal(r.json.verificationUrl, `https://staging.orgo.test/cli/approve?code=${CODE}&provider=google&app=bops`);

// "Open the page again" opens what start gave (the app keeps it), so a second start for another way replaces it.
orgo.answer = () => started({ user_code: "XYZ-XYZ-XYZ", verification_uri_complete: "https://orgo.test/cli/approve?code=XYZ-XYZ-XYZ" });
r = await start({ provider: "email" });
assert.equal(r.json.verificationUrl, "https://orgo.test/cli/approve?code=XYZ-XYZ-XYZ&provider=email&app=bops");

// Orgo's errors, the same whichever way: no code, an error, no connection.
const quiet = console.error;
console.error = () => {};
try {
  orgo.answer = () => Response.json({ device_code: "d" });
  r = await start({ provider: "google" });
  assert.deepEqual([r.status, r.json], [502, { error: "orgo" }], "no code in the answer");
  orgo.answer = () => Response.json({ error: "Insert failed" }, { status: 500 });
  r = await start({ provider: "email" });
  assert.deepEqual([r.status, r.json], [502, { error: "orgo" }], "an error on Orgo");
  orgo.answer = null;
  r = await start();
  assert.deepEqual([r.status, r.json], [502, { error: "offline" }], "no connection");
} finally {
  console.error = quiet;
}

// Cancel.
const del = await route.DELETE();
assert.deepEqual(await del.json(), { ok: true });

process.chdir(tmpdir());
rmSync(scratch, { recursive: true, force: true });
console.log("sign-in tests passed");
