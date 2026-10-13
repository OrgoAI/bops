"use client";

import { useState, type ReactNode } from "react";

/**
 * Folds its children open and shut: their height eases between nothing and all of it (grid rows 0fr
 * to 1fr, so no height is measured), they fade, and they settle down a few pixels as they open.
 * Shut, they stay mounted (so the motion has something to fold) but are out of reach: inert, so no
 * tab stop or click lands in them, and hidden from screen readers. With reduced motion, it's instant.
 * `lazy`: nothing is rendered until it first opens (for a long list of folds, each with much inside).
 */
export function Fold({ open, lazy = false, children, className = "" }: { open: boolean; lazy?: boolean; children: ReactNode; className?: string }) {
  // Opened once: kept from then on, so it can fold shut with its content in it.
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return (
    <div
      inert={!open}
      aria-hidden={open ? undefined : true}
      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"} ${className}`}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={`transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? "translate-y-0" : "-translate-y-1.5"}`}>{lazy && !opened ? null : children}</div>
      </div>
    </div>
  );
}
