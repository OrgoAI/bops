"use client";

import { useEffect, useState } from "react";
import type { Bot, Watch } from "@/lib/types";
import { siteOf } from "@/lib/watch-sites";
import { ago, post } from "./ui";

const when = (t: number) => {
  const a = ago(t);
  return a === "now" ? "just now" : /^\d/.test(a) ? `${a} ago` : `on ${a}`;
};

/**
 * Setting up (or changing) a watched screen: what it's on, what's worth a heads-up, in quick picks
 * or the user's own words. Sits over the bottom of the screen it's about, so the page stays in view.
 */
export function WatchSheet({
  bot: b,
  display,
  page,
  watch,
  onClose,
}: {
  bot: Bot;
  display: number;
  page?: { url: string; title: string };
  watch?: Watch;
  onClose: () => void;
}) {
  // Picks that fit this page, read from it on the server; the address alone is the fallback meanwhile.
  const [suggestion, setSuggestion] = useState<{ site: string; lookFor: string; picks: string[] } | null>(null);
  useEffect(() => {
    let gone = false;
    fetch(`/api/watches?botId=${encodeURIComponent(b.id)}&display=${display}`)
      .then((r) => r.json())
      .then((s) => !gone && s.picks && setSuggestion(s))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [b.id, display]);
  const known = suggestion ?? siteOf(page?.url ?? "", page?.title ?? "");
  const site = watch?.site ?? known.site;
  const [text, setText] = useState(watch?.lookFor ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parts = text.split(/\s*[,;]\s*/).filter(Boolean);
  const has = (pick: string) => parts.some((p) => p.toLowerCase() === pick.toLowerCase());
  const toggle = (pick: string) => setText(has(pick) ? parts.filter((p) => p.toLowerCase() !== pick.toLowerCase()).join(", ") : [...parts, pick].join(", "));
  const lookFor = text.trim() || known.lookFor;

  const save = async () => {
    setBusy(true);
    setError(null);
    const res = watch
      ? await post("/api/watches", { id: watch.id, action: "edit", lookFor }, "PATCH")
      : await post("/api/watches", { botId: b.id, display, lookFor, site });
    if (res.ok) onClose();
    else {
      setError(((await res.json()) as { error?: string }).error ?? "Couldn't start watching");
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!watch) return;
    setBusy(true);
    await post(`/api/watches?id=${encodeURIComponent(watch.id)}`, {}, "DELETE");
    onClose();
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute inset-x-3 bottom-3 z-50 mx-auto flex max-w-[460px] cursor-default flex-col gap-3 rounded-2xl bg-white p-4 shadow-[0_0_0_1px_#0000000F,0_24px_50px_-18px_#00000059]"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#F2F2F0]">
          <svg width="18" height="18" viewBox="0 0 16 16">
            <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="#0A0A0A" strokeWidth="1.3" strokeLinejoin="round" />
            <circle cx="8" cy="8" r="2" fill="#0A0A0A" />
          </svg>
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold leading-5">{watch ? `Watching ${site}` : `Keep an eye on ${site}`}</span>
          <span className="text-[12.5px] leading-[17px] text-[#6B6B6B]">
            {watch
              ? watch.readAt
                ? `Bops last read it ${when(watch.readAt)}. It reads the page whenever it changes.`
                : "Bops reads the page whenever it changes."
              : `${b.name} keeps this screen on ${site} and gives you a heads-up in chat when something needs you. Other work uses the other screens.`}
          </span>
        </div>
        <button onClick={onClose} aria-label="Close" className="flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-[#F2F2F0]">
          <svg width="10" height="10" viewBox="0 0 12 12">
            <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium leading-4 text-[#6B6B6B]">Tell me about</span>
        <div className="flex flex-wrap gap-1.5">
          {!suggestion &&
            [64, 92, 78].map((w) => <span key={w} className="h-6 animate-pulse rounded-full bg-[#F2F2F0]" style={{ width: w }} />)}
          {suggestion?.picks.map((pick) => (
            <button
              key={pick}
              onClick={() => toggle(pick)}
              className={`rounded-full px-2.5 py-1 text-[12.5px] leading-4 ${has(pick) ? "bg-ink text-white" : "bg-[#F2F2F0] text-ink hover:bg-[#EAEAE7]"}`}
            >
              {pick}
            </button>
          ))}
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder={`Or in your words, e.g. "${known.lookFor}"`}
          className="resize-none rounded-xl bg-[#F7F7F6] px-3 py-2 text-[13px] leading-[18px] outline-none placeholder:text-[#9A9A98] focus:bg-white focus:shadow-[0_0_0_1.5px_#0A0A0A]"
        />
      </div>

      {watch?.told?.length ? (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium leading-4 text-[#6B6B6B]">Recent heads-ups</span>
          {[watch.told].flat().slice(-3).reverse().map((t) => (
            <span key={t} className="truncate text-[12.5px] leading-[17px] text-[#3A3A38]">
              {t}
            </span>
          ))}
        </div>
      ) : null}

      {error && <span className="text-[12.5px] leading-4 text-[#B42318]">{error}</span>}
      <div className="flex items-center gap-2">
        <button onClick={() => void save()} disabled={busy} className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold leading-4 text-white disabled:opacity-50">
          {watch ? "Save" : "Start watching"}
        </button>
        {watch ? (
          <button onClick={() => void stop()} disabled={busy} className="rounded-full px-3.5 py-2 text-[13px] font-medium leading-4 text-[#B42318] hover:bg-[#FEF3F2]">
            Stop watching
          </button>
        ) : (
          <button onClick={onClose} className="rounded-full px-3.5 py-2 text-[13px] font-medium leading-4 text-[#3A3A38] hover:bg-[#F2F2F0]">
            Not now
          </button>
        )}
      </div>
    </div>
  );
}
