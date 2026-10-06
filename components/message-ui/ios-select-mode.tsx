"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * iOS 26 message selection mode, measured from `references/ios/captures/select-mode-dark.png`
 * (402×874 @3x).
 *
 * - A Ø21.67 circle sits centred on x 23.83, vertically centred on each bubble body. Unselected is
 *   a 1.67pt ring (#464649 over black); selected is a solid #0091ff disc with a 9.67 white check
 *   (1.5pt stroke).
 * - The bubbles do **not** move: the last one still ends at x 386, exactly where it sits normally.
 * - The nav bar's back button is gone; a Ø44 glass circle with a 17×17 ✕ takes its place at
 *   (364, 84), i.e. mirrored to the trailing edge.
 * - The bottom toolbar is two Ø48 glass circles centred (52, 822) and (350, 822): a 21×24 trash and
 *   a 23×19.67 forward arrow. In dark the glass body reads #191919 (rgba(28,28,28,0.9) over black)
 *   with a #f4f3f4 glyph, and its outermost ring reads #2e2e2e–#363636: the 1px inset rim.
 *
 * ## Motion: what is measured and what is not
 *
 * **Measured**: both end poses. At rest the screen is the capture above, to the point; at `t = 0`
 * every travel distance below is read off that same capture, so the circles leave from the screen's
 * own leading edge and the toolbar leaves from its own bottom edge rather than from nowhere.
 *
 * **NOT measured**: the durations, the easings, and the order things move in. No capture in this
 * repo records select mode in motion. The numbers in `selectModeMotion` are borrowed, not derived:
 *
 * - `enter` 260 / `exit` 200 with `cubic-bezier(0.32, 0.72, 0, 1)` in and `cubic-bezier(0.4, 0, 1, 1)`
 *   out are the measured "Send with effect" screen's timings (`ios-effects-picker.tsx`), which
 *   `message-reply.tsx` already reuses for the same reason.
 * - `fill` 220 with `cubic-bezier(0.2, 0.95, 0.3, 1)` is the long-press menu's spring curve from
 *   `message-actions.tsx`, at the same 220 the effects screen moves its preview rows.
 * - The close button grows from 0.86, which is the plus menu sheet's scale in `ios-plus-menu.tsx`.
 *
 * Everything animated is one number, `--ios-sel-t`, going 0 → 1: the circles slide in from the
 * leading edge and fade while the log shifts by `shift`, so the two never cross; the ✕ grows in at
 * the trailing edge of the nav bar; the toolbar rises from below while the composer it replaces goes
 * down. `active={false}` reverses all of it and then calls `onExited`.
 *
 * `progress` (0..1) seeks that timeline instead of playing it, which is what the harness scrubs. A
 * seeked frame carries no transition at all, so the same checkpoint renders identically every run;
 * the live path is a plain CSS transition, so `document.getAnimations()` can reach every part of it.
 * `prefers-reduced-motion: reduce` drops the transitions and the surface simply appears.
 *
 * The parent has to keep this mounted until `onExited`, and it has to derive that "closing" state
 * DURING RENDER, not in an effect: an effect leaves one committed frame with the rows already gone
 * and the exit never runs. `ios-messages-app.tsx` does the same for the long-press overlay.
 *
 *     const [seen, setSeen] = useState(selecting);
 *     const [closing, setClosing] = useState(false);
 *     if (seen !== selecting) { setSeen(selecting); setClosing(!selecting); }   // during render
 *     {(selecting || closing) && (
 *       <IosSelectMode active={selecting} onExited={() => setClosing(false)}>…</IosSelectMode>
 *     )}
 */

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

/**
 * `box-shadow` only accepts `none` on its own, so `none, <shadow>` drops the whole declaration and
 * the glass loses both its shadow and its rim. Every slot holds a real shadow and the unused one is
 * fully transparent. The classes are written out in full: Tailwind only compiles what it can read
 * literally in the source.
 */
const vars =
  "[--ios-sel-ring:rgba(60,60,67,0.3)] [--ios-sel-check:#ffffff] [--ios-sel-tint:#0088ff] " +
  "[--ios-sel-glass:rgba(255,255,255,0.9)] [--ios-sel-rim:0_0_0_0_rgba(0,0,0,0)] [--ios-sel-shadow:0_5px_20px_6px_rgba(0,0,0,0.055)] [--ios-sel-glyph:#1a1919] " +
  "dark:[--ios-sel-ring:#464649] dark:[--ios-sel-tint:#0091ff] " +
  "dark:[--ios-sel-glass:rgba(28,28,28,0.9)] dark:[--ios-sel-rim:inset_0_0_0_1px_rgba(255,255,255,0.09)] dark:[--ios-sel-shadow:0_0_0_0_rgba(0,0,0,0)] dark:[--ios-sel-glyph:#f4f3f4]";

/** Measured selection geometry, in points. */
export const selectionMetrics = { circleSize: 21.6667, circleCenterX: 23.8333, ringWidth: 1.6667, checkSize: 9.6667, toolbarButton: 48, toolbarCenterY: 822 } as const;

const ENTER_CURVE = [0.32, 0.72, 0, 1] as const;
const EXIT_CURVE = [0.4, 0, 1, 1] as const;
const FILL_CURVE = [0.2, 0.95, 0.3, 1] as const;
const curveText = (curve: readonly number[]) => `cubic-bezier(${curve.join(", ")})`;

/**
 * Durations and travel. The two distances are measured; the four times and three curves are not.
 * See the file comment for where each one was borrowed from.
 */
export const selectModeMotion = {
  enter: 260,
  exit: 200,
  /** One selection circle filling, or emptying. */
  fill: 220,
  ease: curveText(ENTER_CURVE),
  exitEase: curveText(EXIT_CURVE),
  fillEase: curveText(FILL_CURVE),
  /**
   * How far a circle travels. Measured: at 0 its trailing edge sits on the screen's leading edge,
   * so it is the settled centre plus its own radius.
   */
  circleSlide: selectionMetrics.circleCenterX + selectionMetrics.circleSize / 2,
  /**
   * How far the toolbar travels. Measured: the buttons' 798 top edge (centre 822 less the Ø48's
   * radius) down to the 874 screen bottom.
   */
  toolbarRise: 76,
  /** The ✕ grows from here, the plus menu sheet's scale. Not measured. */
  closeScale: 0.86,
} as const;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

/**
 * A CSS `cubic-bezier` evaluated in JS, so a seeked frame lands on the pose the played transition
 * would have been in at that fraction of its own duration. Newton first, bisection when Newton
 * wanders off the curve (which it does near a zero-slope control point like this one's `0, 1`).
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const atX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (progress: number) => {
    const p = clamp01(progress);
    if (p === 0 || p === 1) return p;
    let t = p;
    for (let i = 0; i < 8; i++) {
      const error = atX(t) - p;
      if (Math.abs(error) < 1e-7) break;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-7) break;
      t -= error / slope;
    }
    if (!(t >= 0 && t <= 1) || Math.abs(atX(t) - p) > 1e-5) {
      let low = 0, high = 1;
      for (let i = 0; i < 30; i++) {
        t = (low + high) / 2;
        if (atX(t) < p) low = t; else high = t;
      }
    }
    return ((ay * t + by) * t + cy) * t;
  };
}

const enterCurve = cubicBezier(...ENTER_CURVE);
const exitCurve = cubicBezier(...EXIT_CURVE);

/** Live, so a viewer who turns motion off mid-session gets the settled pose without a reload. */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export type SelectModeMotionProps = {
  /** True enters select mode, false plays the exit and then calls `onExited`. */
  active?: boolean;
  /**
   * Seek the transition currently running to this fraction (0..1) instead of playing it, which is
   * what the harness does. A seeked exit is a picture, not a lifecycle: it never calls `onExited`.
   */
  progress?: number;
  onExited?: () => void;
};

export type SelectModeTransition = {
  /** 0 = no select mode, 1 = settled. Published as `--ios-sel-t`; every animated style reads it. */
  t: number;
  /** `<duration> <easing>` for the direction now running, or "" when the pose is seeked or reduced. */
  timing: string;
};

const SelectModeContext = createContext<SelectModeTransition | null>(null);

/**
 * The whole entrance and exit as one number. Call it once at the top of a select-mode screen (or let
 * `IosSelectMode` do it) and every piece below picks the result up from context.
 */
export function useSelectModeTransition({ active = true, progress, onExited }: SelectModeMotionProps = {}): SelectModeTransition {
  const reduced = usePrefersReducedMotion();
  const seeking = progress !== undefined;

  // Derived DURING RENDER, not in an effect: `onExited` must fire for an open surface that closes
  // and never for one that mounted closed, and the exit has to be committed on the frame `active`
  // goes false or there is nothing left on screen to animate out.
  const [seenActive, setSeenActive] = useState(active);
  const [closing, setClosing] = useState(false);
  if (seenActive !== active) {
    setSeenActive(active);
    setClosing(!active);
  }

  const exited = useRef(onExited);
  useEffect(() => { exited.current = onExited; }, [onExited]);
  useEffect(() => {
    if (!closing || seeking) return;
    const timer = setTimeout(() => { setClosing(false); exited.current?.(); }, reduced ? 0 : selectModeMotion.exit);
    return () => clearTimeout(timer);
  }, [closing, seeking, reduced]);

  const t = seeking
    ? (active ? enterCurve(progress) : 1 - exitCurve(progress))
    : (active ? 1 : 0);
  const timing = seeking || reduced
    ? ""
    : `${active ? selectModeMotion.enter : selectModeMotion.exit}ms ${active ? selectModeMotion.ease : selectModeMotion.exitEase}`;
  return { t, timing };
}

/** `transition` for the properties given, or nothing at all when the frame is seeked. */
function transitionFor(timing: string, ...properties: string[]) {
  return timing ? properties.map(property => `${property} ${timing}`).join(", ") : undefined;
}

/** Own props win over the context, so one piece can be driven on its own inside a settled screen. */
function useSelectMotion(props: SelectModeMotionProps): SelectModeTransition {
  const own = useSelectModeTransition(props);
  const inherited = useContext(SelectModeContext);
  return props.active !== undefined || props.progress !== undefined || !inherited ? own : inherited;
}

/** The driver as inline custom properties, so a style rule elsewhere can read the same number. */
function motionVars(transition: SelectModeTransition): CSSProperties {
  return {
    "--ios-sel-t": transition.t.toFixed(4),
    "--ios-sel-transition": transition.timing ? `opacity ${transition.timing}` : "none",
  } as CSSProperties;
}

/**
 * Wrap a whole select-mode screen in this and every piece below animates together off one timeline.
 * It generates no box of its own (`display: contents`), so it can go around a screen whose children
 * are absolutely positioned in the frame's coordinates without moving any of them.
 *
 * A nav bar rendered inside it loses its back button to a cross-fade on the same timeline, which is
 * what the capture's settled state shows: no back button, a ✕ at the trailing edge instead.
 */
export function IosSelectMode({ active = true, progress, onExited, children }: SelectModeMotionProps & { children: ReactNode }) {
  const transition = useSelectModeTransition({ active, progress, onExited });
  return (
    <SelectModeContext.Provider value={transition}>
      <div data-slot="ios-select-mode" data-active={active || undefined} data-progress={transition.t.toFixed(3)} style={{ display: "contents", ...motionVars(transition) }}>
        <style>{
          '[data-slot="ios-select-mode"] [data-slot="ios-nav-bar"] [data-slot="back"]{opacity:calc(1 - var(--ios-sel-t));transition:var(--ios-sel-transition)}' +
          '[data-slot="ios-select-mode"][data-active] [data-slot="ios-nav-bar"] [data-slot="back"]{pointer-events:none}'
        }</style>
        {children}
      </div>
    </SelectModeContext.Provider>
  );
}

export type SelectionCircleProps = Omit<ComponentProps<"button">, "children" | "onChange"> & {
  selected?: boolean;
  onChange?: (next: boolean) => void;
  /** Accessible name, e.g. the message text. */
  label?: string;
  size?: number;
  /** Seek the fill (0..1) instead of transitioning it, the way `progress` seeks the entrance. */
  fillProgress?: number;
};

/**
 * The circle. Selecting fills it rather than swapping one glyph for another: the tint disc grows
 * from 0.4 out to the ring it sits inside, and the check wipes along its own path behind it. Both
 * are one number, `--ios-sel-fill`, so `fillProgress` seeks the whole thing.
 */
export function SelectionCircle({ selected = false, onChange, label, size = selectionMetrics.circleSize, fillProgress, className, style, ...rest }: SelectionCircleProps) {
  const reduced = usePrefersReducedMotion();
  const stroke = selectionMetrics.ringWidth * (size / selectionMetrics.circleSize);
  const fill = fillProgress === undefined ? (selected ? 1 : 0) : clamp01(fillProgress);
  const timing = fillProgress === undefined && !reduced ? `${selectModeMotion.fill}ms ${selectModeMotion.fillEase}` : "";
  return (
    <button type="button" data-slot="selection-circle" role="checkbox" aria-checked={selected} aria-label={label ?? (selected ? "Deselect message" : "Select message")}
      onClick={() => onChange?.(!selected)}
      className={cn("relative shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]", vars, className)}
      style={{ width: size, height: size, boxShadow: `inset 0 0 0 ${stroke}px var(--ios-sel-ring)`, "--ios-sel-fill": fill.toFixed(4), ...style } as CSSProperties}
      {...rest}>
      {/* The disc covers the ring completely at 1, which is why the ring can stay put underneath. */}
      <span aria-hidden="true" data-slot="fill" className="absolute inset-0 rounded-full"
        style={{ background: "var(--ios-sel-tint)", opacity: "var(--ios-sel-fill)", transform: "scale(calc(0.4 + 0.6 * var(--ios-sel-fill)))", transition: transitionFor(timing, "opacity", "transform") }} />
      <svg aria-hidden="true" data-slot="check" className="absolute" width={size} height={size} viewBox="0 0 21.6667 21.6667" fill="none"
        stroke="var(--ios-sel-check)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ left: 0, top: 0 }}>
        {/* `pathLength` makes the dash lengths a fraction of the stroke, so the wipe needs no
            measurement of the path and stays right at any `size`. */}
        <path d="M6 11.4 9.35 14.75 15.67 6.92" pathLength={1}
          style={{ strokeDasharray: "1px 1px", strokeDashoffset: "calc((1 - var(--ios-sel-fill)) * 1px)", opacity: "var(--ios-sel-fill)", transition: transitionFor(timing, "stroke-dashoffset", "opacity") }} />
      </svg>
    </button>
  );
}

export type MessageSelectionRowProps = Omit<ComponentProps<"div">, "onChange"> & SelectModeMotionProps & {
  selected?: boolean;
  onChange?: (next: boolean) => void;
  /** Off in the capture: bubbles keep their normal position while the circles overlay the gutter. */
  shift?: number;
  label?: string;
  circleCenterX?: number;
  /** Seek this row's fill, e.g. to screenshot a selection mid-tick. */
  fillProgress?: number;
  children: ReactNode;
};

/**
 * One row of the selection list: the circle in the left gutter plus the message itself.
 *
 * The circle is centred on the bubble **body**, not on the row. The two only agree when the row is
 * a bare bubble: a reaction balloon adds 28 of headroom above the body and a status line adds a
 * row of type below it, and in `select-mode-dark.png` neither moves the circle. The reacted "Ok"
 * bubble makes the difference visible: its body runs y 552.67–592.33 and the capture's circle is
 * centred on 572.33, which is the body's centre, while the row's centre sits 13.83 higher.
 *
 * Entering, the circle slides out of the leading edge and fades while the content moves right by
 * `shift` on the same curve, so the two are never on top of each other on the way in. `shift` is 0
 * in the capture, which makes that half of the motion a no-op unless a caller asks for it.
 */
export function MessageSelectionRow({ selected = false, onChange, shift = 0, label, circleCenterX = selectionMetrics.circleCenterX, fillProgress, active, progress, onExited, className, style, children, ...props }: MessageSelectionRowProps) {
  const transition = useSelectMotion({ active, progress, onExited });
  const size = selectionMetrics.circleSize;
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = row.current;
    if (!root) return;
    const measure = () => {
      const body = root.querySelector<HTMLElement>('[data-slot="bubble"], [data-slot="emoji"]');
      const box = root.getBoundingClientRect();
      const centre = body ? body.getBoundingClientRect().top + body.getBoundingClientRect().height / 2 - box.top : box.height / 2;
      root.style.setProperty("--ios-sel-centre", `${centre.toFixed(2)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, [children]);
  const arrived = transition.t > 0.5;
  return (
    <div ref={row} data-slot="message-selection-row" data-selected={selected || undefined}
      className={cn("relative w-full", vars, className)} style={{ fontFamily: font, ...motionVars(transition), ...style }} {...props}>
      {/* `flex` keeps the wrapper exactly as tall as the circle: an inline box would add leading and pull the centre up. */}
      <span data-slot="selection-slot" className="absolute flex" inert={!arrived}
        style={{
          left: circleCenterX - size / 2, top: "var(--ios-sel-centre, 50%)",
          transform: `translateY(-50%) translateX(calc((var(--ios-sel-t) - 1) * ${selectModeMotion.circleSlide}px))`,
          opacity: "var(--ios-sel-t)",
          transition: transitionFor(transition.timing, "transform", "opacity"),
        }}>
        <SelectionCircle selected={selected} onChange={onChange} label={label} fillProgress={fillProgress} />
      </span>
      <div data-slot="row-content"
        style={shift ? { transform: `translateX(calc(var(--ios-sel-t) * ${shift}px))`, transition: transitionFor(transition.timing, "transform") } : undefined}>
        {children}
      </div>
    </div>
  );
}

function GlassButton({ size, label, onClick, disabled = false, tabIndex, style, children }: { size: number; label: string; onClick?: () => void; disabled?: boolean; tabIndex?: number; style?: CSSProperties; children: ReactNode }) {
  return (
    // `aria-disabled` rather than `disabled`: a toolbar keeps every button reachable so the arrow
    // keys can still walk past one that has nothing to act on.
    <button type="button" aria-label={label} aria-disabled={disabled || undefined} tabIndex={tabIndex} onClick={disabled ? undefined : onClick}
      className="absolute flex items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]"
      style={{ width: size, height: size, background: "var(--ios-sel-glass)", boxShadow: "var(--ios-sel-rim), var(--ios-sel-shadow)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)", color: "var(--ios-sel-glyph)", pointerEvents: "auto", ...style }}>
      {children}
    </button>
  );
}

export type IosSelectionCloseButtonProps = Omit<ComponentProps<"div">, "children"> & SelectModeMotionProps & { onClose?: () => void };

/**
 * The ✕ that replaces the nav bar's back button, at the trailing edge (364, 84). It grows in on the
 * screen's timeline, and Escape does what tapping it does: select mode is never a place you can be
 * stuck in with only a pointer.
 */
export function IosSelectionCloseButton({ onClose, active, progress, onExited, className, style, ...props }: IosSelectionCloseButtonProps) {
  const transition = useSelectMotion({ active, progress, onExited });
  const arrived = transition.t > 0.5;
  useEffect(() => {
    if (!onClose || !arrived) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, arrived]);
  const grow = selectModeMotion.closeScale;
  return (
    // The wrapper spans the screen only so the button can be placed in its coordinates; it must not
    // swallow the taps meant for the selection circles underneath.
    <div data-slot="ios-selection-close" className={cn("pointer-events-none absolute inset-0 select-none", vars, className)}
      style={{ fontFamily: font, ...motionVars(transition), ...style }} {...props}>
      <GlassButton size={44} label="Done selecting" onClick={onClose}
        style={{
          left: 342, top: 62,
          opacity: "var(--ios-sel-t)",
          transform: `scale(calc(${grow} + ${(1 - grow).toFixed(4)} * var(--ios-sel-t)))`,
          transition: transitionFor(transition.timing, "opacity", "transform"),
          pointerEvents: arrived ? "auto" : "none",
        }}>
        {/* The capture puts the ✕ ink on x 355.0–372.0, y 76.0–93.0: a whole point of it is left of
            the circle's own centre once Blink has snapped the centred 17 box up from 355.5 to 356. */}
        <svg aria-hidden="true" width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ transform: "translateX(-1px)" }}>
          <path d="M1.1 1.1 15.9 15.9M15.9 1.1 1.1 15.9" />
        </svg>
      </GlassButton>
    </div>
  );
}

export type IosSelectionToolbarProps = Omit<ComponentProps<"div">, "children"> & SelectModeMotionProps & {
  count?: number;
  onDelete?: () => void;
  onForward?: () => void;
  /**
   * The composer row this toolbar replaces. Passed in rather than left to the caller so the two
   * cross on one timeline: the toolbar rises out of the bottom edge as the composer drops through
   * it. `ios-plus-menu.tsx` takes the same slot for the same reason.
   *
   * Hand it a composer in normal flow, not one that positions itself: the slot drops by its own
   * height, and a child that has taken itself out of flow leaves the slot no height to drop by.
   */
  composer?: ReactNode;
};

/**
 * The bottom toolbar: trash at (52, 822), forward at (350, 822), both Ø48 glass circles. It rises
 * from below the screen; give it the `composer` it replaces and that goes down as it comes up.
 */
export function IosSelectionToolbar({ count = 0, onDelete, onForward, composer, active, progress, onExited, className, style, ...props }: IosSelectionToolbarProps) {
  const transition = useSelectMotion({ active, progress, onExited });
  const arrived = transition.t > 0.5;
  const disabled = count === 0;
  // A toolbar is one tab stop; the arrow keys move between its buttons.
  const [focusIndex, setFocusIndex] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(bar.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (!buttons.length) return;
    event.preventDefault();
    const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const current = from < 0 ? focusIndex : from;
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowRight" ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
    setFocusIndex(next);
    buttons[next]?.focus();
  }
  const button = (index: number): CSSProperties => ({
    top: -24, opacity: disabled ? 0.4 : 1,
    pointerEvents: arrived ? "auto" : "none",
    left: index === 0 ? 28 : 326,
  });
  return (
    <>
      {composer !== undefined && (
        // Not `display: none` at the far end: it has to be on screen to be seen leaving, so it is
        // pushed a whole height down and made inert instead.
        <div data-slot="composer-slot" className="absolute bottom-0 left-0 w-full" inert={arrived}
          style={{
            ...motionVars(transition),
            transform: "translateY(calc(var(--ios-sel-t) * 100%))",
            opacity: "max(0, 1 - var(--ios-sel-t) * 2.5)",
            transition: transitionFor(transition.timing, "transform", "opacity"),
          }}>
          {composer}
        </div>
      )}
      <div ref={bar} data-slot="ios-selection-toolbar" role="toolbar" aria-label="Selected messages" onKeyDown={onKeyDown}
        className={cn("pointer-events-none absolute bottom-0 left-0 h-[52px] w-full select-none", vars, className)}
        style={{
          fontFamily: font, ...motionVars(transition),
          transform: `translateY(calc((1 - var(--ios-sel-t)) * ${selectModeMotion.toolbarRise}px))`,
          // Up at full strength for most of the travel, but never painted outside a frame that
          // does not clip: the fade is spent in the first 40%.
          opacity: "min(1, var(--ios-sel-t) * 2.5)",
          transition: transitionFor(transition.timing, "transform", "opacity"),
          ...style,
        }} {...props}>
        <GlassButton size={48} label={`Delete ${count} message${count === 1 ? "" : "s"}`} disabled={disabled} onClick={onDelete}
          tabIndex={focusIndex === 0 ? 0 : -1} style={button(0)}>
          <svg aria-hidden="true" width="21" height="24" viewBox="0 0 21 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: "translate(-0.6667px, -0.6667px)" }}>
            <path d="M0.8 4.8h19.4" />
            <path d="M7.2 4.8V2.6a1.8 1.8 0 0 1 1.8-1.8h3a1.8 1.8 0 0 1 1.8 1.8v2.2" />
            <path d="M2.9 4.8 4 21a2.2 2.2 0 0 0 2.2 2.2h8.6A2.2 2.2 0 0 0 17 21l1.1-16.2" />
            <path d="M7.7 9v9.4M10.5 9v9.4M13.3 9v9.4" />
          </svg>
        </GlassButton>
        <GlassButton size={48} label={`Forward ${count} message${count === 1 ? "" : "s"}`} disabled={disabled} onClick={onForward}
          tabIndex={focusIndex === 1 ? 0 : -1} style={button(1)}>
          <svg aria-hidden="true" width="23" height="19.6667" viewBox="0 0 23 19.6667" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" style={{ transform: "translateY(0.6667px)" }}>
            <path d="M13.1 0.9v4.9C5.9 6.2 1.5 10.4 0.9 18.8c2.4-4.5 6.3-6.6 12.2-6.6v4.9l9-8.1z" />
          </svg>
        </GlassButton>
      </div>
    </>
  );
}
