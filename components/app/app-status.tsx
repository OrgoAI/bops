"use client";

import { useState, type ReactNode } from "react";
import type { AppStatusInput } from "@/lib/hosted-apps";
import { appStatus } from "@/lib/hosted-apps";

/*
 * The small pieces Your Apps says an app's state with, the same on the owner's page and tab and on a member's page
 * (shared-apps.tsx): one plain sentence of what's going on (StatusLine), one tag a change wears for where it is (Tag:
 * Live is a filled mark, On preview an outlined one, the form telling them apart before the colour does), and a fold
 * for what's rarely needed (Fold: build settings, earlier deploys), shut by default.
 */

/** What the one thing to press is called. */
export const ACTION_WORDS = { "update-preview": "Update preview", publish: "Publish", "connect-domain": "Connect a domain" } as const;

/**
 * An app's status in a sentence (lib/hosted-apps.ts appStatus): grey when all is well or something is on its way,
 * ink when something waits on the person, red when something failed. `long`: with the change named, where there's room.
 */
export function StatusLine({ input, long, className = "" }: { input: AppStatusInput; long?: boolean; className?: string }) {
  const s = appStatus(input);
  const look = s.tone === "failed" ? "text-[#B42318]" : s.tone === "waits" ? "text-ink" : "text-[#6B6B6B]";
  return (
    <span data-state-line data-tone={s.tone} title={s.detail ? `${s.sentence} ${s.detail}` : s.sentence} className={`min-w-0 text-[12.5px] leading-4 ${long ? "leading-[18px]" : "truncate"} ${look} ${className}`}>
      {s.sentence}
      {long && s.detail && <span className="text-[#6B6B6B]"> {s.detail}</span>}
    </span>
  );
}

/** Where a change is: Live (Published serves it), or On preview. One form each, no colour needed to tell them apart. */
export function Tag({ kind, title }: { kind: "live" | "preview"; title?: string }) {
  return (
    <span data-tag={kind} title={title} className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 ${kind === "live" ? "bg-ink text-white" : "text-ink shadow-[inset_0_0_0_1px_#0A0A0A]"}`}>
      {kind === "live" ? "Live" : "On preview"}
    </span>
  );
}

/**
 * A fold for what's rarely needed on an app's page (its build settings, its earlier deploys): one line to press, with a
 * few words beside its title of what's inside, shut unless `open` says otherwise (before a first deploy, say).
 */
export function Fold({ id, title, aside, open: start = false, children }: { id: string; title: string; aside?: string; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(start);
  return (
    <div data-fold={id} aria-expanded={open} className="flex flex-col">
      <button type="button" onClick={() => setOpen((x) => !x)} className="-mx-2 flex h-8 items-center gap-2 rounded-lg px-2 text-left hover:bg-[#F6F6F4]">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={`shrink-0 text-[#6B6B6B] transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}>
          <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="shrink-0 text-[12px] font-semibold leading-4 text-[#6B6B6B]">{title}</span>
        {aside && <span className="min-w-0 truncate text-[12px] leading-4 text-[#9A9A98]">{aside}</span>}
      </button>
      <div className={open ? "flex flex-col gap-4 pt-1" : "hidden"}>{children}</div>
    </div>
  );
}
