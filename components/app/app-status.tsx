"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AppStatusInput } from "@/lib/hosted-apps";
import { appStatus } from "@/lib/hosted-apps";
import { CopyLink } from "./hosted-apps";
import { Spinner } from "./mascot";
import { useDismiss } from "./new-thread";

/*
 * The small pieces Your Apps says an app's state with, the same on the owner's page and tab and on a member's page
 * (shared-apps.tsx), in the shape Lovable and Framer give publishing: the site's places as links (Live, Preview with
 * its password behind a lock), one Publish button that wears a dot while the preview has a change that isn't live, a
 * tag a version wears for where it is (Tag: Live filled, Preview outlined), a quiet line only while something moves or
 * failed (Motion), and a fold for what's rarely needed (Fold), shut by default.
 */

/** What the one thing to press is called. */
export const ACTION_WORDS = { "update-preview": "Update preview", publish: "Publish", "connect-domain": "Connect a domain" } as const;

/** A website, in a list: a window with a title bar. */
export function SiteIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className={`shrink-0 ${className}`}>
      <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 6.5h12" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="4.8" r=".6" fill="currentColor" />
      <circle cx="6.5" cy="4.8" r=".6" fill="currentColor" />
    </svg>
  );
}

/** Opens somewhere else: an arrow out of its corner. */
export function OpenIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <path d="M4 2.5h5.5V8M9.5 2.5 2.5 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

const PILL = "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F6F6F4]";

/**
 * One place a site can be seen, as a link that opens it in the browser: Live (its domain) or Preview (its fixed link).
 * The address itself stays in the tooltip: a person opens the place, a developer can still read where it is.
 */
export function PlaceLink({ place, url, children }: { place: "live" | "preview"; url: string; children?: ReactNode }) {
  return (
    <span data-place={place} className="flex shrink-0 items-center gap-0.5">
      <a href={url} target="_blank" rel="noreferrer" title={url} onClick={(e) => e.stopPropagation()} className={PILL}>
        {place === "live" ? "Live" : "Preview"}
        <OpenIcon />
      </a>
      {children}
    </span>
  );
}

/**
 * The preview's password behind a lock: pressed, the password with Copy, and a line saying who it's for. `password`
 * null while it's being read or couldn't be (`waiting` says which); nothing at all when the link asks for none.
 */
export function PasswordLock({ password, waiting = null }: { password: string | null; waiting?: string | null }) {
  const box = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  useDismiss(open, () => setOpen(false), box);
  useEffect(() => () => setOpen(false), []);
  return (
    <span ref={box} className="relative flex shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        data-password-lock
        aria-label="Preview password"
        aria-expanded={open}
        data-tip={open ? undefined : "The preview asks for a password"}
        onClick={() => setOpen((x) => !x)}
        className="flex size-7 items-center justify-center rounded-full text-[#6B6B6B] hover:bg-[#F2F2F0] hover:text-ink aria-expanded:bg-[#F2F2F0] aria-expanded:text-ink"
      >
        <LockIcon />
      </button>
      {open && (
        <span role="dialog" aria-label="Preview password" data-password-popover className="absolute right-0 top-[calc(100%+6px)] z-30 flex w-[232px] flex-col gap-1.5 rounded-[12px] bg-white p-3 shadow-[0_0_0_1px_#0000000F,0_12px_32px_-12px_#00000040]">
          <span className="text-[12px] leading-4 text-[#6B6B6B]">The preview asks for this password.</span>
          {password ? (
            <span className="flex items-center gap-0.5">
              <span data-preview-password className="select-all whitespace-nowrap font-mono text-[12.5px] leading-4 text-ink">
                {password}
              </span>
              <CopyLink url={password} label="Copy password" />
            </span>
          ) : (
            <span className="text-[12px] leading-4 text-[#9A9A98]">{waiting ?? "Reading it…"}</span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * Publish, as Lovable has it: one filled button, a highlighter dot on it while the preview has a change that isn't live
 * (`waits`), greyed with why (`why`, on what holds it) when there's nothing to publish yet. `label` says where it goes.
 */
export function PublishButton({ waits, why, busy, label = "Publish", doing = "Publishing…", onClick, tag = "publish" }: { waits: boolean; why?: string; busy?: boolean; label?: string; doing?: string; onClick: () => void; tag?: string }) {
  return (
    <span data-tip={why} onClick={(e) => e.stopPropagation()} className="flex shrink-0">
      <button
        type="button"
        data-next-action={tag}
        data-waits={waits || undefined}
        disabled={!!why || busy}
        onClick={onClick}
        className="flex h-7 items-center gap-2 whitespace-nowrap rounded-full bg-ink pl-3 pr-3 text-[12px] font-semibold leading-4 text-white disabled:bg-[#E6E6E3] disabled:text-[#9A9A98]"
      >
        {busy ? doing : label}
        {waits && !busy && <span aria-hidden className="size-1.5 rounded-full bg-highlighter" />}
      </button>
    </span>
  );
}

/** Where a version is: Live (Published serves it), or on the Preview. One form each, no colour needed to tell them apart. */
export function Tag({ kind, title }: { kind: "live" | "preview"; title?: string }) {
  return (
    <span data-tag={kind} title={title} className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 ${kind === "live" ? "bg-ink text-white" : "text-ink shadow-[inset_0_0_0_1px_#0A0A0A]"}`}>
      {kind === "live" ? "Live" : "Preview"}
    </span>
  );
}

/**
 * What an app's right-hand side says when there's nothing to press: moving (a spinner and a few words), failed (red),
 * or not published yet (grey). Nothing while all is well: a quiet row is the point. `words` picks the shorter form.
 */
export function Motion({ input, className = "" }: { input: AppStatusInput; className?: string }) {
  const s = appStatus(input);
  if (s.tone === "working")
    return (
      <span data-motion="working" className={`flex shrink-0 items-center gap-1.5 text-[12px] leading-4 text-[#6B6B6B] ${className}`}>
        <Spinner size={11} color="#6B6B6B" />
        {s.sentence.replace(/…$/, "")}
      </span>
    );
  if (s.tone === "failed")
    return (
      <span data-motion="failed" title={s.sentence} className={`shrink-0 text-[12px] leading-4 text-[#B42318] ${className}`}>
        {/preview/i.test(s.sentence) ? "Preview failed" : "Publish failed"}
      </span>
    );
  if (s.action === "connect-domain")
    return (
      <span data-motion="unpublished" title={s.sentence} className={`shrink-0 text-[12px] leading-4 text-[#9A9A98] ${className}`}>
        Not published
      </span>
    );
  return null;
}

/**
 * A fold for what's rarely needed on an app's page (its settings, its earlier deploys): one line to press, shut unless
 * `open` says otherwise (before a first deploy, say). What's inside stays in the page, hidden, so nothing typed is lost.
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
