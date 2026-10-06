// Routine validation through the shared creation function and HTTP route, with an in-memory store.
// Usage: node --conditions=react-server scripts/test-routines.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const storeUrl = new URL("../lib/server/store.ts", import.meta.url).href;
const sessionsUrl = new URL("../lib/server/sessions.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(join(root, specifier.slice(2))).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier)) return next(specifier + ".ts", context);
      throw e;
    }
  },
  load(url, context, next) {
    // No real app state, agent processes, provider requests or persistence.
    if (url === storeUrl) return {
      format: "module", shortCircuit: true,
      source: `const state = { routines: [] };
        export const getState = () => state;
        export const update = (fn) => fn(state);
        export const id = () => "rtn_" + state.routines.length;
        export const ownerName = () => "the user";
        export const bot = () => undefined;
        export const addMessage = () => {};
        export const patchSession = () => {};`,
    };
    if (url === sessionsUrl) return {
      format: "module", shortCircuit: true,
      source: 'export const startSession = () => { throw new Error("No agent should start"); };',
    };
    return next(url, context);
  },
});

const { validSchedule, InvalidRoutineScheduleError } = await import("../lib/server/routine-schedule.ts");
const { createRoutine } = await import("../lib/server/routines.ts");
const { getState } = await import("../lib/server/store.ts");
const { POST } = await import("../app/api/routines/route.ts");

const valid = [
  { kind: "daily", time: "00:00" },
  { kind: "daily", time: "23:59" },
  { kind: "weekdays", time: "09:00" },
  { kind: "weekly", time: "09:00", day: 0 },
  { kind: "weekly", time: "09:00", day: 6 },
  { kind: "once", at: 0 }, // Past timestamps remain structurally valid.
  { kind: "once", at: Date.now() + 60_000 },
];
const invalid = [
  null, undefined, [], "daily", 1, {},
  { kind: "unknown", time: "09:00" },
  ...["25:00", "09:75", "nonsense", "9:00", "09:0", "24:00", "-1:00", "09:00:00", "09:00\n", " 09:00"].map((time) => ({ kind: "daily", time })),
  ...[undefined, null, 900].map((time) => ({ kind: "weekdays", time })),
  ...[undefined, null, -1, 7, 200, 1.5, "1", NaN].map((day) => ({ kind: "weekly", time: "09:00", day })),
  ...[undefined, null, "0", NaN, Infinity, -Infinity].map((at) => ({ kind: "once", at })),
];
const post = (body) => POST(new Request("http://localhost/api/routines", {
  method: "POST", headers: { "content-type": "application/json" }, body,
}));

try {
  for (const schedule of invalid) {
    assert.equal(validSchedule(schedule), false);
    const count = getState().routines.length;
    assert.throws(() => createRoutine("bot_test", "Test", "Test routine", schedule), InvalidRoutineScheduleError);
    assert.equal(getState().routines.length, count, "invalid input must not save a routine");
    const response = await post(JSON.stringify({ botId: "bot_test", goal: "Test routine", schedule }));
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, "string");
    assert.equal(getState().routines.length, count, "HTTP rejection must not save a routine");
  }
  for (const schedule of valid) {
    assert.equal(validSchedule(schedule), true);
    const routine = createRoutine("bot_test", "Test", "Test routine", schedule);
    assert.deepEqual(routine.schedule, schedule);
    const response = await post(JSON.stringify({ botId: "bot_test", goal: "Test routine", schedule }));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).schedule, schedule);
  }
  for (const body of ["{", "null", "[]", "{}"]) {
    const count = getState().routines.length;
    assert.equal((await post(body)).status, 400);
    assert.equal(getState().routines.length, count);
  }
  console.log(`Routine validation passed: ${invalid.length} invalid and ${valid.length} valid schedules, shared creation and HTTP paths.`);
} finally {
  clearInterval(globalThis.__bopsRoutines);
}
