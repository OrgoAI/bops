"use client";

import { useState, useSyncExternalStore } from "react";
import type { CloudNotice } from "@/cloud/protocol";

/** How often Bops asks for new notices while it's open; coming back to its window asks too, at most once a minute. */
const EVERY_MS = 15 * 60_000;
const AT_MOST_MS = 60_000;

/*
 * Notices from Orgo (lib/server/notices.ts, cloud/notices.ts), one at a time, newest first: a card in the sidebar above
 * its footer (sidebar.tsx), like a newer Bops (update-notice.tsx), never a pop-up over the app. On the folded sidebar,
 * a round button with a blue dot opens the sidebar to it. OK (or Esc in the card) puts it away for good, on all the
 * user's Macs. Its link, when it has one, opens in the browser (the Mac app sends a new window there: desktop/main.cjs).
 */

/** What's waiting, read once for every card and button on the page (both sidebars show the same one). */
let notices: CloudNotice[] = [];
// What the first look found, there as Bops opened: it shows as it is. A notice that comes later rises in.
let first: Set<string> | null = null;
let lookedAt = 0;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());
const look = () => {
  if (Date.now() - lookedAt < AT_MOST_MS) return;
  lookedAt = Date.now();
  void fetch("/api/notices", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : { notices: [] }))
    .then((b: { notices?: CloudNotice[] }) => {
      notices = Array.isArray(b.notices) ? b.notices : [];
      first ??= new Set(notices.map((x) => x.id));
      changed();
    })
    .catch(() => {});
};
let timer: ReturnType<typeof setInterval> | null = null;
const subscribe = (f: () => void) => {
  listeners.add(f);
  if (listeners.size === 1) {
    look();
    timer = setInterval(() => {
      lookedAt = 0;
      look();
    }, EVERY_MS);
    window.addEventListener("focus", look);
  }
  return () => {
    listeners.delete(f);
    if (listeners.size) return;
    if (timer) clearInterval(timer);
    timer = null;
    window.removeEventListener("focus", look);
  };
};
const none: CloudNotice[] = [];

/** The newest notice waiting (none while there's nothing, or nothing read yet), and whether it came after Bops opened. */
function useNotice() {
  const all = useSyncExternalStore(subscribe, () => notices, () => none);
  const n = all[0];
  return { n, late: !!n && !!first && !first.has(n.id) };
}

/** Put the notice away for good (on every Mac): the next one, if any, takes its place. */
async function putAway(id: string) {
  await fetch("/api/notices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
  notices = notices.filter((x) => x.id !== id);
  changed();
}

/** The notice, as a card in the sidebar. */
export function NoticeCard() {
  const { n, late } = useNotice();
  const [closing, setClosing] = useState(false);
  // Decided as each notice first shows: one that turned up while Bops was open rises in.
  const [rises, setRises] = useState<{ id: string; late: boolean } | null>(null);
  if (n && rises?.id !== n.id) setRises({ id: n.id, late });
  if (!n) return null;
  const link = n.link && /^https:\/\//.test(n.link.url) ? n.link : undefined;
  const ok = async () => {
    if (closing) return;
    setClosing(true);
    await putAway(n.id);
    setClosing(false);
  };
  const pill = "rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-50";
  return (
    <div
      role="status"
      aria-labelledby="notice-title"
      aria-describedby="notice-body"
      data-notice
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        void ok();
      }}
      className={`mx-1 mt-3 flex flex-col rounded-[14px] bg-white px-3.5 pb-3 pt-3 shadow-[0_0_0_1px_#E6E6E3,0_8px_20px_-14px_#00000040] ${rises?.id === n.id && rises.late ? "motion-rise-in" : ""}`}
    >
      <span id="notice-title" className="text-[13.5px] font-semibold leading-[18px]">
        {n.title}
      </span>
      <span id="notice-body" className="whitespace-pre-line pt-1 text-[12.5px] leading-[17px] text-[#6B6B6B]">
        {n.body}
      </span>
      <div className="flex items-center justify-end gap-2 pt-3">
        {link && (
          <button onClick={() => window.open(link.url, "_blank")} className={`${pill} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
            {link.label}
          </button>
        )}
        <button disabled={closing} onClick={() => void ok()} className={`${pill} min-w-[56px] bg-ink text-white`}>
          OK
        </button>
      </div>
    </div>
  );
}

/** The notice on the folded sidebar (sidebar-rail.tsx): a round button with a blue dot, which opens the sidebar to its card. */
export function NoticeRail({ onOpen }: { onOpen: () => void }) {
  const { n } = useNotice();
  if (!n) return null;
  const tip = `From Orgo: ${n.title}`;
  return (
    <button
      onClick={onOpen}
      aria-label={tip}
      data-tip={tip}
      data-notice="rail"
      className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-white shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB] active:scale-[.96]"
    >
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
        <path d="M8 2.2a4 4 0 0 0-4 4v2.6L2.8 11h10.4L12 8.8V6.2a4 4 0 0 0-4-4zM6.5 13a1.6 1.6 0 0 0 3 0" fill="none" stroke="#0A0A0A" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span aria-hidden className="absolute -right-px -top-px size-2.5 rounded-full bg-[#2F7BFF] shadow-[0_0_0_2px_#F9F9F8]" />
    </button>
  );
}
