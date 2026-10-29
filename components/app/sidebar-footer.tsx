"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type PointerEvent, type ReactNode } from "react";

/*
 * The sidebar's footer (sidebar.tsx): your account (the initials, with Team in their menu), then Logins, Routines,
 * Knowledge and Apps. One of them is a pill with its label, the others round buttons. At rest it's the
 * one whose page is open (Settings at Logins or Your Apps, Routines, Knowledge, the Apps home or
 * an app a bot made), else Logins.
 * Pointing at another (or tabbing to it) grows that one into the pill as the one before shrinks back to a
 * circle, in one motion; moving along the row glides the pill from button to button, and leaving the row
 * keeps it on the one expanded last (useLastPill), else the resting one. Each is a slot 36px wide that takes the row's free space by
 * flex-grow (1 for the pill, 0 for the rest), so as one grows the other gives up the same space and the
 * row never gets wider or wraps (globals.css .motion-footer-*; with reduced motion, the swap is instant).
 * Six of them (36px, 4px apart) left the pill 119px in the sidebar's 340px (less its 10px sides and
 * 1px border), room for Knowledge and its icon, or Logins and three apps' logos; with People gone from the
 * row (Team is in your menu), its room stays empty at the end (sidebar.tsx FOOTER_ROOM) and the pill keeps that size.
 * Where nothing can hover (a touch screen), only the open page is the pill.
 */

/** The footer's pages: the one that's the pill at rest ("vault" is Logins; "apps", the apps the bots made). */
export type FooterPage = "vault" | "routines" | "knowledge" | "apps";
/** Every button in the footer: its pages and your account. */
export type FooterKey = FooterPage | "you";

/**
 * Which button is the pill: the one pointed at (or tabbed to), else the one expanded last (useLastPill), else the
 * resting one (the open page).
 */
export function footerPillOf({ rest, hover, last }: { rest: FooterPage; hover?: FooterKey | null; last?: FooterPage | null }): FooterKey {
  return hover ?? last ?? rest;
}

/** Where the pill is kept between windows: this window's storage, a convenience (nothing in Bops' state). */
const LAST_PILL_KEY = "bops.footer.lastPill";
const isFooterPage = (k: unknown): k is FooterPage => k === "vault" || k === "routines" || k === "knowledge" || k === "apps";
/** The last one when storage can't be used (a private window): for as long as this window is open. */
let lastPillHere: FooterPage | null = null;
const lastPillListeners = new Set<() => void>();
function readLastPill(): FooterPage | null {
  try {
    const kept = localStorage.getItem(LAST_PILL_KEY);
    return isFooterPage(kept) ? kept : lastPillHere;
  } catch {
    return lastPillHere;
  }
}

/** Remember a page button that was just expanded (useFooterHover's pointer and focus): never your account's. */
export function keepLastPill(k: FooterKey | null) {
  if (!isFooterPage(k) || readLastPill() === k) return;
  lastPillHere = k;
  try {
    localStorage.setItem(LAST_PILL_KEY, k);
  } catch {}
  for (const f of lastPillListeners) f();
}

/**
 * The page button expanded last (pointed at, tabbed to, or picked): the pill stays on it once the pointer leaves the
 * row, instead of going back to the open page or Logins, and is the same after a restart. Never your account's
 * button: its pill shows only while it's pointed at. None on the server (the window reads its storage).
 */
export function useLastPill(): FooterPage | null {
  return useSyncExternalStore(
    (f) => {
      lastPillListeners.add(f);
      return () => void lastPillListeners.delete(f);
    },
    readLastPill,
    () => null,
  );
}

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
    keepLastPill(k);
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
 * Which footer button is the pill: while the Settings page is open (`settings`: the place it's at), Logins at its Logins
 * and Apps at its Your Apps; else the page shown on the right (`tab`: the kind of the tab in sight, none while the panel
 * is hidden or a computer is full width) when it's Knowledge, Routines or Apps (the Apps home, one of the apps, or one on
 * the web), else Logins (the Vault, and the default). `knowledge`: whether the footer has Knowledge at all
 * (lib/memory-categories.ts categoriesOpen).
 */
export function footerPageOf(open: { settings?: string; tab?: string; knowledge?: boolean }): FooterPage {
  return openFooterPage(open) ?? "vault";
}

/**
 * The footer's page that's really open, as footerPageOf reads it, but null when none is (a chat's computer
 * or a web tab on the right, the panel hidden, Settings at another place): the folded sidebar's column
 * (sidebar-rail.tsx) fills in only the open one, with no resting pill to fall back on.
 */
export function openFooterPage({ settings, tab, knowledge = true }: { settings?: string; tab?: string; knowledge?: boolean }): FooterPage | null {
  // The Settings page covers what's on the right: only its own places say what's open.
  if (settings !== undefined) return settings === "logins" ? "vault" : settings === "apps" ? "apps" : null;
  if (tab === "memory" && knowledge) return "knowledge";
  if (tab === "autopilot") return "routines";
  if (tab === "made-apps" || tab === "made-app" || tab === "hosted-app") return "apps";
  if (tab === "vault") return "vault";
  return null;
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
  tip: string;
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
        className="flex h-9 w-full min-w-0 items-center justify-center overflow-hidden rounded-full bg-white px-2.5 text-[13.5px] font-medium text-[#3A3A38] shadow-[0_0_0_1px_#E6E6E3] transition-transform duration-100 ease-out hover:bg-[#FCFCFB] outline-none focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] active:scale-[.96] motion-reduce:transition-none"
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
