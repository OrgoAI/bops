"use client";

import type { ReactNode } from "react";

/*
 * The sidebar's footer (sidebar.tsx): your initials, then People, Apps & logins, Routines and Knowledge.
 * One of the four is a pill with its label, the others round buttons: the one whose page is open on the
 * right (People's sheet, the Vault, Routines, Knowledge), else Apps & logins. Picking another grows it
 * into the pill as the one before shrinks back to a circle, in one motion: each is a slot 40px wide that
 * takes the row's free space by flex-grow (1 for the pill, 0 for the rest), so as one grows the other
 * gives up the same space and the row never gets wider or wraps (globals.css .motion-footer-*; with
 * reduced motion, the swap is instant).
 */

/** The footer's four pages: the one that's the pill. */
export type FooterPage = "people" | "vault" | "routines" | "knowledge";

/**
 * Which footer button is the pill: People while its sheet is open, else the page shown on the right
 * (`tab`: the kind of the tab in sight, none while the panel is hidden or a computer is full width) when
 * it's Knowledge or Routines, else Apps & logins (the Vault, and the default). `knowledge`: whether the
 * footer has Knowledge at all (lib/memory-categories.ts categoriesOpen).
 */
export function footerPageOf({ people, tab, knowledge = true }: { people?: boolean; tab?: string; knowledge?: boolean }): FooterPage {
  if (people) return "people";
  if (tab === "memory" && knowledge) return "knowledge";
  if (tab === "autopilot") return "routines";
  return "vault";
}

/**
 * One of the footer's buttons: round with its `icon`, or the pill (`expanded`) with its `label` too, and
 * `trail` after the label (Apps & logins' connected apps). `tip` is the round one's tooltip (the pill says
 * what it is already); `badge` (a count) sits on its corner, outside the clipped button, in both shapes.
 */
export function FooterButton({
  expanded,
  label,
  tip,
  ariaLabel,
  icon,
  trail,
  badge,
  onClick,
}: {
  expanded: boolean;
  label: string;
  tip: string;
  ariaLabel?: string;
  icon?: ReactNode;
  trail?: ReactNode;
  badge?: ReactNode;
  onClick: () => void;
}) {
  return (
    <span data-footer-slot={label} className={`motion-footer-slot relative flex h-10 min-w-10 basis-10 ${expanded ? "grow" : "grow-0"} shrink`}>
      <button
        onClick={onClick}
        title={expanded ? undefined : tip}
        aria-label={ariaLabel ?? label}
        aria-pressed={expanded}
        className="flex h-10 w-full min-w-0 items-center justify-center overflow-hidden rounded-full bg-white px-3 text-[13.5px] font-medium text-[#3A3A38] shadow-[0_0_0_1px_#E6E6E3] transition-transform duration-100 ease-out hover:bg-[#FCFCFB] outline-none focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] active:scale-[.96] motion-reduce:transition-none"
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
