/**
 * How an agent's cursor travels over the bot's browser (components/app/browser-cursor.tsx), and so how long the bot
 * waits for it before it presses (the stand-in's steps, scripts/dev-two-person.mjs): a hand's move, as stageshow's
 * (kit/act.ts move): clamp(260 + dist * 0.9, 300, 650) ms, eased in and out, in a shallow arc bowed min(dist * 0.08,
 * 24) px off the straight line with a sine profile. Distances are the page's CSS pixels, so every viewer's cursor and
 * the bot's wait agree whatever size the frame is shown at.
 *
 * A travel is a plain value: where from and to, when it began and for how long, and how it moves. A new point that
 * comes mid-travel starts the next one from where the cursor is then (at), so it never jumps.
 *
 * Pure: no DOM, no React. scripts/test-cursor-path.mjs checks it.
 */

export type Point = { x: number; y: number };
/** "move": a hand's arc. "hurry": a press came before the cursor got there; the rest of the way, quickly. "follow": a hand already moving (points close in time); it keeps up. "jump": reduced motion, at once. */
export type Way = "move" | "hurry" | "follow" | "jump";
export type Travel = { from: Point; to: Point; start: number; ms: number; way: Way };

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** How long a hand's move of `dist` px takes. */
export const travelMs = (dist: number) => clamp(260 + dist * 0.9, 300, 650);
/** How far the arc of a move of `dist` px bows off the straight line, at most. */
export const bowOf = (dist: number) => Math.min(dist * 0.08, 24);
/** A press that came before the cursor did: it gets there in this long, then presses. */
export const HURRY_MS = 180;
/** Points closer together in time than this are one hand moving: the cursor follows them rather than arcing to each. */
export const STREAM_MS = 120;
/** How long a press dips the arrow. */
export const DIP_MS = 120;
/** A cursor that hasn't moved in this long fades out, back with the next move. */
export const REST_MS = 4000;

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** A travel from `from` to `to` beginning at `start`, the `way` given. */
export function travel(from: Point, to: Point, start: number, way: Way): Travel {
  const d = distance(from, to);
  const ms = way === "jump" || d < 0.5 ? 0 : way === "hurry" ? HURRY_MS : way === "follow" ? STREAM_MS : travelMs(d);
  return { from: { ...from }, to: { ...to }, start, ms, way };
}

/** Where the cursor is at `now`: exactly `from` at the start, exactly `to` once it's over (a jump: at once). */
export function at(t: Travel, now: number): Point {
  if (t.ms <= 0 || now >= t.start + t.ms) return { ...t.to };
  if (now <= t.start) return { ...t.from };
  const p = (now - t.start) / t.ms;
  const dx = t.to.x - t.from.x;
  const dy = t.to.y - t.from.y;
  if (t.way !== "move") {
    const e = easeOutCubic(p);
    return { x: t.from.x + dx * e, y: t.from.y + dy * e };
  }
  const d = Math.hypot(dx, dy);
  const e = easeInOutCubic(p);
  // Bowed to the left of the way it goes, most at the middle of the eased path.
  const lift = Math.sin(Math.PI * e) * bowOf(d);
  return { x: t.from.x + dx * e + (-dy / d) * lift, y: t.from.y + dy * e + (dx / d) * lift };
}

export const arrived = (t: Travel, now: number) => now >= t.start + t.ms;

/**
 * The next travel for a point that came at `now`, from wherever the cursor is then: a press hurries (unless it's
 * there already), a move close behind the last is followed, any other move is a hand's arc; reduced motion jumps.
 */
export function retarget(t: Travel, to: Point, now: number, o: { press?: boolean; sinceLast: number; reduced: boolean }): Travel {
  const from = at(t, now);
  const way: Way = o.reduced ? "jump" : o.press ? "hurry" : o.sinceLast < STREAM_MS ? "follow" : "move";
  return travel(from, to, now, way);
}
