// Tests for how an agent's cursor travels over the bot's browser (lib/cursor-path.ts): a hand's arc, by stageshow's
// numbers. Each expected value is worked out here from the rule, never by the module's own helpers.
//
// - Endpoints exact: at the start it's where it was, from the end on exactly where it went.
// - Duration: 300 to 650 ms for any move of 50 to 2000 px (260 + 0.9 px a ms, clamped).
// - The arc: never more than 24 px off the straight line, and it does bow (a straight line would be 0).
// - A new point mid-travel starts from where the cursor is: no jump over 2 px between the frame before and after.
// - A press hurries (180 ms), a move close behind the last follows, reduced motion jumps.
// Usage: node scripts/test-cursor-path.mjs
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { at, travel, retarget, travelMs, HURRY_MS, STREAM_MS } = await import(`${root}/lib/cursor-path.ts`);

let passed = 0;
const test = (name, f) => {
  f();
  passed++;
  console.log(`ok - ${name}`);
};
const from = { x: 100, y: 120 };
/** Every millisecond of a travel. */
const samples = (t) => Array.from({ length: t.ms + 1 }, (_, i) => at(t, t.start + i));
/** How far `p` is off the straight line from a to b. */
const off = (p, a, b) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / Math.hypot(b.x - a.x, b.y - a.y);

test("endpoints are exact", () => {
  for (const to of [{ x: 700, y: 120 }, { x: 103, y: 40 }, { x: 1900, y: 1000 }]) {
    const t = travel(from, to, 1000, "move");
    assert.deepEqual(at(t, 1000), from);
    assert.deepEqual(at(t, 999), from);
    assert.deepEqual(at(t, 1000 + t.ms), to);
    assert.deepEqual(at(t, 1000 + t.ms + 5000), to);
  }
});

test("a move of 50 to 2000 px takes 300 to 650 ms, as 260 + 0.9 a px", () => {
  for (let d = 50; d <= 2000; d += 10) {
    const t = travel(from, { x: from.x + d, y: from.y }, 0, "move");
    assert.ok(t.ms >= 300 && t.ms <= 650, `${d} px: ${t.ms} ms`);
    assert.equal(t.ms, Math.min(650, Math.max(300, 260 + d * 0.9)));
  }
  assert.equal(travelMs(30), 300, "clamped at the short end");
  assert.equal(travelMs(50), 305);
  assert.equal(travelMs(200), 440);
  assert.equal(travelMs(2000), 650);
});

test("the arc bows, and never more than 24 px off the straight line", () => {
  for (const to of [{ x: 160, y: 120 }, { x: 400, y: 500 }, { x: 1800, y: 900 }, { x: 100, y: 1500 }]) {
    const t = travel(from, to, 0, "move");
    const most = Math.max(...samples(t).map((p) => off(p, from, to)));
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    assert.ok(most <= 24 + 1e-9, `${d.toFixed(0)} px: ${most.toFixed(2)} px off`);
    // It bows as far as 8% of the way, up to 24 px, at the middle.
    assert.ok(Math.abs(most - Math.min(d * 0.08, 24)) < 0.05, `${d.toFixed(0)} px: bows ${most.toFixed(2)} px`);
  }
});

test("a new point mid-travel starts from where the cursor is (no jump over 2 px)", () => {
  const t = travel(from, { x: 900, y: 600 }, 0, "move");
  for (const now of [40, 150, t.ms / 2, t.ms - 20]) {
    const before = at(t, now);
    for (const o of [{ press: false, sinceLast: 400 }, { press: false, sinceLast: 30 }, { press: true, sinceLast: 400 }]) {
      const next = retarget(t, { x: 300, y: 50 }, now, { ...o, reduced: false });
      // Where the new travel puts it the moment the point comes, against where the old one had it then.
      const start = at(next, now);
      const jump = Math.hypot(start.x - before.x, start.y - before.y);
      assert.ok(jump <= 2, `at ${now} ms (${JSON.stringify(o)}): jumped ${jump.toFixed(2)} px`);
      assert.ok(next.ms > 0, "and it travels from there (not a jump to the new point)");
    }
  }
});

test("a press hurries, a move close behind the last follows, reduced motion jumps", () => {
  const t = travel(from, { x: 900, y: 600 }, 0, "move");
  assert.equal(retarget(t, { x: 900, y: 600 }, 100, { press: true, sinceLast: 0, reduced: false }).ms, HURRY_MS);
  assert.equal(HURRY_MS, 180);
  const f = retarget(t, { x: 920, y: 610 }, 100, { press: false, sinceLast: 33, reduced: false });
  assert.deepEqual([f.way, f.ms], ["follow", STREAM_MS]);
  // A follow never bows: every point on the straight line.
  assert.ok(Math.max(...samples(f).map((p) => off(p, f.from, f.to))) < 1e-9);
  const j = retarget(t, { x: 20, y: 20 }, 100, { press: false, sinceLast: 900, reduced: true });
  assert.equal(j.ms, 0);
  assert.deepEqual(at(j, 100), { x: 20, y: 20 }, "there at once");
  // A press where the cursor already is: no travel at all.
  const done = travel(from, { x: 500, y: 500 }, 0, "move");
  assert.equal(retarget(done, { x: 500, y: 500 }, 5000, { press: true, sinceLast: 900, reduced: false }).ms, 0);
});

console.log(`cursor path: ${passed} passed`);
