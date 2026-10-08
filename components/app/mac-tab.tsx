"use client";

import { useEffect, useState } from "react";
import { live, type AppState } from "@/lib/types";
import { MacStream, useAppWindowSource } from "./mac-screens";
import { Mascot } from "./mascot";
import { post } from "./ui";

/*
 * The user's Mac, as a place bots work: whether it's ready, what's running there, and the words that
 * send a task there.
 */

export function MacIcon({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0">
      <rect x="2" y="3" width="12" height="8" rx="1.3" fill="none" stroke={color} strokeWidth="1.3" />
      <path d="M0.8 13h14.4" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Your Mac's settings, in a sheet over the Your Mac tab: whether bots can work here, and the words that mean the Mac. */
export function MacSettings({ state }: { state: AppState }) {
  const m = state.mac;
  const retry = m?.next === "codex" && !m.installing;
  const [rule, setRule] = useState("");
  const section = "flex flex-col gap-2";
  const heading = "text-[15px] font-semibold leading-5";
  const sub = "text-[12.5px] leading-[17px] text-[#6B6B6B]";

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-7 pt-6">
      <div className="flex w-full flex-col gap-6">
        <div className="flex items-start gap-3.5 pr-8">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-highlighter">
            <MacIcon size={20} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[20px] font-semibold leading-6 tracking-[-0.01em]">Your Mac</span>
            <span className="flex items-center gap-1.5 text-[13px] leading-[19px] text-[#6B6B6B]">
              <span className={`size-2 rounded-full ${m?.ready ? "bg-[#2BB673]" : "bg-[#C9C9C6]"}`} />
              {m?.ready ? "Bots can browse here in a Chrome of their own, on your home internet, with Bops AI credit. They can't use your Mac's apps for now." : (m?.reason ?? "Checking…")}
            </span>
          </div>
          {/* An install of Codex that failed (it runs bots' tools here) starts again; anything else is looked at again. */}
          <button
            onClick={() => void (retry ? post("/api/mac/codex", { action: "install" }) : post("/api/mac", { check: true }, "PATCH"))}
            className="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]"
          >
            {retry ? "Try again" : "Check again"}
          </button>
        </div>

        <div className={section}>
          <div className="flex flex-col gap-0.5">
            <span className={heading}>These mean your Mac</span>
            <span className={sub}>A task that mentions one of these runs on your Mac. Otherwise Bops decides, and asks you when it can&apos;t tell.</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {m?.rules.map((r) => (
              <span key={r} className="flex items-center gap-1.5 rounded-full bg-[#F2F2F0] py-1 pl-3 pr-1.5 text-[12.5px] leading-4">
                {r}
                <button onClick={() => void post("/api/mac", { rules: m.rules.filter((x) => x !== r) }, "PATCH")} aria-label={`Remove ${r}`} className="flex size-4 items-center justify-center rounded-full text-[#9A9A98] hover:bg-black/10 hover:text-ink">
                  ×
                </button>
              </span>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!rule.trim() || !m) return;
                void post("/api/mac", { rules: [...m.rules, rule.trim()] }, "PATCH");
                setRule("");
              }}
            >
              <input value={rule} onChange={(e) => setRule(e.target.value)} placeholder="Add an app or phrase" className="w-[170px] rounded-full bg-white px-3 py-1 text-[12.5px] leading-4 shadow-[0_0_0_1px_#E2E2DF] outline-none placeholder:text-[#9A9A98] focus:shadow-[0_0_0_1.5px_#0A0A0A]" />
            </form>
          </div>
        </div>

      </div>
    </div>
  );
}

/** One window a bot uses on the user's Mac: live video in the Bops app, else a picture refreshed every second. */
export function MacWindow({ app, max = 640, className = "" }: { app: string; max?: number; className?: string }) {
  const source = useAppWindowSource(app);
  if (source) return <MacStream key={source} sourceId={source} fps={10} maxWidth={max * 2} className={className} />;
  return <MacWindowPicture app={app} max={max} className={className} />;
}

function MacWindowPicture({ app, max = 640, className = "" }: { app: string; max?: number; className?: string }) {
  const [tick, setTick] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // It keeps trying every second: a window that can't be seen yet (still opening, minimized) shows up when it can.
  return (
    <div className={`relative bg-[#F2F2F0] ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/mac/window?app=${encodeURIComponent(app)}&max=${max}&t=${tick}`}
        alt={`${app} on your Mac`}
        onError={() => setFailed(true)}
        onLoad={() => setFailed(false)}
        className={`h-full w-full object-contain ${failed ? "invisible" : ""}`}
      />
      {failed && <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-[11.5px] text-[#9A9A98]">{app} is working in the background</div>}
    </div>
  );
}

/** The windows bots are using on the user's Mac right now (or a moment ago): one per bot and app. */
export function useMacTiles(state: AppState | null) {
  const now = useNow2();
  return (state?.sessions ?? [])
    .filter((s) => s.runsOn === "mac" && s.macApps?.length && (live(s) || (s.endedAt && now - s.endedAt < 30_000)))
    .slice(-3)
    .map((s) => ({ s, app: s.macApps!.at(-1)!, b: state!.bots.find((x) => x.id === s.botId) }));
}

/** The preview tiles themselves, shared by the corner preview in Bops and its popped-out window. */
export function MacTiles({ tiles, onOpen, max = 480, tall = false }: { tiles: ReturnType<typeof useMacTiles>; onOpen: () => void; max?: number; tall?: boolean }) {
  return (
    <>
      {tiles.map(({ s, app, b }) => (
        <div key={s.id} className={`flex min-h-0 flex-col overflow-hidden rounded-2xl bg-white shadow-[0_0_0_1px_#0000000F,0_16px_40px_-16px_#00000066] ${tall ? "flex-1" : ""}`}>
          <div className="flex items-center gap-1.5 px-2.5 py-1.5">
            {b && <Mascot botId={b.id} color={b.color} size={16} antenna={false} />}
            <span className="min-w-0 flex-1 truncate text-[12px] leading-4">
              <span className="font-semibold">{b?.name ?? "A bot"}</span> · {app}
            </span>
            {live(s) ? <span className="size-1.5 animate-pulse rounded-full bg-[#2BB673]" title="Working" /> : <span className="text-[11px] text-[#9A9A98]">done</span>}
          </div>
          <button onClick={onOpen} title={`${s.title}: open Your Mac`} className={`block w-full ${tall ? "min-h-0 flex-1" : ""}`}>
            <MacWindow app={app} max={max} className={tall ? "h-full w-full" : "h-[150px] w-full"} />
          </button>
        </div>
      ))}
    </>
  );
}

const POS_KEY = "bops.macPreview.pos";
/** Set (to "open") while the previews are popped out into their own window. */
export const PIP_KEY = "bops.macPreview.popped";

/**
 * The windows bots are using on the user's Mac, live, in a corner of Bops (like Codex's and T3's
 * previews). Drag the bar to move it anywhere in Bops (it remembers); pop it out into a small
 * window that floats over every app; or fold it into a pill.
 */
export function MacPreviews({ state, onOpen }: { state: AppState; onOpen: () => void }) {
  const [small, setSmall] = useState(false);
  const tiles = useMacTiles(state);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(POS_KEY) ?? "null");
    } catch {
      return null;
    }
  });
  const [popped, setPopped] = useState(() => typeof localStorage !== "undefined" && localStorage.getItem(PIP_KEY) === "open");
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === PIP_KEY && setPopped(e.newValue === "open");
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  // A saved spot is kept inside the window (a smaller window, or one saved elsewhere, must not hide it).
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const canPop = typeof window !== "undefined" && !!(window as unknown as { bopsMac?: { popOut?: () => void } }).bopsMac?.popOut;

  /** Drag by the bar: follows the pointer, stays inside the window, remembered for next time. */
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    let last = { x: box.left, y: box.top };
    const move = (ev: PointerEvent) => {
      last = { x: Math.max(4, Math.min(window.innerWidth - box.width - 4, ev.clientX - dx)), y: Math.max(40, Math.min(window.innerHeight - 60, ev.clientY - dy)) };
      setPos(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem(POS_KEY, JSON.stringify(last));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!tiles.length || popped) return null;
  const at = pos ? { left: Math.max(4, Math.min(view.w - 252, pos.x)), top: Math.max(40, Math.min(view.h - 120, pos.y)) } : { right: 16, top: 54 };
  if (small)
    return (
      <button
        onClick={() => setSmall(false)}
        style={at}
        className="fixed z-40 flex items-center gap-2 rounded-full bg-white py-1.5 pl-2 pr-3 text-[12.5px] font-medium shadow-[0_0_0_1px_#0000000F,0_10px_30px_-12px_#00000059]"
      >
        <span className="size-2 animate-pulse rounded-full bg-[#2BB673]" />
        {tiles.length === 1 ? `${tiles[0].b?.name ?? "A bot"} is using ${tiles[0].app}` : `${tiles.length} windows in use on your Mac`}
      </button>
    );
  return (
    <div style={at} className="fixed z-40 flex w-[248px] flex-col gap-2">
      <div
        onPointerDown={drag}
        title="Drag to move"
        className="flex cursor-grab items-center gap-1 self-stretch rounded-full bg-white/90 py-0.5 pl-2.5 pr-1 shadow-[0_0_0_1px_#0000000F,0_6px_16px_-10px_#00000059] backdrop-blur active:cursor-grabbing"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0 text-[#9A9A98]" fill="currentColor">
          <circle cx="3" cy="2" r="1" />
          <circle cx="7" cy="2" r="1" />
          <circle cx="3" cy="5" r="1" />
          <circle cx="7" cy="5" r="1" />
          <circle cx="3" cy="8" r="1" />
          <circle cx="7" cy="8" r="1" />
        </svg>
        <span className="flex-1 truncate pl-1 text-[11.5px] font-medium text-[#6B6B6B]">On your Mac</span>
        {canPop && (
          <button
            onClick={() => (window as unknown as { bopsMac: { popOut: () => void } }).bopsMac.popOut()}
            title="Pop out: a small window that floats over every app"
            aria-label="Pop out"
            className="flex size-6 items-center justify-center rounded-full text-[#6B6B6B] hover:bg-black/[0.06] hover:text-ink"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 1.5h3.5V5M10.5 1.5L6 6M5 2.5H2.5v7h7V7" />
            </svg>
          </button>
        )}
        <button onClick={() => setSmall(true)} aria-label="Minimize previews" title="Fold into a pill" className="flex size-6 items-center justify-center rounded-full text-[#6B6B6B] hover:bg-black/[0.06] hover:text-ink">
          <svg width="9" height="9" viewBox="0 0 12 12">
            <path d="M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <MacTiles tiles={tiles} onOpen={onOpen} />
    </div>
  );
}

/** The time, every few seconds, so tiles of finished work leave on their own. */
function useNow2() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 3000);
    return () => clearInterval(t);
  }, []);
  return now;
}
