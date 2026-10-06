"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, type ComponentProps, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { bubblePath, tailBox } from "@/components/message-ui/bubble-shape";
import { bubbleMetrics } from "@/components/message-ui/tokens";
import type { Platform } from "@/components/message-ui/platform";

/**
 * Motion engine for the message list. Everything is built on the Web Animations API so a running
 * animation can be paused and scrubbed with `seek(ms)`, which is how the lab captures frames for
 * comparison with the 60 fps native recording (references/ios/motion/).
 *
 * Send timeline, re-measured frame by frame from `references/ios/motion/send-60fps.mp4`. Frames are the
 * 0-based output of `ffmpeg -vsync 0 -start_number 0` (299 frames, 60 fps), so t = (f - 73) / 60 s: f68 to
 * f72 differ by at most 2 in any channel and every one of them paints the blue send button (3321 px with
 * B - R > 80 in an 80 x 65 box over it; f73 has none), so f73 is the first animated frame and t = 0. The
 * contact sheets in that folder are 1-based on the same clip - their "f74" is this file's f73 - and the
 * times this file used to carry were read from f71, two frames (33 ms) early of the first frame that moves.
 * - 0 ms (f73): the text row is *already* a tinted rounded rect, tail and all, over exactly the field's text
 *   box; the send button is already gone and the placeholder is already at full strength (its darkest glyph
 *   luma is 170.5 here and 175.9 once the rect has passed, over backgrounds of 232.6 and 253.0).
 * - 17 to 150 ms: the rect collapses toward the field's right end. Widths, pt: 292 (f73), 294 (f74), 272
 *   (f75), 252, 226, 195, 154 (f79), 123 (f80), 98, 82, 68 (f84). f74 is still full width, so the collapse
 *   starts between 17 and 33 ms. Native keeps shrinking past the bubble's own size to 0.772 at 183 ms; the
 *   clone cannot hold a scale above 1, so the rect carries the shape to 150 ms, where the scale crosses 1.
 * - 33 ms on: the bubble leaves the field on a spring released from rest. Fitted over f84 to f133 with the
 *   amplitude pinned to the geometric travel (127.1 pt), damping 0.73 and 11.9 rad/s reproduces the body's
 *   bottom edge to 0.28 pt rms / 0.77 pt worst over 50 frames; the old 0.8 and 15 rad/s from 103 ms misses
 *   by 9.6 pt rms / 35 pt worst. Scale recovers on a second, slower spring released 10 ms past the minimum.
 * - The bubble overshoots: its tail corner passes 5.0 pt above the slot at 417 ms (f98) and falls back,
 *   inside 0.25 pt of rest at 633 ms (f111) and settled by 690 ms (f114). Scale is done by ~500 ms flat.
 *
 * Measured "Hi there" body tops, recording/this model (402x874 screen, slot top 686.8/687.25): 150 ms
 * 760.8/763.2, 233 ms 717.6/718.0, 317 ms 691.8/692.9, 350 ms 686.9/688.0. f83 duplicates f82, so 167 ms
 * is a repeat. At 1017 ms (f134) "Delivered" moves off the bubble above and the slot rises 15 pt to 671.75.
 */
export const messageMotion = {
  /** Legacy tokens kept for the harness and pressable-message. */
  arrival: 420,
  delivery: 900,
  reaction: 320,
  press: 120,
  longPress: 500,
  /**
   * `-[CKUIBehaviorPhone sendAnimationDuration]` is **0.4**, and that is not a contradiction of the
   * 690 here - it is the flight, not the whole thing. Tracking the sent bubble's bottom edge through
   * `references/ios/motion/send-60fps.mp4` at 60 fps, from the frame the composer empties:
   *
   *   t 0      the bubble appears with its bottom at device y 856.5
   *   t 400    it has arrived, bottom 728.5 - this is where ChatKit's 0.4 ends
   *   t 400-667 it springs back down 728.5 -> 733.5, five device pixels
   *   t 667-1017 stationary
   *   t 1017+  it moves again, which is the next event and not this animation
   *
   * So 0.4 s is the travel and the settle runs to about 667; 690 is that settle rounded off the
   * frame grid. Do not "fix" this to 400 - the bubble would stop dead where native is still moving.
   */
  send: {
    morph: 17, liftoff: 33, shrink: 150, duration: 690,
    textReveal: 25, textVisible: 70,
    /** The placeholder is already at full strength in f73, so it holds rather than fading in. */
    placeholderIn: 0, tint: 0.55,
    /** In-flight scale: the bubble flies at (1 - squash) of its size and grows back on `growSpring`. */
    squash: 0.228, grow: 193,
    spring: { damping: 0.73, frequency: 11.9 },
    growSpring: { damping: 0.8, frequency: 13.1 },
  },
  receive: { duration: 300, fade: 80, startScale: 0.5, spring: { damping: 0.7, frequency: 30 } },
  reduced: { duration: 200 },
} as const;

export type MotionHandle = {
  duration: number;
  /** Pause every animation and jump to `ms`. */
  seek(ms: number): void;
  play(): void;
  pause(): void;
  /** Stop and remove any helper elements. */
  cancel(): void;
  /** Resolves when the animation finishes (or is cancelled). */
  finished: Promise<void>;
  readonly animations: Animation[];
};

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Remaining offset (as a fraction of the start offset) of an underdamped spring released from rest,
 * `t` in seconds. With the send spring's damping 0.73 and 11.9 rad/s the first overshoot is 3.5% of the
 * travel 386 ms after release, 3.8% once `offsetAt` normalises it: 4.9 pt of the send's 127.1 pt travel at
 * 419 ms, which is the 5.0 pt at 417 ms (f98) that the recording overshoots its slot by.
 */
export function springOffset(t: number, damping: number, frequency: number): number {
  if (t <= 0) return 1;
  const root = Math.sqrt(1 - damping * damping);
  const wd = frequency * root;
  return Math.exp(-damping * frequency * t) * (Math.cos(wd * t) + (damping / root) * Math.sin(wd * t));
}

type Rect = { left: number; top: number; width: number; height: number };

function makeHandle(animations: Animation[], duration: number, cleanup: () => void, paused: boolean | undefined, tick?: (ms: number) => void): MotionHandle {
  if (paused) animations.forEach(a => a.pause());
  let done = false;
  let raf = 0;
  const finish = () => { if (done) return; done = true; cancelAnimationFrame(raf); cleanup(); animations.forEach(a => { try { a.cancel(); } catch { /* already gone */ } }); };
  const finished = Promise.all(animations.map(a => a.finished.catch(() => undefined))).then(finish);
  const loop = () => {
    raf = 0;
    if (done || !tick) return;
    const t = Number(animations[0]?.currentTime ?? 0);
    tick(Math.max(0, Math.min(duration, t)));
    if (animations[0]?.playState === "running") raf = requestAnimationFrame(loop);
  };
  if (tick && !paused) raf = requestAnimationFrame(loop);
  return {
    duration,
    animations,
    finished,
    // Once `finish` has run the helper elements are gone, so every control is inert from then on:
    // a late seek or play would otherwise drive animations whose targets are no longer in the page.
    seek(ms) { if (done) return; const t = Math.max(0, Math.min(duration, ms)); animations.forEach(a => { a.pause(); a.currentTime = t; }); tick?.(t); },
    play() { if (done) return; animations.forEach(a => a.play()); if (tick && !raf) raf = requestAnimationFrame(loop); },
    pause() { if (done) return; animations.forEach(a => a.pause()); },
    cancel() { finish(); },
  };
}

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace("#", "");
  if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  if (h.length === 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return null;
}

/** Solid color of the bubble's screen-space gradient at screen y `bottom` (px from the frame top). */
function fillAt(body: HTMLElement, bottom: number): string {
  const cs = getComputedStyle(body);
  const top = hexToRgb(cs.getPropertyValue("--im-fill-top"));
  const end = hexToRgb(cs.getPropertyValue("--im-fill-bottom"));
  const screen = parseFloat(cs.getPropertyValue("--im-screen-h")) || 874;
  if (!top || !end) return cs.backgroundColor;
  const k = Math.max(0, Math.min(1, bottom / screen));
  const c = top.map((v, i) => Math.round(v + (end[i] - v) * k));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function visibleText(body: HTMLElement): string {
  return Array.from(body.childNodes).map(node => (node instanceof HTMLElement && node.classList.contains("sr-only") ? "" : node.textContent ?? "")).join("").trim();
}

export type SendAnimationOptions = {
  /** The element that represents the device screen. The transient ghost is appended to it, so it needs `position: relative`. */
  frame: HTMLElement;
  /** The composer text field's rect in viewport coordinates (from getBoundingClientRect). */
  field: Rect;
  /** The new message's `[data-slot="message-bubble"]` element (already laid out in its final slot). */
  bubble: HTMLElement;
  /** Composer placeholder to fade in while the rect shrinks. */
  placeholder?: HTMLElement | null;
  /** Composer send button to hide in the first 17 ms. */
  sendButton?: HTMLElement | null;
  /** Text drawn inside the shrinking rect; defaults to the bubble's text. */
  text?: string;
  /** Corner radius of the composer field; the rect starts as that shape. Defaults to a pill. */
  fieldRadius?: number;
  /**
   * Where the shrinking rect is drawn. Native draws it inside the field, under the placeholder, so pass the
   * field element (a positioned one) to get that layering; it is added as the first child. Defaults to `frame`.
   */
  ghostParent?: HTMLElement | null;
  /** Start paused so the caller can `seek`. */
  paused?: boolean;
  reducedMotion?: boolean;
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function playSendAnimation(o: SendAnimationOptions): MotionHandle {
  const S = messageMotion.send;
  const reduced = o.reducedMotion ?? prefersReducedMotion();
  if (reduced) {
    const D = messageMotion.reduced.duration;
    const a = o.bubble.animate([{ opacity: 0 }, { opacity: 1 }], { duration: D, fill: "both", easing: "ease-out" });
    const b = o.placeholder ? [o.placeholder.animate([{ opacity: 0 }, { opacity: 1 }], { duration: D, fill: "both" })] : [];
    return makeHandle([a, ...b], D, () => undefined, o.paused);
  }
  const D = S.duration;
  const at = (ms: number) => ms / D;
  const timing: KeyframeAnimationOptions = { duration: D, fill: "both", easing: "linear" };
  const body = o.bubble.querySelector<HTMLElement>('[data-slot="bubble"], [data-slot="emoji"]') ?? o.bubble;
  const platform = (o.bubble.dataset.platform ?? "ios") as Platform;
  const m = bubbleMetrics[platform];
  const side = o.bubble.dataset.direction === "incoming" ? "left" : "right";
  const frameRect = o.frame.getBoundingClientRect();
  // Preview frames can be scaled by an ancestor. Rects are in screen pixels, while the ghost,
  // clone and their keyframes use the frame's local CSS pixels.
  const scaleX = frameRect.width / o.frame.offsetWidth || 1;
  const scaleY = frameRect.height / o.frame.offsetHeight || 1;
  const slot = body.getBoundingClientRect();
  const fx = (o.field.left - frameRect.left) / scaleX, fy = (o.field.top - frameRect.top) / scaleY, fw = o.field.width / scaleX, fh = o.field.height / scaleY;
  const bw = slot.width / scaleX, bh = slot.height / scaleY;
  const sx = (slot.left - frameRect.left) / scaleX, sy = (slot.top - frameRect.top) / scaleY;
  const gx = side === "right" ? fx + fw - bw : fx, gy = fy + (fh - bh) / 2;
  const dx = gx - sx, dy = gy - sy;
  const cs = getComputedStyle(body);

  // Two springs, both released from rest and both normalised so they land exactly on the slot at `duration`
  // (without that the last keyframe would step by ~0.5 pt). `offsetAt` is the fraction of the travel still
  // to go; `scaleAt` is the uniform scale, anchored at the bubble's tail corner so that corner flies alone.
  const P = S.spring, G = S.growSpring;
  const kEnd = springOffset((D - S.liftoff) / 1000, P.damping, P.frequency);
  const gEnd = springOffset((D - S.grow) / 1000, G.damping, G.frequency);
  const offsetAt = (ms: number) => (springOffset((ms - S.liftoff) / 1000, P.damping, P.frequency) - kEnd) / (1 - kEnd);
  const scaleAt = (ms: number) => 1 - S.squash * (springOffset((ms - S.grow) / 1000, G.damping, G.frequency) - gEnd) / (1 - gEnd);
  /** Where the flying bubble's box sits at `ms`, in frame coordinates. */
  const flightBox = (ms: number) => {
    const k = offsetAt(ms), scale = scaleAt(ms);
    const width = bw * scale, height = bh * scale;
    const bottom = sy + bh + dy * k;
    const left = side === "right" ? sx + bw + dx * k - width : sx + dx * k;
    return { left, top: bottom - height, width, height, scale };
  };

  // Phase 1: the field's text row becomes a bubble-shaped rect and shrinks toward the field's sending end.
  // It ends exactly on the flying bubble's box at `shrink`, so the hand-over is invisible.
  const ghost = document.createElement("div");
  ghost.dataset.slot = "send-ghost";
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    position: "absolute", left: "0px", top: "0px", boxSizing: "border-box",
    background: fillAt(body, fy + fh), pointerEvents: "none",
    // Inside the field it paints in DOM order, under the placeholder; over the frame it needs to be lifted.
    zIndex: o.ghostParent ? "auto" : "30",
    // A transient element must never become a scroll anchor: scrubbing rebuilds it every frame, and each
    // insert and remove would otherwise let scroll anchoring nudge whatever scroller contains it.
    overflowAnchor: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  const tint = document.createElement("div");
  Object.assign(tint.style, { position: "absolute", inset: "0", background: "#ffffff", opacity: String(S.tint) });
  const label = document.createElement("div");
  label.textContent = o.text ?? visibleText(body);
  Object.assign(label.style, {
    position: "absolute", [side]: "0", top: "0", width: `${bw}px`, height: `${bh}px`, boxSizing: "border-box",
    padding: cs.padding, transformOrigin: `${side} top`,
    font: cs.font, letterSpacing: cs.letterSpacing, lineHeight: cs.lineHeight, color: cs.color, whiteSpace: "nowrap", overflow: "hidden", opacity: "0",
    textAlign: bw <= parseFloat(cs.minWidth || "0") + 0.5 ? "center" : "start",
  });
  ghost.append(tint, label);
  const ghostParent = o.ghostParent ?? o.frame;
  // Under the field's own text, but above whatever paints the field itself (a glass stack, a background).
  const editor = ghostParent.querySelector("textarea, input, [contenteditable]");
  ghostParent.insertBefore(ghost, editor?.parentElement === ghostParent ? editor : ghostParent.firstChild);
  // The keyframes below are in frame coordinates; shift them if the rect lives inside the field instead.
  const ox = ghostParent === o.frame ? 0 : (ghostParent.getBoundingClientRect().left - frameRect.left) / scaleX;
  const oy = ghostParent === o.frame ? 0 : (ghostParent.getBoundingClientRect().top - frameRect.top) / scaleY;

  const fieldRadius = o.fieldRadius ?? fh / 2;
  const shape: Keyframe[] = [];
  const labelScale: Keyframe[] = [];
  for (let ms = 0; ms <= S.shrink; ms = Math.min(S.shrink, ms + 5)) {
    const p = Math.max(0, Math.min(1, (ms - S.morph) / (S.shrink - S.morph)));
    const b = flightBox(ms);
    const width = lerp(fw, b.width, p), height = lerp(fh, b.height, p);
    const tailScale = m.tailScale * lerp(1, b.scale, p);
    shape.push({
      offset: at(ms), opacity: ms < S.morph ? at(ms) / at(S.morph) : 1,
      left: `${(lerp(fx, b.left, p) - ox).toFixed(2)}px`, top: `${(lerp(fy, b.top, p) - oy).toFixed(2)}px`,
      width: `${width.toFixed(2)}px`, height: `${(height + tailBox.hang * tailScale).toFixed(2)}px`,
      clipPath: `path("${bubblePath(width, height, side, lerp(fieldRadius, m.radius * b.scale, p), tailScale)}")`,
    });
    labelScale.push({ offset: at(ms), transform: `scale(${lerp(1, b.scale, p).toFixed(4)})` });
    if (ms >= S.shrink) break;
  }
  const settled = { ...shape[shape.length - 1], offset: undefined } as Keyframe;
  const animations: Animation[] = [
    ghost.animate([...shape, { ...settled, offset: at(S.shrink) + 0.002, opacity: 0 }, { ...settled, offset: 1, opacity: 0 }], timing),
    tint.animate([{ offset: 0, opacity: S.tint }, { offset: at(S.morph), opacity: S.tint }, { offset: at(S.shrink), opacity: 0 }, { offset: 1, opacity: 0 }], timing),
    label.animate(labelScale.map(frame => ({ ...frame, opacity: labelOpacity(Number(frame.offset) * D, S) })), timing),
  ];

  // Phase 2: the flight is flown by a clone of the bubble in the frame's overlay layer, so it passes over the
  // composer the way the native bubble does (at 133 ms the recording draws its tail across the field's pill);
  // the real bubble stays invisible in its slot until the clone lands.
  const rootRect = o.bubble.getBoundingClientRect();
  const clone = o.bubble.cloneNode(true) as HTMLElement;
  clone.dataset.slot = "send-clone";
  clone.setAttribute("aria-hidden", "true");
  clone.querySelectorAll("[id]").forEach(el => el.removeAttribute("id"));
  Object.assign(clone.style, {
    position: "absolute", left: `${(rootRect.left - frameRect.left) / scaleX}px`, top: `${(rootRect.top - frameRect.top) / scaleY}px`, width: `${rootRect.width / scaleX}px`,
    margin: "0", pointerEvents: "none", zIndex: "31", opacity: "0", overflowAnchor: "none",
    // The tail corner is the anchor: it flies alone and the rest of the bubble unfolds from it.
    transformOrigin: `${(((side === "right" ? slot.right : slot.left) - rootRect.left) / scaleX).toFixed(2)}px ${((slot.bottom - rootRect.top) / scaleY).toFixed(2)}px`,
  });
  // `cloneNode` copies declarations but not the palette the bubble inherits, so resolve it onto the clone.
  // It then paints the measured gradient wherever it is appended, not only under the element that
  // happens to declare `--im-*` today (both shells append it inside that element; this stops depending on it).
  for (const property of Array.from(cs)) if (property.startsWith("--im-")) clone.style.setProperty(property, cs.getPropertyValue(property));
  const realFrame = o.bubble.querySelector<HTMLElement>('[data-slot="bubble-frame"]');
  const cloneFrame = clone.querySelector<HTMLElement>('[data-slot="bubble-frame"]');
  if (realFrame && cloneFrame) { cloneFrame.style.width = `${realFrame.getBoundingClientRect().width / scaleX}px`; cloneFrame.style.maxWidth = "none"; }
  o.frame.appendChild(clone);

  const transformAt = (ms: number) => `translate(${(dx * offsetAt(ms)).toFixed(2)}px, ${(dy * offsetAt(ms)).toFixed(2)}px) scale(${scaleAt(ms).toFixed(4)})`;
  const flight: Keyframe[] = [{ offset: 0, transform: transformAt(0) }, { offset: at(S.shrink) - 0.002, transform: transformAt(S.shrink) }];
  for (let ms = S.shrink; ms < D; ms += 5) flight.push({ offset: at(ms), transform: transformAt(ms) });
  flight.push({ offset: 1, transform: "translate(0px, 0px) scale(1)" });
  animations.push(clone.animate(flight, timing));
  // The clone and the real bubble swap places with a step, not a crossfade, so at `duration` (and at
  // progress 1, which never runs `cleanup` because a seeked animation never finishes) exactly one of
  // them is painted and the frame equals the settled layout. A ramp here would let a scrub land on a
  // frame with both of them half opaque, which reads as a lighter, doubled bubble.
  animations.push(clone.animate([{ offset: 0, opacity: 0 }, { offset: at(S.shrink) - 0.002, opacity: 0 }, { offset: at(S.shrink), opacity: 1, easing: "step-end" }, { offset: 1, opacity: 0 }], timing));
  animations.push(o.bubble.animate([{ offset: 0, opacity: 0, easing: "step-end" }, { offset: 1, opacity: 1 }], timing));
  // f73 already draws the placeholder at full strength behind the rect (hence `placeholderIn: 0`), so it is
  // held up for the whole flight rather than faded in; it is animated only so the handle owns its opacity.
  if (o.placeholder) animations.push(o.placeholder.animate([{ offset: 0, opacity: 1 }, { offset: 1, opacity: 1 }], timing));
  if (o.sendButton) animations.push(o.sendButton.animate([{ offset: 0, opacity: 1 }, { offset: at(S.morph), opacity: 0 }, { offset: 1, opacity: 0 }], timing));
  // Sending can collapse a multi-line composer or resize the viewport around the software keyboard.
  // Keep the copy over the real slot when that layout or the transcript's scroll position changes.
  // Observe it even while paused, so a scrubbed send has the same destination as a running one.
  const followSlot = () => {
    const currentFrame = o.frame.getBoundingClientRect();
    const currentSlot = o.bubble.getBoundingClientRect();
    const xScale = currentFrame.width / o.frame.offsetWidth || 1;
    const yScale = currentFrame.height / o.frame.offsetHeight || 1;
    clone.style.left = `${(currentSlot.left - currentFrame.left) / xScale}px`;
    clone.style.top = `${(currentSlot.top - currentFrame.top) / yScale}px`;
  };
  const layout = new ResizeObserver(followSlot);
  layout.observe(o.frame);
  layout.observe(o.bubble);
  o.frame.addEventListener("scroll", followSlot, true);
  // Keep the clone's screen-space fill honest while it climbs (the body's bottom edge moves through the gradient).
  const tick = (ms: number) => {
    followSlot();
    clone.style.setProperty("--bubble-bottom", `${(sy + bh + dy * offsetAt(ms)).toFixed(2)}px`);
  };
  tick(0);
  return makeHandle(animations, D, () => { layout.disconnect(); o.frame.removeEventListener("scroll", followSlot, true); ghost.remove(); clone.remove(); }, o.paused, tick);
}

/** The message text fades in inside the shrinking rect as it takes the bubble's shape. */
function labelOpacity(ms: number, S: typeof messageMotion.send): number {
  if (ms <= S.textReveal) return 0;
  if (ms >= S.textVisible) return 1;
  return (ms - S.textReveal) / (S.textVisible - S.textReveal);
}

export type ReceiveAnimationOptions = {
  /** The new incoming message's `[data-slot="message-bubble"]` element. */
  bubble: HTMLElement;
  /** Where the bubble pops from (the typing indicator's rect, viewport coordinates). Defaults to just below the slot. */
  from?: Rect | null;
  paused?: boolean;
  reducedMotion?: boolean;
};

export function playReceiveAnimation(o: ReceiveAnimationOptions): MotionHandle {
  const R = messageMotion.receive;
  const reduced = o.reducedMotion ?? prefersReducedMotion();
  if (reduced) {
    const D = messageMotion.reduced.duration;
    return makeHandle([o.bubble.animate([{ opacity: 0 }, { opacity: 1 }], { duration: D, fill: "both", easing: "ease-out" })], D, () => undefined, o.paused);
  }
  const D = R.duration;
  const body = o.bubble.querySelector<HTMLElement>('[data-slot="bubble"], [data-slot="emoji"]') ?? o.bubble;
  const slot = body.getBoundingClientRect();
  const dx = o.from ? o.from.left - slot.left : 0;
  const dy = o.from ? o.from.top + o.from.height - (slot.top + slot.height) : 8;
  // The corner it grows from rides in the keyframes rather than in the element's own style: a seeked
  // animation never finishes, so a cleanup that restored an inline `transform-origin` would never run.
  const transformOrigin = o.bubble.dataset.direction === "outgoing" ? "right bottom" : "left bottom";
  const frames: Keyframe[] = [];
  for (let ms = 0; ms <= D; ms += 5) {
    const k = springOffset(ms / 1000, R.spring.damping, R.spring.frequency);
    const p = 1 - k;
    const scale = R.startScale + (1 - R.startScale) * p;
    frames.push({ offset: ms / D, opacity: Math.min(1, ms / R.fade), transformOrigin, transform: `translate(${(dx * k).toFixed(2)}px, ${(dy * k).toFixed(2)}px) scale(${scale.toFixed(4)})` });
  }
  frames.push({ offset: 1, opacity: 1, transformOrigin, transform: "translate(0px, 0px) scale(1)" });
  const animation = o.bubble.animate(frames, { duration: D, fill: "both", easing: "linear" });
  return makeHandle([animation], D, () => undefined, o.paused);
}

/** Runs the send animation for a freshly rendered outgoing bubble. Cancels on unmount and when a new send starts. */
export function useSendAnimation() {
  const current = useRef<MotionHandle | null>(null);
  useEffect(() => () => current.current?.cancel(), []);
  const play = useCallback((options: SendAnimationOptions) => {
    current.current?.cancel();
    const handle = playSendAnimation(options);
    current.current = handle;
    void handle.finished.then(() => { if (current.current === handle) current.current = null; });
    return handle;
  }, []);
  return { play, current };
}

/** Pops a freshly rendered incoming bubble in from the typing indicator's position. */
export function useReceiveAnimation() {
  const current = useRef<MotionHandle | null>(null);
  useEffect(() => () => current.current?.cancel(), []);
  const play = useCallback((options: ReceiveAnimationOptions) => {
    current.current?.cancel();
    const handle = playReceiveAnimation(options);
    current.current = handle;
    void handle.finished.then(() => { if (current.current === handle) current.current = null; });
    return handle;
  }, []);
  return { play, current };
}

/** One message's arrival: `progress` (0 to 1) seeks the animation instead of playing it. */
export type ArrivalAnimation = { id: string; progress?: number };

export type ArrivalAnimationOptions = {
  /** The device frame (iOS) or window pane (macOS); the flying copy is added to it. */
  frame: RefObject<HTMLElement | null>;
  /** Newly appended outgoing messages animate automatically when `send` is omitted. Initial history and thread replacements do not. */
  messages?: readonly { id: string; direction: "incoming" | "outgoing" }[];
  /** The message that was just sent: the composer's text row becomes that bubble and flies to its slot. */
  send?: ArrivalAnimation | null;
  /** The message that just arrived: it pops in from the typing indicator's position. */
  receive?: ArrivalAnimation | null;
  /** Called when a played (not seeked) send animation finishes. */
  onSendEnd?: () => void;
};

/**
 * Drives the app shells and standalone conversation. Outgoing appends animate by default;
 * explicit send/receive IDs allow controlled playback and deterministic checkpoints.
 */
export function useArrivalAnimation({ frame, messages, send, receive, onSendEnd }: ArrivalAnimationOptions) {
  const running = useRef<MotionHandle | null>(null);
  const previousMessages = useRef(messages);
  // Kept in a ref so a fresh inline callback cannot restart a flight that is already in the air.
  const end = useRef(onSendEnd);
  useEffect(() => { end.current = onSendEnd; }, [onSendEnd]);
  const sendId = send?.id ?? null, sendProgress = send?.progress;
  const receiveId = receive?.id ?? null, receiveProgress = receive?.progress;

  const playSend = useCallback((root: HTMLElement, id: string, progress?: number) => {
    const bubble = root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"] [data-slot="message-bubble"]`);
    const field = root.querySelector<HTMLElement>('[data-slot="field"]');
    if (!bubble || !field) return;
    running.current?.cancel();
    // Measure the destination after bringing an offscreen new message into view, not before a
    // later scroll moves its slot out from under the flying copy.
    const log = bubble.closest<HTMLElement>('[data-slot="message-list"]');
    if (log) log.scrollTop = log.scrollHeight - log.clientHeight;
    const handle = playSendAnimation({
      frame: root, field: field.getBoundingClientRect(), bubble, ghostParent: field,
      sendButton: field.querySelector<HTMLElement>('[data-slot="send"]'),
      fieldRadius: parseFloat(getComputedStyle(field).borderTopLeftRadius) || undefined,
      paused: progress !== undefined,
    });
    running.current = handle;
    if (progress === undefined) void handle.finished.then(() => { if (running.current === handle) { running.current = null; end.current?.(); } });
    else handle.seek(Math.max(0, Math.min(1, progress)) * handle.duration);
    return handle;
  }, []);

  useLayoutEffect(() => {
    const root = frame.current;
    if (!root || !sendId) return;
    const handle = playSend(root, sendId, sendProgress);
    if (!handle) return;
    return () => { handle.cancel(); if (running.current === handle) running.current = null; };
  }, [frame, sendId, sendProgress, playSend]);

  useLayoutEffect(() => {
    const previous = previousMessages.current;
    previousMessages.current = messages;
    if (send !== undefined || !messages || !previous || messages.length <= previous.length) return;
    // A history prepend, a new thread, or a reset is not a send. Compare IDs, so status updates
    // and reaction edits neither start a second flight nor cancel one already in progress.
    if (!previous.every((message, index) => messages[index]?.id === message.id)) return;
    const newest = messages[messages.length - 1];
    if (newest.direction === "outgoing" && frame.current) playSend(frame.current, newest.id);
  }, [frame, messages, send, playSend]);

  useLayoutEffect(() => {
    const root = frame.current;
    if (!root || !receiveId) return;
    const bubble = root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(receiveId)}"] [data-slot="message-bubble"]`);
    if (!bubble) return;
    running.current?.cancel();
    const indicator = root.querySelector<HTMLElement>('[data-slot="typing-indicator"]');
    const handle = playReceiveAnimation({ bubble, from: indicator?.getBoundingClientRect() ?? null, paused: receiveProgress !== undefined });
    running.current = handle;
    if (receiveProgress !== undefined) handle.seek(Math.max(0, Math.min(1, receiveProgress)) * handle.duration);
    return () => { handle.cancel(); if (running.current === handle) running.current = null; };
  }, [frame, receiveId, receiveProgress]);

  useEffect(() => () => running.current?.cancel(), []);
}

/** Progress-driven arrival wrapper kept for the harness: `progress` 0..1 maps onto the receive spring. */
export function MessageMotion({ progress = 1, direction = "incoming", className, style, ...props }: ComponentProps<"div"> & { progress?: number; direction?: "incoming" | "outgoing" }) {
  const t = Math.max(0, Math.min(1, progress));
  const k = springOffset((t * messageMotion.receive.duration) / 1000, messageMotion.receive.spring.damping, messageMotion.receive.spring.frequency);
  const p = t >= 1 ? 1 : 1 - k;
  const scale = messageMotion.receive.startScale + (1 - messageMotion.receive.startScale) * p;
  return <div data-slot="message-motion" data-progress={t.toFixed(3)} className={cn("motion-reduce:!transform-none motion-reduce:!opacity-100", direction === "outgoing" ? "origin-bottom-right" : "origin-bottom-left", className)}
    style={{ opacity: Math.min(1, t * 4), transform: t >= 1 ? undefined : `translateY(${((1 - p) * (direction === "outgoing" ? 30 : 12)).toFixed(2)}px) scale(${scale.toFixed(4)})`, ...style }} {...props} />;
}
