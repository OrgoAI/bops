// Tests for scripts/fake-exports.mjs, which the test scripts that fake lib/server modules (test-runner,
// test-schedules, ...) use: a module that imports a name the test's fake doesn't list still loads (before, the
// whole script stopped at once, "does not provide an export named", with nothing counted), and calling that
// name says it isn't faked. Every kind of export is read.
// Usage: node --conditions=react-server scripts/test-fake-exports.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { exportsOf, fill, unfaked } from "./fake-exports.mjs";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// The store faked with getState alone: runner.ts imports stateEpoch (and more) from it too.
const FAKES = { store: ["getState"] };
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
    return { format: "module", shortCircuit: true, source: `export const getState = () => ({ bots: [], routines: [], sessions: [] });${unfaked(name, url, FAKES[name])}` };
  },
});

const R = await import(`${root}/lib/server/runner.ts`);
assert.equal(typeof R.runsHere, "function", "runner.ts loads though the fake lists no stateEpoch");
const S = await import(`${root}/lib/server/store.ts`);
assert.deepEqual(S.getState(), { bots: [], routines: [], sessions: [] }, "what's listed is the test's fake");
assert.throws(() => S.stateEpoch(), /^Error: store\.stateEpoch isn't faked in this test: add it to its fakes$/);

// Every kind of export: functions (async too), consts, lets, classes, and export lists (with "as"), never types.
const store = exportsOf(pathToFileURL(`${root}/lib/server/store.ts`).href);
for (const n of ["getState", "ownSession", "stateEpoch", "addMessage"]) assert.ok(store.includes(n), n);
const runner = exportsOf(pathToFileURL(`${root}/lib/server/runner.ts`).href);
for (const n of ["onRunner", "runsHere", "OVERDUE_MS", "runnerForTests", "runnerComputerOf"]) assert.ok(runner.includes(n), n);
assert.ok(!runner.some((n) => /^type\b/.test(n)));
// A fake written as a whole source (test-access): what it has stays, several to a line too, and the rest stand in.
const filled = fill("sessions", pathToFileURL(`${root}/lib/server/sessions.ts`).href, "export const startSession = () => undefined; export const stopSession = () => {};");
assert.equal((filled.match(/export const startSession\b/g) ?? []).length, 1);
assert.equal((filled.match(/export const stopSession\b/g) ?? []).length, 1);
assert.match(filled, /export const endSessionOf = \(\) => \{ throw new Error\("sessions\.endSessionOf isn't faked/);
console.log("fake exports: ok");
