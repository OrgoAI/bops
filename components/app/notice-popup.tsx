"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CloudNotice } from "@/cloud/protocol";

/** How often Bops asks for new notices while it's open; coming back to its window asks too, at most once a minute. */
const EVERY_MS = 15 * 60_000;
const AT_MOST_MS = 60_000;

/**
 * Notices from Orgo (lib/server/notices.ts, cloud/notices.ts), one at a time as a pop-up, newest first.
 * OK (or Esc) puts it away for good, on all the user's Macs. Its link, when it has one, opens in the
 * browser (the Mac app sends a new window there: desktop/main.cjs).
 */
export function NoticePopup() {
  const [notices, setNotices] = useState<CloudNotice[]>([]);
  const [closing, setClosing] = useState(false);
  const lookedAt = useRef(0);

  useEffect(() => {
    let stop = false;
    const look = () => {
      if (Date.now() - lookedAt.current < AT_MOST_MS) return;
      lookedAt.current = Date.now();
      void fetch("/api/notices", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { notices: [] }))
        .then((b: { notices?: CloudNotice[] }) => !stop && setNotices(Array.isArray(b.notices) ? b.notices : []))
        .catch(() => {});
    };
    look();
    const timer = setInterval(() => {
      lookedAt.current = 0;
      look();
    }, EVERY_MS);
    window.addEventListener("focus", look);
    return () => {
      stop = true;
      clearInterval(timer);
      window.removeEventListener("focus", look);
    };
  }, []);

  const n = notices[0];
  const putAway = async () => {
    if (!n || closing) return;
    setClosing(true);
    await fetch("/api/notices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id }) }).catch(() => {});
    setNotices((all) => all.filter((x) => x.id !== n.id));
    setClosing(false);
  };

  useEffect(() => {
    if (!n) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      void putAway();
    };
    document.addEventListener("keydown", esc, true);
    return () => document.removeEventListener("keydown", esc, true);
  });

  if (!n) return null;
  const link = n.link && /^https:\/\//.test(n.link.url) ? n.link : undefined;
  const pill = "rounded-full px-3.5 py-1.5 text-[13px] font-medium leading-4 disabled:opacity-50";
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/20 backdrop-blur-[2px]">
      <div
        role="alertdialog"
        aria-labelledby="notice-title"
        aria-describedby="notice-body"
        className="flex w-[360px] flex-col rounded-[18px] bg-white p-5 shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]"
      >
        <span id="notice-title" className="text-[15px] font-semibold leading-5">
          {n.title}
        </span>
        <span id="notice-body" className="whitespace-pre-line pt-1 text-[13px] leading-[18px] text-[#6B6B6B]">
          {n.body}
        </span>
        <div className="flex items-center justify-end gap-2 pt-5">
          {link && (
            <button onClick={() => window.open(link.url, "_blank")} className={`${pill} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
              {link.label}
            </button>
          )}
          <button autoFocus disabled={closing} onClick={() => void putAway()} className={`${pill} min-w-[64px] bg-ink text-white`}>
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
