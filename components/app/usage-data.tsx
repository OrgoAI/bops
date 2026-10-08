"use client";

import { useEffect, useState } from "react";
import { startAnalytics, type AnalyticsInfo } from "@/lib/analytics";
import type { AppState } from "@/lib/types";
import { post } from "./ui";

const readInfo = async (): Promise<AnalyticsInfo | null> => {
  try {
    const r = await fetch("/api/analytics");
    return r.ok ? ((await r.json()) as AnalyticsInfo) : null;
  } catch {
    return null;
  }
};

/**
 * The window's usage events (lib/analytics.ts): started, switched to another person, or stopped
 * whenever who's signed in or the account's switch changes. Read again when the window comes back
 * to the front, and a few times at first while the Mac is still asking Bops Cloud for the plan, so
 * the window's `plan` is the one the user has now.
 */
export function useAnalytics(state: AppState | null) {
  const loaded = state !== null;
  const userId = state?.account?.user.id;
  const off = !!state?.analyticsOff;
  useEffect(() => {
    if (!loaded) return;
    let gone = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const sync = (tries: number) =>
      void readInfo().then((info) => {
        if (gone || !info) return;
        void startAnalytics(info).catch(() => {});
        if (info.on && !info.plan && tries > 0) timers.push(setTimeout(() => sync(tries - 1), 5_000));
      });
    const onFocus = () => sync(0);
    sync(3);
    window.addEventListener("focus", onFocus);
    return () => {
      gone = true;
      timers.forEach(clearTimeout);
      window.removeEventListener("focus", onFocus);
    };
  }, [loaded, userId, off]);
}

/** Whether this Mac may send usage events at all (not self-hosted, BOPS_TELEMETRY=0, DO_NOT_TRACK=1 or a development build); false until known. */
export function useTelemetryHere() {
  const [here, setHere] = useState(false);
  useEffect(() => {
    void readInfo().then((info) => setHere(!!info && !info.locked));
  }, []);
  return here;
}

/** Settings → You → Share usage data: the account's switch for usage events (README, Privacy). */
export function UsageData() {
  const [info, setInfo] = useState<AnalyticsInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void readInfo().then(setInfo);
  }, []);
  if (!info?.userId) return null;
  const toggle = async () => {
    setBusy(true);
    try {
      const res = await post("/api/analytics", { share: !info.share });
      if (res.ok) setInfo((await res.json()) as AnalyticsInfo);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-4">
      <div className="flex items-center gap-3 rounded-[14px] p-3.5 shadow-[0_0_0_1px_#E6E6E3]">
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-medium">Share usage data</span>
          <span className="text-[12px] leading-4 text-[#6B6B6B]">
            Sends Orgo counts of what you do in Bops, like bots made and tasks run, and error reports. Never your messages, files, screens, contacts or keys.
            {info.locked && " Turned off on this Mac."}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={info.share}
          aria-label="Share usage data"
          disabled={busy}
          onClick={() => void toggle()}
          className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-60 ${info.share ? "bg-ink" : "bg-[#E6E6E3]"}`}
        >
          <span className={`absolute top-[3px] size-4 rounded-full bg-white shadow-[0_1px_2px_#00000033] transition-[left] ${info.share ? "left-[19px]" : "left-[3px]"}`} />
        </button>
      </div>
    </div>
  );
}
