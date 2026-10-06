"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * "Swipe left to reveal times", measured from `references/ios/captures/swipe-timestamps-light.png`
 * (402×874 @3x).
 *
 * - Every bubble shifts left by exactly 58 (the last one's body right edge goes 386 → 328).
 * - The per-message time is 11pt secondary (#8a8a8e light / #8d8d93 dark), right-aligned with its
 *   ink ending at x 385, and its ink is centred on the bubble body's centre (measured on all eight
 *   bubbles: 235.17 / 295.5 / 339.83 / 384.17 / 464 / 572.5 / 626.5 / 686.67).
 * - iOS formats the time with a narrow no-break space before AM/PM.
 *
 * Native calls this the transcript *drawer*. Read off `+[CKUIBehaviorPhone sharedBehaviors]` with
 * `-[UIDevice userInterfaceIdiom]` swizzled to phone before ChatKit latched it:
 *
 *     transcriptDrawerGestureAcceleration  1        the drawer tracks the finger one to one
 *     transcriptDrawerFont                 .SFNS-Regular 11pt      (the 11 above)
 *     drawerTranscriptTextAttributes       11pt, Alignment Right   (the right edge above)
 *     transcriptDrawerSpace                8
 *     transcriptDrawerContactImageDiameter 32
 *     timestampsPushBalloons               0
 *     swipeToReplyConfirmThreshold         40       (the other gesture, for scale)
 *
 * and `-[CKTranscriptCollectionViewController hideTranscriptTimestampsIfNeeded]` is why a release
 * peeks back rather than latching: the drawer is held open by the gesture. `release: "latch"` keeps
 * the old toggle for a consumer that wants one.
 *
 * The drag rubber-bands past full reveal and past zero, and releasing runs a ~300 ms spring
 * (ζ 0.9, ω 20 rad/s). `prefers-reduced-motion` snaps instead. A trackpad's two-finger horizontal
 * swipe drives the same drawer (`wheel`, horizontal-dominant only, so the list keeps its scroll),
 * and keyboard users get ArrowLeft / ArrowRight (and Enter/Space to toggle) on the element the
 * hook's `handlers` are spread onto.
 */

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

/** Measured reveal geometry, in points. `timeInset` is from the screen's trailing edge. */
/** `baselineNudge` corrects Chrome's baseline, which sits two thirds of a point below native's. */
export const swipeTimesMetrics = { distance: 58, timeInset: 16, fontSize: 11, lineHeight: 13, letterSpacing: 0.1, baselineNudge: -0.6667 } as const;

/**
 * The gesture's own numbers, none of which a capture holds.
 *
 * - `slop`: travel before the drag commits to an axis. 8 px is not measured for *this* gesture: it
 *   is the travel that cancels `use-long-press`'s hold (native 8), reused so that the press hands
 *   the finger to the swipe at exactly the point it stops being a tap, with no window where both
 *   are live.
 * - `wheelIdle`: a trackpad swipe has no release to spring from, so the drawer peeks back this long
 *   after the last wheel event. UNMEASURED.
 * - `projection`: how far a release's velocity is projected before deciding a `latch`. UNMEASURED,
 *   and dead unless a consumer asks for `release: "latch"`.
 */
export const swipeTimesGesture = { slop: 8, wheelIdle: 140, projection: 0.12 } as const;

export type SwipeToRevealOptions = {
  /** How far the bubbles travel at full reveal. */
  distance?: number;
  /** Controlled 0..1. When set, every gesture is inert and the value is used verbatim. */
  progress?: number;
  /**
   * What a release does. "peek" is native — the drawer springs shut, because it was held open by
   * the gesture. "latch" settles open past `threshold` instead.
   */
  release?: "peek" | "latch";
  /** Fraction of `distance` past which a `release: "latch"` release settles open. */
  threshold?: number;
  onChange?: (open: boolean) => void;
};

/** Pointer, wheel and the click a finished swipe swallows: the gesture with no chrome around it. */
export type SwipeGestureHandlers = {
  /** Binds the non-passive `wheel` listener. React's own `onWheel` is passive and cannot cancel. */
  ref: (node: HTMLElement | null) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onClickCapture: (event: MouseEvent<HTMLElement>) => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  style: CSSProperties;
};

export type SwipeToRevealTimes = {
  /** 0 = hidden, 1 = fully revealed. May exceed 1 slightly while rubber-banding. */
  progress: number;
  /** Signed px shift for the bubble column (negative moves left). */
  offset: number;
  open: boolean;
  /** True while a finger (or a trackpad swipe) is driving the drawer. */
  dragging: boolean;
  setOpen: (next: boolean) => void;
  /**
   * The gesture alone, for a host that already owns its element's role, label and keys — a
   * scrolling log, say. Spread these and call `handlers.onKeyDown` from the host's own key handler.
   */
  gestures: SwipeGestureHandlers;
  /** Everything a standalone element needs: the gestures, the keyboard, and the group label. */
  handlers: SwipeGestureHandlers & {
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    tabIndex: number;
    role: string;
    "aria-label": string;
  };
};

/**
 * Rubber band. Inside [0, 1] the drawer tracks the finger one to one, which is ChatKit's
 * `transcriptDrawerGestureAcceleration` of 1. The quarter outside it is UNMEASURED — nothing
 * captures an overdrag — and is only there to make the two ends feel like ends.
 */
function band(raw: number) {
  if (raw < 0) return raw * 0.25;
  if (raw > 1) return 1 + (raw - 1) * 0.25;
  return raw;
}

/** A finger on the transcript, before and after it has committed to an axis. */
type SwipeDrag = { id: number; x: number; y: number; base: number; axis: "none" | "x" | "y"; lastX: number; time: number; velocity: number };

export function useSwipeToRevealTimes({ distance = swipeTimesMetrics.distance, progress: controlled, release = "peek", threshold = 0.4, onChange }: SwipeToRevealOptions = {}): SwipeToRevealTimes {
  const [value, setValue] = useState(0);
  const [dragging, setDragging] = useState(false);
  const current = useRef(0);
  const isOpen = useRef(false);
  const drag = useRef<SwipeDrag | null>(null);
  const wheel = useRef<{ raw: number; timer: ReturnType<typeof setTimeout> | null }>({ raw: 0, timer: null });
  // The click that ends a swipe is not a tap: it must not open a thread or press what it landed on.
  const swallowClick = useRef(false);
  const spring = useRef({ raf: 0, target: 0, velocity: 0, last: 0 });
  const element = useRef<HTMLElement | null>(null);

  const locked = controlled !== undefined;
  // The wheel listener is native and must never be re-bound mid-gesture, so what it reads lives
  // here rather than in its closure.
  const latest = useRef({ distance, locked, release, threshold, onChange });
  useEffect(() => { latest.current = { distance, locked, release, threshold, onChange }; });

  const write = useCallback((next: number) => { current.current = next; setValue(next); }, []);
  const stop = useCallback(() => { cancelAnimationFrame(spring.current.raf); spring.current.raf = 0; }, []);
  useEffect(() => stop, [stop]);
  useEffect(() => () => { if (wheel.current.timer) clearTimeout(wheel.current.timer); }, []);

  const settle = useCallback((target: number, velocity: number) => {
    stop();
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) { write(target); return; }
    const s = spring.current;
    s.target = target; s.velocity = velocity; s.last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.032, (now - s.last) / 1000);
      s.last = now;
      // ζ 0.9, ω 20 rad/s: about 300 ms to rest with no visible overshoot.
      s.velocity += (400 * (s.target - current.current) - 36 * s.velocity) * dt;
      const next = current.current + s.velocity * dt;
      if (Math.abs(s.target - next) < 0.0008 && Math.abs(s.velocity) < 0.01) { write(s.target); s.raf = 0; return; }
      write(next);
      s.raf = requestAnimationFrame(step);
    };
    s.raf = requestAnimationFrame(step);
  }, [stop, write]);

  /** Settle where the release asks, and only tell the caller when the answer changed. */
  const rest = useCallback((open: boolean, velocity: number) => {
    settle(open ? 1 : 0, velocity);
    if (open === isOpen.current) return;
    isOpen.current = open;
    latest.current.onChange?.(open);
  }, [settle]);

  /** End a drag or a trackpad swipe: native peeks shut, `release: "latch"` may stay open. */
  const finish = useCallback((velocity: number) => {
    const options = latest.current;
    rest(options.release === "latch" && current.current + velocity * swipeTimesGesture.projection > options.threshold, velocity);
  }, [rest]);

  const setOpen = useCallback((next: boolean) => { stop(); rest(next, 0); }, [stop, rest]);

  const endWheel = useCallback(() => {
    if (wheel.current.timer) clearTimeout(wheel.current.timer);
    wheel.current.timer = null;
    setDragging(false);
    finish(0);
  }, [finish]);

  /**
   * A trackpad's two-finger swipe. Only a horizontal-dominant wheel is the drawer's: anything else
   * is the log's vertical scroll and must be left alone, which is also why this listener is bound
   * by hand — React's `onWheel` is passive at the root and could not cancel the browser's own
   * horizontal overscroll.
   */
  const onWheel = useCallback((event: WheelEvent) => {
    const { locked: off, distance: travel } = latest.current;
    if (off || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    stop();
    const w = wheel.current;
    if (!w.timer) { w.raw = current.current; setDragging(true); }
    else clearTimeout(w.timer);
    // Swiping two fingers left scrolls right, so a positive deltaX opens the drawer, the same
    // direction a finger drags. Held one screen either side of the band so a long flick still
    // comes back promptly.
    w.raw = Math.max(-1, Math.min(2, w.raw + event.deltaX / travel));
    write(band(w.raw));
    w.timer = setTimeout(endWheel, swipeTimesGesture.wheelIdle);
  }, [stop, write, endWheel]);

  const ref = useCallback((node: HTMLElement | null) => {
    element.current?.removeEventListener("wheel", onWheel);
    element.current = node;
    node?.addEventListener("wheel", onWheel, { passive: false });
  }, [onWheel]);

  const progress = locked ? controlled : value;

  const gestures: SwipeGestureHandlers = {
    ref,
    // `pan-y` leaves the vertical scroll to the browser and keeps the horizontal axis for this
    // gesture; a drag the browser takes for a scroll arrives back here as a pointercancel.
    style: { touchAction: "pan-y", ...(dragging ? { userSelect: "none", WebkitUserSelect: "none" } : null) },
    onPointerDown(event) {
      if (locked || event.button !== 0) return;
      stop();
      // Nothing is captured and nothing moves yet: until the finger has committed to an axis this
      // is still someone else's tap, scroll or text selection.
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, base: current.current, axis: "none", lastX: event.clientX, time: performance.now(), velocity: 0 };
    },
    onPointerMove(event) {
      const d = drag.current;
      if (!d || d.id !== event.pointerId) return;
      const dx = d.x - event.clientX;
      const dy = event.clientY - d.y;
      if (d.axis === "none") {
        // Past the slop, not at it: `use-long-press` cancels its hold at *more* than the same 8, so
        // the one move that engages this gesture is also the one that cancels that one. Engaging at
        // exactly 8 would capture the pointer while the hold was still armed, and the bubble would
        // pop its actions menu half a swipe later.
        if (Math.max(Math.abs(dx), Math.abs(dy)) <= swipeTimesGesture.slop) return;
        d.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        // A mostly-vertical drag belongs to the list. Drop it whole rather than keeping its
        // sideways component, or every scroll would smear the drawer open a few pixels.
        if (d.axis === "y") { drag.current = null; return; }
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDragging(true);
        // The slop travelled while this still looked like a text drag; a highlight it started
        // would otherwise ride along with the balloons.
        const selection = typeof window === "undefined" ? null : window.getSelection();
        if (selection && !selection.isCollapsed) selection.removeAllRanges();
      }
      const now = performance.now();
      const dt = Math.max(1, now - d.time);
      d.velocity = ((d.lastX - event.clientX) / distance / dt) * 1000;
      d.lastX = event.clientX; d.time = now;
      // One to one from where the finger committed, so the slop is spent, not jumped.
      write(band(d.base + (dx - Math.sign(dx) * swipeTimesGesture.slop) / distance));
    },
    onPointerUp(event) {
      const d = drag.current;
      if (!d || d.id !== event.pointerId) return;
      drag.current = null;
      if (d.axis !== "x") return;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      setDragging(false);
      swallowClick.current = true;
      finish(d.velocity);
    },
    onPointerCancel(event) {
      const d = drag.current;
      if (!d || d.id !== event.pointerId) return;
      drag.current = null;
      if (d.axis !== "x") return;
      setDragging(false);
      finish(0);
    },
    onClickCapture(event) {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onDragStart(event) {
      // Chromium tears an image out of the page after about five pixels of mouse travel, which is
      // inside this gesture's slop: without this, a swipe that starts on a photo becomes a
      // file drag and the drawer never opens. Only while a pointer is actually down on the
      // transcript, so a drag started anywhere else is still the browser's.
      if (drag.current) event.preventDefault();
    },
  };

  const handlers: SwipeToRevealTimes["handlers"] = {
    ...gestures,
    tabIndex: 0,
    role: "group",
    "aria-label": "Conversation. Swipe left, or press the left arrow key, to show message times.",
    onKeyDown(event) {
      if (locked) return;
      // No finger to hold the drawer open, so the keyboard latches it either way.
      if (event.key === "ArrowLeft") { event.preventDefault(); setOpen(true); }
      else if (event.key === "ArrowRight" || event.key === "Escape") { event.preventDefault(); setOpen(false); }
      else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(progress < 0.5); }
    },
  };

  return { progress, offset: -progress * distance, open: progress > 0.5, dragging, setOpen, gestures, handlers };
}

export type SwipeTimesProps = Omit<ComponentProps<"div">, "children"> & {
  /** Already formatted, e.g. "1:25 AM" with a narrow no-break space. */
  time: ReactNode;
  /** 0..1 from `useSwipeToRevealTimes`. */
  progress?: number;
  distance?: number;
  /** Ink inset from the container's trailing edge. */
  timeInset?: number;
  children: ReactNode;
};

/**
 * One message row of the reveal: shifts its message left and slides the time in from the trailing
 * edge, vertically centred on the bubble body. Clip the scrolling container: at rest the time column
 * sits one full `distance` off-screen.
 */
export function SwipeTimes({ time, progress = 0, distance = swipeTimesMetrics.distance, timeInset = swipeTimesMetrics.timeInset, className, style, children, ...props }: SwipeTimesProps) {
  const t = Math.max(0, progress);
  const row = useRef<HTMLDivElement>(null);
  // Native centres the time on the bubble *body*, not on the row: a reaction balloon or a status
  // line grows the row without moving the body, and the time stays put.
  useLayoutEffect(() => {
    const root = row.current;
    if (!root) return;
    const measure = () => {
      const body = root.querySelector<HTMLElement>('[data-slot="bubble"], [data-slot="emoji"]');
      const box = root.getBoundingClientRect();
      const centre = body ? body.getBoundingClientRect().top + body.getBoundingClientRect().height / 2 - box.top : box.height / 2;
      root.style.setProperty("--swipe-centre", `${centre.toFixed(2)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, [children, time]);
  return (
    <div ref={row} data-slot="swipe-times" data-progress={t.toFixed(3)}
      className={cn("relative w-full [--ios-sw-secondary:#8a8a8e] dark:[--ios-sw-secondary:#8d8d93]", className)}
      style={style} {...props}>
      {/* At rest the row carries no transform and no `will-change` at all, which is what keeps a
          wrapped message pixel-identical to an unwrapped one. Either would layerise the row, and a
          composited layer loses subpixel text antialiasing — measured: leaving `will-change` on
          reshapes the "Delivered" label and a group avatar's initials (762 px against the group
          scene). A transform node also snaps its descendants to whole CSS px in Chrome, which is
          the same reason `ios-messages-app.tsx` keeps its screen layers transform-free at rest. */}
      <div data-slot="swipe-content" style={t > 0 ? { transform: `translateX(${(-t * distance).toFixed(2)}px)`, willChange: "transform" } : undefined}>{children}</div>
      <span data-slot="time" aria-hidden={t < 0.5 || undefined} className="pointer-events-none absolute whitespace-nowrap text-right"
        style={{
          // The column travels with the bubbles: it starts one full `distance` off the trailing edge.
          // The font lives on the time, not on the row: a row wrapped around a message must not
          // restyle the message inside it.
          fontFamily: font, right: timeInset, top: "var(--swipe-centre, 50%)",
          transform: `translate(${((1 - Math.min(1, t)) * distance).toFixed(2)}px, calc(-50% + ${swipeTimesMetrics.baselineNudge}px))`,
          fontSize: swipeTimesMetrics.fontSize, lineHeight: `${swipeTimesMetrics.lineHeight}px`, letterSpacing: swipeTimesMetrics.letterSpacing,
          color: "var(--ios-sw-secondary)", opacity: Math.max(0, Math.min(1, t * 4)),
        }}>
        {time}
      </span>
    </div>
  );
}
