"use client";

import { useEffect, useId, useRef, useState, type ComponentProps, type CSSProperties, type RefObject } from "react";
import { cn } from "@/lib/utils";

/**
 * Send-with-effect: the four bubble effects and the invisible-ink reveal.
 *
 * The three scale timelines ARE measured: `references/ios/motion/effects.md` reads the bubble's height
 * over its settled height off 60 fps recordings of the iOS 26 simulator, and every offset below is one
 * of those times divided by the duration. What is still not measured, and is called out where it
 * appears: the rotation on Slam, the sideways jitter on Loud, the handful of steps between two
 * measured frames, and the screen effects. The screen that chooses an effect is measured too, in
 * `ios-effects-picker.tsx`, and so is the look of the Invisible Ink preview it shows.
 */
export type BubbleEffectKind = "slam" | "loud" | "gentle" | "invisible-ink";

export const bubbleEffects: Array<{ kind: BubbleEffectKind; title: string; description: string }> = [
  { kind: "slam", title: "Slam", description: "Drops the bubble onto the conversation and shakes it." },
  { kind: "loud", title: "Loud", description: "Blows the bubble up, then lets it settle." },
  { kind: "gentle", title: "Gentle", description: "Arrives small and grows to size." },
  { kind: "invisible-ink", title: "Invisible Ink", description: "Hides the message until it is revealed." },
];

/**
 * Total duration of each bubble effect, in ms, measured from 60 fps recordings of the iOS 26
 * simulator sending with each effect (`references/ios/motion/effects.md`). Invisible Ink has no
 * motion of its own: the message simply arrives covered.
 *
 * Slam and Gentle are timed from the frame the effects screen leaves, so their first 50 and 200 ms
 * are the send flight and the bubble is not on screen yet. Loud is timed from the first frame the
 * bubble is visible, 117 ms after the screen leaves, so it starts at full opacity and its 1230 ms sit
 * after that flight rather than containing it.
 */
export const bubbleEffectDuration: Record<BubbleEffectKind, number> = { slam: 640, loud: 1230, gentle: 3000, "invisible-ink": 0 };

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Keyframes traced from those recordings. Each `offset` is the measured time in ms divided by the
 * duration above, to four places, which lands every one within 0.05 ms of its frame; the Slam impact
 * is the one exception and carries its exact fraction, for the reason given there. Each scale is the
 * bubble's measured height over its settled height. `easing: "linear"` keeps the curve between two
 * keyframes a straight line, so seeking to a measured time renders that measured scale, and every
 * measured frame reads back within 0.002 of the table. A step with no frame behind it is interpolated
 * between its neighbours and is called out where it appears.
 */
function keyframes(kind: BubbleEffectKind): Keyframe[] {
  switch (kind) {
    case "slam":
      // Arrives far oversized and shrinking fast, lands squashed at 0.92, rebounds to 1.07, settles.
      // Frames at 50 (7.7, and clipped by the screen, so that is a lower bound), 233, 267, 300, 333,
      // 367, 400, 467, 533 and 633 ms. Two steps are not measured: the scale 8 it starts at, which is
      // off the screen before the bubble is visible at all, and the 2.6 at 288 ms, because the
      // recording jumps 4.67 -> 0.92 between two frames and that is the slam itself.
      return [
        { offset: 0, transform: "scale(8) rotate(-4deg)", opacity: 0 },
        { offset: 0.0521, opacity: 0 },
        { offset: 0.0781, transform: "scale(7.7) rotate(-3.4deg)", opacity: 1 },
        { offset: 0.3641, transform: "scale(5.1) rotate(-1.4deg)" },
        { offset: 0.4172, transform: "scale(4.67) rotate(-1deg)" },
        { offset: 0.45, transform: "scale(2.6) rotate(-0.4deg)" },
        // 300/640 exactly. The impact is falling 0.14 of scale per ms, a hundred times faster than any
        // other stretch of any of these curves, so rounding this one offset to four places would land
        // the 0.92 a thirtieth of a millisecond late and read 0.925 at 300 ms.
        { offset: 0.46875, transform: "scale(0.92) rotate(0deg)" },
        { offset: 0.5203, transform: "scale(0.95)" },
        { offset: 0.5734, transform: "scale(1)" },
        { offset: 0.625, transform: "scale(1.02)" },
        { offset: 0.7297, transform: "scale(1.07)" },
        { offset: 0.8328, transform: "scale(1.05)" },
        { offset: 0.9891, transform: "scale(1)" },
        { offset: 1, transform: "scale(1)" },
      ];
    case "loud":
      // Starts a third of size, blows past twice its size, shakes at the top, then falls back. Frames
      // at 0, 33, 83, 183, 283, 350, 450, 550, 683, 783, 883, 1033 and 1233 ms on a clock that starts
      // where the bubble becomes visible, so it opens at 0.32 with no fade. The sideways jitter is the
      // shake the recording shows on top of the growth, and the 1.05 at 1144 ms is interpolated: the
      // recording has no frame between 1033 and the settle.
      return [
        { offset: 0, transform: "scale(0.32)" },
        { offset: 0.0268, transform: "scale(0.58)" },
        { offset: 0.0675, transform: "scale(1.02)" },
        { offset: 0.1488, transform: "scale(1.75) translateX(-4px)" },
        { offset: 0.2301, transform: "scale(2.12) translateX(4px)" },
        { offset: 0.2846, transform: "scale(2.23) translateX(-3px)" },
        { offset: 0.3659, transform: "scale(2.35) translateX(3px)" },
        { offset: 0.4472, transform: "scale(2.27) translateX(-2px)" },
        { offset: 0.5553, transform: "scale(2.32) translateX(2px)" },
        { offset: 0.6366, transform: "scale(2.2) translateX(0)" },
        { offset: 0.7179, transform: "scale(1.87)" },
        { offset: 0.8398, transform: "scale(1.25)" },
        { offset: 0.93, transform: "scale(1.05)" },
        { offset: 1, transform: "scale(1)" },
      ];
    case "gentle":
      // Arrives at a third of size, overshoots slightly, then takes seconds to relax into place.
      // Frames at 200 (the first one the bubble is on screen), 233, 300, 400, 533, the hold through
      // 1250, then 1983, 2583 and the settle at 3083, which is 83 ms past this duration and lands on
      // the last keyframe instead. The 1.18 at 1650 ms is interpolated: nothing is measured between
      // the end of the hold and 1983.
      return [
        { offset: 0, transform: "scale(0.38)", opacity: 0 },
        { offset: 0.0611, opacity: 0 },
        { offset: 0.0667, transform: "scale(0.38)", opacity: 1 },
        { offset: 0.0777, transform: "scale(0.65)" },
        { offset: 0.1, transform: "scale(0.85)" },
        { offset: 0.1333, transform: "scale(1.13)" },
        { offset: 0.1777, transform: "scale(1.25)" },
        { offset: 0.4167, transform: "scale(1.25)" },
        { offset: 0.55, transform: "scale(1.18)" },
        { offset: 0.661, transform: "scale(1.1)" },
        { offset: 0.861, transform: "scale(1.05)" },
        { offset: 1, transform: "scale(1)" },
      ];
    default:
      return [{ opacity: 1 }, { opacity: 1 }];
  }
}

export type BubbleEffectHandle = { seek(ms: number): void; play(): void; cancel(): void; readonly duration: number };

/**
 * Runs a bubble effect on an element. Pass `progress` (0..1) to scrub instead of play, which is what
 * the harness timeline does. Under reduced motion the element simply appears.
 */
export function playBubbleEffect(element: HTMLElement, kind: BubbleEffectKind, options: { progress?: number; origin?: string } = {}): BubbleEffectHandle {
  const duration = bubbleEffectDuration[kind];
  if (kind === "invisible-ink" || duration === 0 || prefersReducedMotion()) {
    element.style.transform = "";
    return { seek() {}, play() {}, cancel() {}, duration: 0 };
  }
  // The recordings keep the bubble pinned at its trailing bottom corner while everything else about it
  // grows (in the Loud capture the bottom edge stays within 785-793 for the whole 1230 ms), so that
  // corner is the origin: bottom right for an outgoing bubble, bottom left for an incoming one. The
  // direction sits on an ancestor when the effect runs on a bubble frame and on a descendant when a
  // `BubbleEffect` wraps a whole bubble, so look both ways; looking up alone left the wrapper scaling
  // out of its bottom left corner and dragging an outgoing bubble off the screen.
  const direction = element.closest("[data-direction]")?.getAttribute("data-direction")
    ?? element.querySelector("[data-direction]")?.getAttribute("data-direction");
  element.style.transformOrigin = options.origin ?? (direction === "outgoing" ? "100% 100%" : "0% 100%");
  const animation = element.animate(keyframes(kind), { duration, easing: "linear", fill: "both" });
  if (options.progress === undefined) animation.play();
  else { animation.pause(); animation.currentTime = Math.max(0, Math.min(1, options.progress)) * duration; }
  return {
    seek(ms) { animation.pause(); animation.currentTime = Math.max(0, Math.min(duration, ms)); },
    play() { animation.play(); },
    cancel() { animation.cancel(); element.style.transform = ""; },
    duration,
  };
}

/** Declarative wrapper: runs `kind` on its child whenever `kind` or `replay` changes. */
export function BubbleEffect({ kind, progress, replay, children, className, style, ...props }: ComponentProps<"div"> & { kind?: BubbleEffectKind; progress?: number; replay?: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element || !kind) return;
    const handle = playBubbleEffect(element, kind, { progress });
    return () => handle.cancel();
  }, [kind, progress, replay]);
  return <div ref={host} data-slot="bubble-effect" data-effect={kind} className={cn("will-change-transform", className)} style={style} {...props}>{children}</div>;
}

/**
 * Invisible Ink: the message is covered by drifting particles until it is revealed. Native reveals on
 * touch or a pointer pass and hides again after a moment; `revealed` lets an app control that instead.
 */
/**
 * iOS 26 offers eight, in this order. The Screen tab's page dots confirm the count: eight dots, and
 * swiping past Celebration goes nowhere (`references/ios/motion/effects.md`). Shooting Star, which
 * earlier releases had, is gone.
 */
export type ScreenEffectKind = "echo" | "spotlight" | "balloons" | "confetti" | "love" | "lasers" | "fireworks" | "celebration";

export const screenEffects: Array<{ kind: ScreenEffectKind; title: string }> = [
  { kind: "echo", title: "Echo" },
  { kind: "spotlight", title: "Spotlight" },
  { kind: "balloons", title: "Balloons" },
  { kind: "confetti", title: "Confetti" },
  { kind: "love", title: "Love" },
  { kind: "lasers", title: "Lasers" },
  { kind: "fireworks", title: "Fireworks" },
  { kind: "celebration", title: "Celebration" },
];

/**
 * One deterministic 1-bit speckle tile, 64 px square with 15% of its pixels opaque. It is an image
 * rather than an SVG filter so every engine rasterises the same specks and a screenshot stays
 * comparable, and it is a single layer because two composited mask layers do not agree across
 * engines: `mask-composite: intersect` reads as "intersect with nothing" for the first layer in
 * WebKit and masks the text away entirely.
 */
const inkTile = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAQAAAAAYLlVAAADkklEQVR42q1ZSXLDMAwj9P8/o4ckNheQkpP60Jk6WrkAIA3a9dBg8aHZ9a7+mucxjOUw071ZcsHPg2tpS4vQ/UXZBmaGa0w9uHuz0kJ1K78Fr8MhLdTd0tvBX47xAPHsDFawdK9spXgnilsyjGN8v9w/dINuAzLEA6sRwyZId0SxFqKTVtjUm+pjwHhmiANX/99HoYwtNxbUQQj5RmfClB/W/vaet+RPSKfFsL01h5oc5eatYhi6JMoRYMNN9aFQAtM7ji8XcFi6Mx1Hm5yvyHWdi+IubFMOjU3YOqWOo5lhJczD1rva+Dx0TcGN6gIKcKUEXNtwg5pb5q+A2taQDxKM9HdjQlOPJAhh+Hb6Cwd293oSpizxMc7+AFEmTx5FwD88q4QbChGroOKxPaZVkh6gZK+Z/SxQFo/gOISojwFu1M83gLVdYTmIxJD/lPZRyoFFqNU3KQjrzZlimC3h4MACo+WWCEArJ4Vkdh+o3LAkHTJ4ecczHOhjoNrnIVauI3zrko9BJ57yR7DwElpXp6Xy+BOFULkQtws6k/KQgviAqmQaxjt2Qbm/p6e1qKisQ8QlbmGlDOEovOiyBIH3ICSZRYevIMo73sc2EKd4wE6SWRNeKPFNkTGQuMgNM1yzwVle9vn9RcBpLkCbgGxBlxLnzlAj4qKrjGYGZKgY8VA7dTzLlyqeFkWqjOEiY8L/E7XMSkadet+TzUxEUEXZ6yqriVlugfVMniGBGzpROmkYto0a6dWDOrntEUE0HCr/W+kjRKyg7DbV3oOwwHMNyAfFeUtGXRcDm9xmqnT8W5RmzaYwsa/Q8DdcDFyQPNNgGwaM46Zm5FwZearhVudAeBuj21Sl1UAxj1JtauuyKUylmxQO8KeyNB9PF7vXiCVugAG7ufNpsc64vcKB76xwlh9MB+TdI2JpWe9Qn1vMUNIui94gyWJLRnW3McQ1H9QGDqLvDsmeaPqA49jI1aL2nfbg9/F9HhVDJqyt8KCAm51GyFshOC2MXaEeYkvIVr4fYC46pQYSbtm7gI8lqBKzAxuqfuhZ7ws/s2FQxdFHbDsbFrRx7RjxcGt+cACDN3OxmSXXDMJTU/tqjq/jvvZtagwH7b4qoYOoXzQhT/vB05g11LJo2YBtwFJ+7utYJvQHnkQ+2lIVbgTbj2DuIL5R6RGd8pvXr/3zplWLJEfYfHDDIUJw6CFtJNnZt799I/sBZf0Bkk4FKDOrOUwAAAAASUVORK5CYII=";

const inkMask: CSSProperties = {
  maskImage: `url(${inkTile})`,
  maskSize: "64px 64px",
  maskRepeat: "repeat",
  WebkitMaskImage: `url(${inkTile})`,
  WebkitMaskSize: "64px 64px",
  WebkitMaskRepeat: "repeat",
  animation: "im-ink-drift 5200ms linear infinite",
};

const inkKeyframes = `
@keyframes im-ink-drift {
  from { mask-position: 0 0; -webkit-mask-position: 0 0; }
  to { mask-position: 64px -64px; -webkit-mask-position: 64px -64px; }
}
/* The drift runs on whatever the mask lands on, which is the text slot rather than the wrapper that
   carries [data-ink-masked], so the reduced-motion rule has to name all three or it stops nothing. */
@media (prefers-reduced-motion: reduce) {
  [data-slot="invisible-ink"] :is([data-ink-masked], [data-slot="text"], [data-slot="ink-target"]) { animation: none !important; }
}
`;

/**
 * Invisible Ink: the message's text dissolves into drifting specks until it is revealed, and the
 * bubble itself stays where it is. Native reveals on touch or a pointer pass and hides again after a
 * moment; `revealed` lets an app control that instead.
 *
 * The mask lands on the bubble's `[data-slot="text"]` (or anything marked `data-slot="ink-target"`),
 * so the fill, the tail and any reactions keep drawing normally. Content with neither gets masked
 * whole, which is the right fallback for a plain string.
 */
export function InvisibleInk({ revealed, onRevealChange, children, className, style, ...props }: Omit<ComponentProps<"div">, "onChange"> & { revealed?: boolean; onRevealChange?: (revealed: boolean) => void }) {
  const [internal, setInternal] = useState(false);
  const open = revealed ?? internal;
  const id = useId();
  const scope = `ink-${id.replace(/[^a-zA-Z0-9]/g, "")}`;
  const set = (next: boolean) => { if (revealed === undefined) setInternal(next); onRevealChange?.(next); };

  const filterId = `${scope}-spread`;
  // Camel case to CSS, keeping the `-webkit-` prefix intact: Safari still needs the prefixed
  // mask properties, and its `mask-composite` takes the legacy keywords.
  const cssName = (key: string) =>
    key.startsWith("Webkit")
      ? `-webkit-${key.slice(6).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).replace(/^-/, "")}`
      : key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  const declarations = Object.entries(inkMask).map(([key, value]) => `${cssName(key)}:${value}`).join(";");

  return (
    <div data-slot="invisible-ink" data-revealed={open} className={cn("relative", scope, className)} style={style} {...props}>
      {!open && (
        <svg aria-hidden="true" width="0" height="0" className="absolute" focusable="false">
          <filter id={filterId} x="-25%" y="-40%" width="150%" height="180%" colorInterpolationFilters="sRGB">
            {/* Spread each glyph into a cloud, then push the cloud's alpha back up so the specks the
                mask leaves behind are as bright as the text was. Native emits one particle per glyph
                pixel and lets them drift, which is what this approximates. */}
            <feGaussianBlur stdDeviation="1.3" />
            <feComponentTransfer><feFuncA type="linear" slope="3.6" intercept="-0.42" /></feComponentTransfer>
          </filter>
        </svg>
      )}
      {!open && (
        <style>{`${inkKeyframes}
.${scope} :is([data-slot="text"], [data-slot="ink-target"]) { ${declarations};filter:url(#${filterId}) }
.${scope}:not(:has([data-slot="text"], [data-slot="ink-target"])) > div:first-of-type { ${declarations};filter:url(#${filterId}) }`}</style>
      )}
      <div data-ink-masked={open ? undefined : ""}>{children}</div>
      {!open && (
        <button type="button" aria-label="Reveal message sent with Invisible Ink" aria-describedby={`${id}-hint`}
          onClick={() => set(true)} onPointerEnter={() => set(true)} onFocus={() => set(true)}
          className="absolute inset-0 cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]">
          <span id={`${id}-hint`} className="sr-only">Hidden with Invisible Ink. Activate to reveal.</span>
        </button>
      )}
    </div>
  );
}

/** Convenience: run a bubble effect on the message row with `data-message-id={id}` inside `frame`. */
export function useBubbleEffectOnMessage(frame: RefObject<HTMLElement | null>, effect: { id: string; kind: BubbleEffectKind; progress?: number; replayNonce?: number } | null | undefined) {
  useEffect(() => {
    if (!effect) return;
    const element = frame.current?.querySelector<HTMLElement>(`[data-message-id="${effect.id}"] [data-slot="bubble-frame"]`);
    if (!element) return;
    const handle = playBubbleEffect(element, effect.kind, { progress: effect.progress });
    return () => handle.cancel();
  }, [frame, effect]);
}
