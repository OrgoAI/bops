"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AppStatusInput } from "@/lib/hosted-apps";
import { appStatus } from "@/lib/hosted-apps";
import { CopyLink } from "./hosted-apps";
import { Spinner } from "./mascot";
import { useDismiss } from "./new-thread";
import { ago } from "./ui";

/*
 * The pieces Your Apps is set in, the same on the owner's page and tab and on a member's page (shared-apps.tsx), in
 * the shape Lovable and Vercel give publishing, in Bops' own material (ink on paper, a desk-grey card, the highlighter
 * only on what needs you): one row shape for every app (AppRow), a card for each place a site can be seen (PlaceCard:
 * Live, and Preview with its password behind a lock, each saying what it serves now), one Publish button that wears a
 * dot while the preview has a change that isn't live, versions set in fixed columns (VersionRow: the words, where it is
 * as a tag, who and when, Restore as a line is pointed at), a quiet line only while something moves or failed (Motion),
 * and a fold for what's rarely needed (Fold), shut by default.
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

/** A chat, for Ask <bot> in a narrow panel. */
export function ChatIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className={`shrink-0 ${className}`}>
      <path d="M3 3h10a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 11H7.5L4.5 13.5V11H3a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 3 3Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

/** Settings, for its button in a narrow panel: two sliders. */
export function SlidersIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className={`shrink-0 ${className}`}>
      <path d="M2 5h6M12 5h2M2 11h2M8 11h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="10" cy="5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="6" cy="11" r="1.7" stroke="currentColor" strokeWidth="1.3" />
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

/* ---------------- The looks every piece shares ---------------- */

/** A plain button in a title line (Ask Boppy, Settings): words on nothing, a desk-grey fill as it's pointed at or pressed. */
export const GHOST = "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium leading-4 text-ink hover:bg-[#F2F2F0] aria-pressed:bg-[#F2F2F0] disabled:text-[#9A9A98] disabled:hover:bg-transparent";
/** A small action on a row (Restore, Update preview): a paper pill with a hairline, so it reads as a button on a grey row. */
export const OUTLINED = "flex h-7 shrink-0 items-center whitespace-nowrap rounded-full bg-white px-2.5 text-[12px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E2E2DF] hover:shadow-[0_0_0_1px_#0A0A0A] disabled:text-[#9A9A98] disabled:shadow-[0_0_0_1px_#ECECEA] disabled:hover:shadow-[0_0_0_1px_#ECECEA]";
/** The one filled button: Publish, Save. */
export const FILLED = "flex h-7 shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-ink px-3 text-[12px] font-semibold leading-4 text-white disabled:bg-[#E6E6E3] disabled:text-[#9A9A98]";
/** A section's title on an app's page: in ink, so it reads as a heading, not a label. */
export const SECTION_TITLE = "text-[13px] font-semibold leading-4 text-ink";
/** The address of a place, in plain type. */
export const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/* ---------------- One row shape for every app ---------------- */

/**
 * One app's row on the Your Apps page, websites and the tools the bots made alike: its mark, its name, where it lives
 * (its address, or "In Bops"), and at its end only what matters now (`end`: Publish with its dot, what moves, or
 * nothing). The row opens it; `attrs` are the row's data for the tests and tooltips.
 */
export function AppRow({ mark, name, where, end, onOpen, title, attrs, expanded }: { mark: ReactNode; name: string; where?: ReactNode; end?: ReactNode; onOpen?: () => void; title?: string; attrs?: Record<string, string | undefined>; expanded?: boolean }) {
  return (
    <div {...attrs} title={title} onClick={onOpen} className="flex h-10 cursor-pointer items-center gap-3 rounded-[10px] px-3 hover:bg-[#F6F6F4]">
      <span className="flex w-[18px] shrink-0 items-center justify-center text-[#6B6B6B]">{mark}</span>
      {/* The row's button for the keyboard: its press comes up to the row (`expanded`: the row opens in place, and says so). */}
      <button type="button" title={name} aria-expanded={expanded} className="min-w-0 shrink truncate text-left text-[13px] font-medium leading-4 text-ink">
        {name}
      </button>
      {where && <span className="flex min-w-0 shrink-[2] items-center text-[13px] leading-4 text-[#6B6B6B]">{where}</span>}
      <span className="flex-1" />
      {end}
    </div>
  );
}

/* ---------------- The places a site can be seen ---------------- */

/**
 * One place a site can be seen, as a card: Live (its domain) or Preview (its fixed link, its password behind a lock:
 * `aside`). Its address opens it in the browser; under it, what it serves right now (`serving`: the version's words
 * and when), or what moves there (`working`), failed (`failed`), or that nothing is there yet (`empty`). So which
 * version is live and which is on the preview is read here, without the list.
 */
export function PlaceCard({
  place,
  url,
  aside,
  serving,
  working = null,
  failed = null,
  empty,
  nothing,
  onEmpty,
}: {
  place: "live" | "preview";
  url: string | null;
  aside?: ReactNode;
  serving: { message: string; at: number | null } | null;
  working?: string | null;
  failed?: string | null;
  /** Said in the address's place while it has none. */
  empty: string;
  /** Said under the address while nothing is served there yet. */
  nothing: string;
  /** What to do about having no address (Add a domain), beside `empty`. */
  onEmpty?: { label: string; go: () => void };
}) {
  return (
    <div data-place={place} className="flex min-w-0 flex-col gap-2 rounded-[14px] bg-desk px-4 py-3">
      <div className="flex h-6 items-center gap-2">
        <span className="text-[13px] font-semibold leading-4 text-ink">{place === "live" ? "Live" : "Preview"}</span>
        <span className="flex-1" />
        {aside}
      </div>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" title={url} onClick={(e) => e.stopPropagation()} className="flex min-w-0 items-center gap-1 self-start text-[13px] leading-4 text-ink hover:underline">
          <span className="min-w-0 truncate">{bare(url)}</span>
          <OpenIcon />
        </a>
      ) : (
        <span className="flex min-w-0 items-center gap-2">
          <span data-place-empty className="min-w-0 truncate text-[13px] leading-4 text-[#6B6B6B]">
            {empty}
          </span>
          {onEmpty && (
            <button type="button" data-place-action onClick={onEmpty.go} className="shrink-0 text-[13px] font-medium leading-4 text-ink underline-offset-2 hover:underline">
              {onEmpty.label}
            </button>
          )}
        </span>
      )}
      <span data-place-serving className="flex min-w-0 items-center gap-2 text-[12.5px] leading-4 text-[#6B6B6B]">
        {working ? (
          <>
            <Spinner size={11} color="#6B6B6B" />
            <span className="min-w-0 truncate">{working}</span>
          </>
        ) : failed ? (
          <span className="min-w-0 truncate text-[#B42318]" title={failed}>
            {failed}
          </span>
        ) : serving ? (
          <>
            <span className="min-w-0 truncate" title={serving.message}>
              {serving.message}
            </span>
            {serving.at != null && <span className="shrink-0 text-[#9A9A98]">{ago(serving.at)}</span>}
          </>
        ) : (
          <span className="text-[#9A9A98]">{nothing}</span>
        )}
      </span>
    </div>
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
        className="flex h-6 items-center gap-1 rounded-full px-1.5 text-[#6B6B6B] hover:bg-black/[0.06] hover:text-ink aria-expanded:bg-black/[0.06] aria-expanded:text-ink"
      >
        <LockIcon />
        <span className="text-[12px] font-medium leading-4">Password</span>
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
      <button type="button" data-next-action={tag} data-waits={waits || undefined} disabled={!!why || busy} onClick={onClick} className={FILLED}>
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

/** A version on its way somewhere: the tag's shape, breathing. */
export function Deploying() {
  return (
    <span data-going className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-2 py-0.5 text-[11px] font-medium leading-4 text-[#3A3A38] shadow-[0_0_0_1px_#E2E2DF]">
      <span className="size-1.5 animate-pulse rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]" />
      Deploying
    </span>
  );
}

/* ---------------- Versions ---------------- */

/** The columns every versions list is set in: the words, where it is, who and when. Fixed, so the tags line up down the list; in a narrow panel (under 512px, @container on the tab or card) only when, so the words keep their room. */
const VERSION_COLUMNS = "grid-cols-[minmax(0,1fr)_84px_minmax(0,172px)] @max-lg:grid-cols-[minmax(0,1fr)_84px_56px]";

/**
 * One version, on its line: what it did (its words; the rest in the tooltip), where it is (a Tag, or Deploying),
 * who made it and when. Pointed at (or reached with the keyboard), its action (`action`: Restore, Preview this)
 * shows where who and when were, so the line stays the same width and nothing moves.
 */
export function VersionRow({ id, message, tip, where, who, at, action, serving }: { id: string; message: string; tip?: string; where?: ReactNode; who: string; at: number; action?: ReactNode; serving?: boolean }) {
  return (
    <div data-commit={id} data-serving={serving || undefined} title={tip} className={`group grid min-h-9 items-center gap-x-3 rounded-lg px-2 hover:bg-[#F6F6F4] ${VERSION_COLUMNS}`}>
      <span className={`min-w-0 truncate text-[13px] leading-4 ${message ? "text-ink" : "text-[#9A9A98]"}`}>{message || "No message"}</span>
      <span className="flex min-w-0 items-center">{where}</span>
      <span className="relative flex min-w-0 items-center justify-end">
        <span className={`min-w-0 truncate whitespace-nowrap text-[12.5px] leading-4 text-[#9A9A98] ${action ? "group-hover:opacity-0 group-focus-within:opacity-0" : ""}`}>
          <span title={who} className="@max-lg:hidden">{`${who} · `}</span>
          <span title={`${who}, ${new Date(at).toLocaleString()}`}>{ago(at)}</span>
        </span>
        {action && <span className="absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">{action}</span>}
      </span>
    </div>
  );
}

/* ---------------- What moves ---------------- */

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
        <span className={`shrink-0 ${SECTION_TITLE}`}>{title}</span>
        {aside && <span className="min-w-0 truncate text-[12px] leading-4 text-[#9A9A98]">{aside}</span>}
      </button>
      <div className={open ? "flex flex-col gap-4 pt-1" : "hidden"}>{children}</div>
    </div>
  );
}
