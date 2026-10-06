"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The popover that opens downward from the composer's "+" button in macOS 26 Messages.
 * Measured from `references/macos/captures/plus-menu-dark-2x.png` / `plus-menu-light-2x.png` (window
 * x 330–530, y 580–850 at 2x), in pane coordinates:
 * - box: left 9 (flush with the "+" button), top 626 (it overlaps the button's bottom 3 pt), 175×214,
 *   corner radius 12 (circle fit R 24 px, rmse 1.2 px). It hangs 200 pt below the window's bottom edge.
 * - edge: a 1 pt bright inset rim (dark ≈ #61696e over #252728, light ≈ #f8fcfe) and a 0.5 pt dark outline
 *   outside it (dark #050505, light ≈ #b8b8b8).
 * - fill: translucent glass, dark ≈ #252728, light ≈ #edeff0 (blurred content shows through).
 * - rows: 5 pt top/bottom padding, six rows 34 tall; Ø20 app icon at x 20, 13 pt label at x 50
 *   ("Photos" ink 81 px, "Image Playground" 213 px at 2x: untracked, unlike the composer text),
 *   dark #dddddd / light #242424.
 *
 * THE MOTION IS NOT MEASURED. No capture in `references/` records this popover opening or closing,
 * so nothing about its timing can be read off a frame. What *is* measured is the pose at each end,
 * which is the part that decides whether it reads as native: it grows out of the "+" button's own
 * corner, because the captures put the menu's left edge on the button's left edge (both at pane x 9)
 * and its top edge 3 pt inside the button's bottom, and it lands on the settled box above with the
 * transform back at exactly 1 and nothing left to settle. Every number in `motion` is borrowed from
 * a transition the kit already ships, or invented:
 * - exit: 120 ms on cubic-bezier(0.4, 0, 1, 1). Copied from `context-menu.tsx`'s macOS dismissal,
 *   which is SPEC's "macOS menu dismiss ... fade and settle back, ~120 ms".
 * - enter: cubic-bezier(0.2, 0.8, 0.3, 1), the curve `macos-messages-app.tsx` opens the macOS
 *   context menu on, itself a softened form of the long-press menu's cubic-bezier(0.2, 0.95, 0.3, 1)
 *   spring in `message-actions.tsx`.
 * - the 160 ms the entrance takes is invented. It is longer than the exit on purpose: an AppKit menu
 *   leaves faster than it arrives.
 * - the 0.96 it grows from is `macTransitions.menu.scale`, the same scale the app shell's popovers
 *   grow from, so the two macOS popovers move alike. Which corner it grows from is measured; how
 *   much it grows is not.
 */
export const macPlusMenuMetrics = {
  left: 9,
  top: 626,
  width: 175,
  height: 214,
  radius: 12,
  paddingY: 5,
  row: { height: 34, iconLeft: 20, iconSize: 20, labelLeft: 50, fontSize: 13, letterSpacing: 0 },
  /** Presentation motion. Unverified: see the note above for where each number came from. */
  motion: {
    enter: 160,
    exit: 120,
    enterEase: "cubic-bezier(0.2, 0.8, 0.3, 1)",
    exitEase: "cubic-bezier(0.4, 0, 1, 1)",
    /** How small it is at the anchor corner, at each end of the fade. */
    scale: 0.96,
  },
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

const reducedMotionQuery = () => (typeof window === "undefined" ? null : window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null);
function subscribeReducedMotion(onChange: () => void) {
  const query = reducedMotionQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}
/**
 * True when the viewer asked for less motion; false while server rendering. `use-long-press.ts` has
 * the same hook, and this file keeps its own copy so the menu stays a registry item with no
 * dependency of its own.
 */
function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, () => reducedMotionQuery()?.matches ?? false, () => false);
}

/**
 * The hover highlight is painted from here rather than from a `hover:` class so it can be gated on
 * the menu's own state. While the box is still growing or shrinking the rows slide under a
 * stationary cursor, and a plain `:hover` would strobe from row to row; AppKit does not highlight
 * anything until the menu is up. Keyboard focus is not gated: it never moves under the pointer.
 */
const rowHighlightCss = `[data-slot="plus-menu"] [data-slot="plus-menu-item"]{transition:background-color 60ms linear}
[data-slot="plus-menu"][data-state="open"] [data-slot="plus-menu-item"]:hover{background:var(--pm-hover)}
[data-slot="plus-menu"] [data-slot="plus-menu-item"]:focus-visible{background:var(--pm-hover)}
@media (prefers-reduced-motion: reduce){[data-slot="plus-menu"] [data-slot="plus-menu-item"]{transition:none}}`;

export type PlusMenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
};

export const defaultPlusMenuItems: PlusMenuItem[] = [
  { id: "photos", label: "Photos" },
  { id: "stickers", label: "Stickers" },
  { id: "genmoji", label: "Genmoji" },
  { id: "image-playground", label: "Image Playground" },
  { id: "images", label: "#images" },
  { id: "message-effects", label: "Message Effects" },
];

export type MacPlusMenuProps = Omit<ComponentProps<"div">, "onSelect"> & {
  /** False plays the dismissal; the menu stays mounted until it is over and then calls `onExited`. */
  open?: boolean;
  onExited?: () => void;
  /**
   * Seek the presentation to this fraction (0..1) instead of playing it, which is what the harness
   * does. It seeks whichever direction `open` selects, and a seeked dismissal never fires `onExited`:
   * scrubbing a timeline is not a dismissal, and the frame has to be the same on every run.
   */
  progress?: number;
  items?: PlusMenuItem[];
  onSelect?: (id: string) => void;
  onClose?: () => void;
  /** Position of the menu's top-left corner in the containing block, in px. Defaults to the measured spot. */
  left?: number;
  top?: number;
  /** Focus the first item when the menu opens (keyboard users). */
  autoFocus?: boolean;
};

export function MacPlusMenu({ open = true, onExited, progress, items = defaultPlusMenuItems, onSelect, onClose, left = macPlusMenuMetrics.left, top = macPlusMenuMetrics.top, autoFocus = false, className, style, ...props }: MacPlusMenuProps) {
  const m = macPlusMenuMetrics;
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  /**
   * The menu has to outlive the prop that dismissed it or the dismissal never gets a frame to run
   * in. `shown` is therefore derived here, DURING RENDER, and not in an effect: an effect would
   * leave one committed frame with the element already unmounted and the exit would never play.
   * `ios-messages-app.tsx` derives its overlays the same way.
   */
  const [seenOpen, setSeenOpen] = useState(open);
  const [shown, setShown] = useState(open);
  const [settled, setSettled] = useState(open && reduced);
  if (seenOpen !== open) {
    setSeenOpen(open);
    if (open) { setShown(true); setSettled(reduced); }
    // Under reduced motion there is no dismissal to wait for, so the menu goes in the same frame.
    else if (reduced) setShown(false);
  }
  const closing = shown && !open;
  const state = closing ? "closing" : reduced || settled || (progress !== undefined && clamp01(progress) === 1) ? "open" : "entering";

  /**
   * Natively this is a separate popover window, so it hangs 200 pt below the app window onto the
   * desktop, which is the placement the captures measure. Inside a fixed device frame there is no
   * desktop, so it flips above the button when it would be cut off, which is what a real popover
   * does at the bottom of a screen. What decides that is the first ancestor that actually hides its
   * overflow, not the offsetParent: the offsetParent is the window's own box, and a menu that hangs
   * past it is exactly what the captures show.
   */
  const [flipped, setFlipped] = useState(false);
  useLayoutEffect(() => {
    const parent = list.current?.offsetParent as HTMLElement | null;
    if (!shown || !parent) return;
    const bottomIfBelow = parent.getBoundingClientRect().top + parent.clientTop + top + m.height;
    let limit = typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerHeight;
    for (let frame: HTMLElement | null = parent; frame; frame = frame.parentElement) {
      if (getComputedStyle(frame).overflowY === "visible") continue;
      limit = Math.min(limit, frame.getBoundingClientRect().bottom);
      break;
    }
    setFlipped(bottomIfBelow > limit + 0.5);
  }, [shown, top, m.height]);
  const resolvedTop = flipped ? top - (m.height + 24) : top;

  // Callbacks live in refs so a caller passing inline arrows cannot re-arm the listeners, or the
  // dismissal, on every render.
  const exited = useRef(onExited);
  const close = useRef(onClose);
  useEffect(() => { exited.current = onExited; close.current = onClose; });

  /**
   * The presentation. It grows out of the "+" button's corner, so the origin follows the flip: the
   * menu's top-left corner is the button's own left edge just below it, and a flipped menu grows up
   * from its bottom-left instead. Both ends are the measured layout; only the curve between them is
   * invented. Under `prefers-reduced-motion` no animation is created at all, so the menu is simply
   * there and simply gone.
   */
  useEffect(() => {
    const element = list.current;
    if (!element || !shown) return;
    const t = m.motion;
    if (open) {
      if (reduced) return;
      const entrance = element.animate(
        [{ opacity: 0, transform: `scale(${t.scale})` }, { opacity: 1, transform: "scale(1)" }],
        { duration: t.enter, easing: t.enterEase, fill: "both" },
      );
      if (progress !== undefined) {
        // Seeked, not played: a scrubbed checkpoint has to land on the same frame every run.
        entrance.pause();
        entrance.currentTime = clamp01(progress) * t.enter;
        return () => entrance.cancel();
      }
      const done = () => setSettled(true);
      entrance.addEventListener("finish", done);
      return () => { entrance.removeEventListener("finish", done); entrance.cancel(); };
    }
    const exit = element.animate(
      [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: `scale(${t.scale})` }],
      { duration: t.exit, easing: t.exitEase, fill: "both" },
    );
    if (progress !== undefined) {
      exit.pause();
      exit.currentTime = clamp01(progress) * t.exit;
      return () => exit.cancel();
    }
    const gone = () => setShown(false);
    exit.addEventListener("finish", gone);
    return () => {
      exit.removeEventListener("finish", gone);
      // Reopened mid-dismissal: drop the fold so it cannot hold a stale pose under the entrance.
      if (exit.playState !== "finished") exit.cancel();
    };
  }, [shown, open, progress, reduced, m.motion]);

  // One place fires `onExited`, whether the menu left on the animation or under reduced motion.
  const wasShown = useRef(shown);
  useEffect(() => {
    if (wasShown.current && !shown) exited.current?.();
    wasShown.current = shown;
  }, [shown]);

  useEffect(() => {
    // A scrubbed entrance must not move the caret: the harness seeks frames, it does not open menus.
    if (!open || !autoFocus || progress !== undefined) return;
    // The menu takes the focus, not its first row: a row focused programmatically while the pointer
    // that opened the menu is still down matches `:focus-visible` in Chrome and WebKit alike - the
    // gesture has not resolved, so the modality is still the keyboard default - and paints a ring on
    // a menu opened with a mouse. `onKeyDown` is on this element, so every key still arrives, and
    // the first arrow moves to a row where the ring is correct. See `tapback-bar.tsx`.
    list.current?.focus({ preventScroll: true });
  }, [open, autoFocus, progress]);

  /**
   * A menu is dismissed by Escape from wherever focus happens to be, and by a click anywhere outside
   * it. The control that opened it is the exception: it owns the toggle, so closing here as well
   * would close the menu and let its own click reopen it in the same gesture.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      // Nothing to dismiss to: leave the key for whatever else is listening.
      if (event.key !== "Escape" || !close.current) return;
      event.preventDefault();
      close.current();
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node | null;
      if (!close.current || !target || list.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-slot="attach-button"], [aria-haspopup="menu"]')) return;
      close.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      // -1 while the focus is still on the menu itself, which is where it starts: Down goes to the
      // first row and Up to the last. Wrapping arithmetic on -1 reaches neither.
      if (index < 0) buttons[event.key === "ArrowDown" ? 0 : buttons.length - 1]?.focus();
      else buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
    if (event.key === "Home") { event.preventDefault(); buttons[0]?.focus(); }
    if (event.key === "End") { event.preventDefault(); buttons[buttons.length - 1]?.focus(); }
  }

  if (!shown) return null;

  return (
    <div
      ref={list}
      data-slot="plus-menu"
      data-placement={flipped ? "above" : "below"}
      data-state={state}
      role="menu"
      aria-labelledby={`${id}-label`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute z-40 select-none bg-[var(--pm-fill)] text-[var(--pm-text)] shadow-[var(--pm-edge)]",
        "[--pm-edge:inset_0_0_0_1px_rgba(255,255,255,0.8),0_0_0_0.5px_rgba(0,0,0,0.28),0_4px_16px_rgba(0,0,0,0.12)] [--pm-fill:rgba(238,240,241,0.92)] [--pm-hover:rgba(0,0,0,0.06)] [--pm-text:#242424]",
        "dark:[--pm-edge:inset_0_0_0_1px_rgba(255,255,255,0.28),0_0_0_0.5px_rgba(0,0,0,0.85),0_4px_16px_rgba(0,0,0,0.35)] dark:[--pm-fill:rgba(37,39,40,0.94)] dark:[--pm-hover:rgba(255,255,255,0.08)] dark:[--pm-text:#dddddd]",
        className,
      )}
      style={{
        left, top: resolvedTop, width: m.width, minHeight: m.height, borderRadius: m.radius, padding: `${m.paddingY}px 0`,
        // The rows are full-bleed, so a hovered first or last row paints a square corner about 2.25 pt
        // past the menu's rounded one unless the menu clips them. The clip is in the menu's own box,
        // so the scale rides on top of it and the corner stays round mid-animation.
        overflow: "hidden",
        // The corner the menu grows out of, which is the corner it is anchored by: below the "+"
        // button it is the top-left, and a flipped menu grows up from the bottom-left instead.
        transformOrigin: flipped ? "0% 100%" : "0% 0%",
        // Nothing is clickable while it is folding away, so a dismissal cannot pick a row by accident.
        pointerEvents: closing ? "none" : undefined,
        backdropFilter: "blur(30px)", WebkitBackdropFilter: "blur(30px)",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif", ...style,
      }}
      {...props}
    >
      <style>{rowHighlightCss}</style>
      <span id={`${id}-label`} className="sr-only">Attachments</span>
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          data-slot="plus-menu-item"
          data-item={item.id}
          onClick={() => { onSelect?.(item.id); onClose?.(); }}
          className="relative block w-full bg-transparent p-0 text-left outline-none"
          style={{ height: m.row.height }}
        >
          <span aria-hidden="true" className="absolute" style={{ left: m.row.iconLeft, top: (m.row.height - m.row.iconSize) / 2, width: m.row.iconSize, height: m.row.iconSize }}>
            {item.icon ?? <PlusMenuIcon id={item.id} size={m.row.iconSize} />}
          </span>
          <span data-slot="plus-menu-label" className="absolute whitespace-nowrap" style={{ left: m.row.labelLeft, top: 0, lineHeight: `${m.row.height}px`, fontSize: m.row.fontSize, letterSpacing: m.row.letterSpacing }}>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Small look-alikes of the native app icons, drawn as SVG in a 20×20 box. */
export function PlusMenuIcon({ id, size = 20 }: { id: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 20 20", "aria-hidden": true as const, className: "block" };
  switch (id) {
    case "photos": {
      const petals = ["#f7c945", "#f59a3b", "#ef5a5a", "#e8558f", "#a765d4", "#4f8ef0", "#3fbbd0", "#78c45a"];
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="10" fill="#ffffff" />
          <circle cx="10" cy="10" r="9.4" fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth="0.6" />
          {petals.map((color, index) => (
            <ellipse key={color} cx="10" cy="6.7" rx="2.2" ry="3.4" fill={color} fillOpacity="0.85" transform={`rotate(${index * 45} 10 10)`} />
          ))}
        </svg>
      );
    }
    case "stickers":
      return (
        <svg {...common}>
          <defs>
            <linearGradient id="pm-sticker" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#d7c9f6" /><stop offset="0.55" stopColor="#a7b6f0" /><stop offset="1" stopColor="#8fc4ef" /></linearGradient>
            <linearGradient id="pm-sticker-peel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#c9cff8" /></linearGradient>
          </defs>
          <path d="M10 .5a9.5 9.5 0 1 0 9.5 9.5c0-.4 0-.8-.1-1.2A8.6 8.6 0 0 1 11.2.6C10.8.5 10.4.5 10 .5Z" fill="url(#pm-sticker)" />
          <path d="M11.2.6a8.6 8.6 0 0 0 8.2 8.2A9.5 9.5 0 0 0 11.2.6Z" fill="url(#pm-sticker-peel)" />
        </svg>
      );
    case "genmoji":
      return (
        <svg {...common}>
          <defs>
            <linearGradient id="pm-genmoji" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f6a94b" /><stop offset="0.5" stopColor="#ee5f8a" /><stop offset="1" stopColor="#7c6df0" /></linearGradient>
          </defs>
          <circle cx="10" cy="10" r="10" fill="url(#pm-genmoji)" />
          <circle cx="9.3" cy="10.6" r="5" fill="none" stroke="#ffffff" strokeWidth="1.3" />
          <circle cx="7.5" cy="9.4" r="0.8" fill="#ffffff" />
          <circle cx="11.1" cy="9.4" r="0.8" fill="#ffffff" />
          <path d="M6.6 11.9h5.4a2.7 2.7 0 0 1-5.4 0Z" fill="#ffffff" />
          <path d="M15.2 3.6v3.4M13.5 5.3h3.4" stroke="#ffffff" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "image-playground":
      return (
        <svg {...common}>
          <defs>
            <linearGradient id="pm-playground" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f26d6d" /><stop offset="0.5" stopColor="#8f7cf2" /><stop offset="1" stopColor="#4fc3f0" /></linearGradient>
          </defs>
          <circle cx="10" cy="10" r="10" fill="#141414" />
          <circle cx="10" cy="10" r="8.3" fill="none" stroke="#2c2c2c" strokeWidth="1.2" />
          <circle cx="10" cy="10" r="3.6" fill="none" stroke="url(#pm-playground)" strokeWidth="1.2" />
          {[0, 60, 120, 180, 240, 300].map(angle => (
            <circle key={angle} cx="10" cy="6.4" r="1" fill="url(#pm-playground)" transform={`rotate(${angle} 10 10)`} />
          ))}
        </svg>
      );
    case "images":
      return (
        <svg {...common}>
          <defs>
            <linearGradient id="pm-images" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f26b76" /><stop offset="1" stopColor="#e83e50" /></linearGradient>
          </defs>
          <circle cx="10" cy="10" r="10" fill="url(#pm-images)" />
          <circle cx="9" cy="9" r="4.6" fill="none" stroke="#ffffff" strokeWidth="1.3" />
          <path d="M5.2 7.6h7.6M5.2 10.4h7.6M9 4.4v9.2M6.7 4.9c-1.3 2.6-1.3 5.6 0 8.2M11.3 4.9c1.3 2.6 1.3 5.6 0 8.2" stroke="#ffffff" strokeWidth="0.8" fill="none" />
          <path d="M12.4 12.4 15.4 15.4" stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "message-effects":
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="10" fill="#f5b53f" />
          <path d="M8.9 11.1 14 6" stroke="#ffffff" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M6.8 4.6v2.2M4.6 6.8h2.2M5.2 5.2l1.5 1.5M9.6 4.6l-.6 2.1M4.6 9.6l2.1-.6M5.3 12.2l1.6-1.5" stroke="#ffffff" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
    default:
      return <svg {...common}><circle cx="10" cy="10" r="10" fill="#8e8e93" /></svg>;
  }
}
