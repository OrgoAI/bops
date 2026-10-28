"use client";

import { useCallback, useEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from "react";

/*
 * The sidebar's footer (sidebar.tsx): you (your initials and name; People, Routines, Knowledge and Apps
 * are in your menu), then Connect apps (your logins). At rest you are the pill, with your name, and
 * Connect apps is a round button; pointing at it (or tabbing to it) grows it into the pill, with the apps
 * you've connected, as you shrink to your initials, in one motion, and leaving the row settles it back.
 * Each is a slot 36px wide that takes the row's free space by flex-grow (1 for the pill, 0 for the other),
 * so as one grows the other gives up the same space and the row never gets wider or wraps (globals.css
 * .motion-footer-*; with reduced motion, the swap is instant). Where nothing can hover (a touch screen),
 * you stay the pill.
 * The other buttons here (People, Routines, Knowledge, Apps) are the round ones those pages still use.
 */

/** The pages the footer and your menu open: the one open on the right ("vault" is Logins; "apps", the apps the bots made). */
export type FooterPage = "people" | "vault" | "routines" | "knowledge" | "apps";
/** Every button in the footer: its pages and your account. */
export type FooterKey = FooterPage | "you";

/** How long the pill waits once the pointer leaves the row before it settles back, so it never blinks. */
export const FOOTER_LEAVE_MS = 80;

/** Whether this screen hovers at all: not where the media query says `(hover: none)` (a touch screen). */
export function canHover() {
  try {
    return !window.matchMedia?.("(hover: none)").matches;
  } catch {
    return true;
  }
}

const keyOf = (t: EventTarget | null) => (t instanceof Element ? ((t.closest("[data-footer-key]")?.getAttribute("data-footer-key") as FooterKey | null) ?? null) : null);
const focusVisible = (el: Element | null) => {
  try {
    return !!el?.matches(":focus-visible");
  } catch {
    return false;
  }
};

/**
 * The row's hover: which button the pointer (or a keyboard's focus) is on, and the handlers for the row
 * that track it. Gaps between buttons keep the last one; leaving the row waits FOOTER_LEAVE_MS, then
 * settles back to rest unless a button in it still has keyboard focus. `initial` is for the tests.
 */
export function useFooterHover(initial: FooterKey | null = null) {
  const [hover, setHover] = useState<FooterKey | null>(initial);
  const row = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const enter = (k: FooterKey | null) => {
    clear();
    if (k) setHover(k);
  };
  const settle = useCallback(() => {
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      const a = typeof document !== "undefined" ? document.activeElement : null;
      setHover(a && row.current?.contains(a) && focusVisible(a) ? keyOf(a) : null);
    }, FOOTER_LEAVE_MS);
  }, []);
  /*
   * In the row by the page, not by React: a portal opened from a button (the account menu's Restart
   * dialog) counts as inside the row in React's tree, so React sends its pointer events up to the row
   * and never a leave. A pointer on anything outside the row's own elements settles it, once.
   */
  const inRow = (t: EventTarget | null) => t instanceof Node && !!row.current?.contains(t);
  const away = useCallback(() => {
    if (!timer.current) settle();
  }, [settle]);
  useEffect(() => {
    if (!hover || typeof document === "undefined") return;
    const f = (e: Event) => {
      if (!(e.target instanceof Node && row.current?.contains(e.target))) away();
    };
    document.addEventListener("pointerover", f);
    return () => document.removeEventListener("pointerover", f);
  }, [hover, away]);
  return {
    hover,
    row: {
      ref: row,
      onPointerOver: (e: PointerEvent) => {
        if (e.pointerType === "touch" || !canHover()) return;
        if (!inRow(e.target)) return away();
        enter(keyOf(e.target));
      },
      onPointerLeave: (e: PointerEvent) => e.pointerType !== "touch" && settle(),
      onFocus: (e: FocusEvent) => inRow(e.target) && focusVisible(e.target) && enter(keyOf(e.target)),
      onBlur: (e: FocusEvent) => !row.current?.contains(e.relatedTarget as Node | null) && settle(),
    },
  };
}

/**
 * Which footer button is the pill: People while its sheet is open, else the page shown on the right
 * (`tab`: the kind of the tab in sight, none while the panel is hidden or a computer is full width) when
 * it's Knowledge, Routines or Apps (the Apps home, one of the apps, or one on the web), else Logins (the
 * Vault, and the default). `knowledge`: whether the footer has Knowledge at all (lib/memory-categories.ts
 * categoriesOpen).
 */
export function footerPageOf({ people, tab, knowledge = true }: { people?: boolean; tab?: string; knowledge?: boolean }): FooterPage {
  if (people) return "people";
  if (tab === "memory" && knowledge) return "knowledge";
  if (tab === "autopilot") return "routines";
  if (tab === "made-apps" || tab === "made-app" || tab === "hosted-app") return "apps";
  return "vault";
}

/**
 * One of the footer's buttons (`name`): round with its `icon`, or the pill (`expanded`, pointed at or the
 * open page) with its `label` too, and `trail` after the label (Logins' connected apps). `pressed`
 * is whether its page is the open one (the resting pill), not merely pointed at; it defaults to
 * `expanded`. `tip` is the round one's tooltip (the pill says what it is already); `badge` (a count) sits
 * on its corner, outside the clipped button, in both shapes.
 */
export function FooterButton({
  name,
  expanded,
  pressed = expanded,
  label,
  tip,
  ariaLabel,
  icon,
  trail,
  badge,
  onClick,
}: {
  name: FooterKey;
  expanded: boolean;
  pressed?: boolean;
  label: string;
  /** None: pointing at it grows it into the pill, which says what it is (Connect apps). */
  tip?: string;
  ariaLabel?: string;
  icon?: ReactNode;
  trail?: ReactNode;
  badge?: ReactNode;
  onClick: () => void;
}) {
  return (
    <span data-footer-slot={label} data-footer-key={name} className={`motion-footer-slot relative flex h-9 min-w-9 basis-9 ${expanded ? "grow" : "grow-0"} shrink`}>
      <button
        onClick={onClick}
        title={expanded ? undefined : tip}
        aria-label={ariaLabel ?? label}
        aria-pressed={pressed}
        className="flex h-9 w-full min-w-0 items-center justify-center overflow-hidden rounded-full bg-white px-2.5 text-[13.5px] font-medium text-[color:var(--c-3a3a38)] shadow-[0_0_0_1px_var(--c-e6e6e3)] transition-transform duration-100 ease-out hover:bg-[color:var(--c-fcfcfb)] outline-none focus-visible:shadow-[0_0_0_1.5px_var(--c-0a0a0a)] active:scale-[.96] motion-reduce:transition-none"
      >
        {icon}
        <span
          aria-hidden
          className={`motion-footer-label min-w-0 truncate text-ink whitespace-nowrap ${expanded ? "max-w-[160px] translate-x-0 opacity-100" : "max-w-0 -translate-x-1 opacity-0"} ${icon ? (expanded ? "pl-1.5" : "pl-0") : ""} ${trail ? (expanded ? "pr-1.5" : "pr-0") : ""}`}
        >
          {label}
        </span>
        {trail}
      </button>
      {badge}
    </span>
  );
}
