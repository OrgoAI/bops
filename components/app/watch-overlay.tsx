"use client";

import { useEffect, useState } from "react";
import type { Watch } from "@/lib/types";

/**
 * How a watched screen looks, the same on a bot's computer and on your Mac: a thin periwinkle ring
 * around it (yellow when something came in), a small pill in its corner with a blinking eye, what
 * Jev is looking for and when it last looked, and a soft band of light down the screen each time
 * Jev reads it. The pill is just the eye until you point at the screen (news and Paused stay open),
 * so it never gets in the way; the bar under the screen doesn't repeat it.
 */

/** The watch color: periwinkle, so it never reads as "working" (green) or "needs you" (yellow). */
export const WATCH = "#7A7AF0";

export function WatchEye({ size = 12, blink = false, color = "currentColor" }: { size?: number; blink?: boolean; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0 overflow-visible">
      <g className={blink ? "origin-center animate-[watch-blink_4.5s_ease-in-out_infinite]" : ""}>
        <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
        <circle cx="8" cy="8" r="2.1" fill={color} />
      </g>
    </svg>
  );
}

/** What's being watched, by name: the conversation or window, or the site. */
export const watchName = (w: Watch) => w.mac?.title ?? w.site;

/** "12s ago", kept fresh. */
function useAgo(at?: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  if (!at) return "not yet";
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 10 ? "just now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

/** Over a watched screen: the ring, the corner pill, and the sweep each time Jev reads it. */
/** A spot on the screen, as fractions of its width and height. */
export type Spot = { left: number; top: number; width: number; height: number };

export function WatchOverlay({ watch: w, small = false, rounded = "rounded-[22px]", anchor }: { watch: Watch; small?: boolean; rounded?: string; anchor?: Spot }) {
  const ago = useAgo(w.readAt);
  // Away: the screen shows something else right now, so the watch waits (grey) until it's back.
  const away = !!w.away && !w.alert;
  const ring = w.alert ? "#E8FF3A" : away ? "#C9C9C6" : WATCH;
  return (
    <div className={`pointer-events-none absolute inset-0 z-20 overflow-hidden ${rounded}`}>
      <div className={`absolute inset-0 ${rounded}`} style={{ boxShadow: `inset 0 0 0 ${small ? 2 : 3}px ${ring}${w.alert ? "" : "B3"}` }} />
      {/* One soft pass of light each time Jev reads the screen (keyed on when it read). */}
      {w.readAt && (
        <div
          key={w.readAt}
          className="absolute inset-x-0 top-0 h-1/3 animate-[watch-sweep_1400ms_ease-out_forwards]"
          style={{ background: `linear-gradient(to bottom, transparent, ${WATCH}24 55%, ${WATCH}40 75%, transparent)` }}
        />
      )}
      {!small && anchor && <AnchoredPill watch={w} anchor={anchor} away={away} ago={ago} />}
      {!small && !anchor && (
        <div
          className={`absolute left-3 top-3 flex items-center gap-1.5 overflow-hidden rounded-full bg-white/95 py-[3px] pl-1 shadow-[0_0_0_1px_#0000000F,0_6px_16px_-8px_#00000059] backdrop-blur transition-[max-width,padding] duration-300 ${
            w.alert || away ? "max-w-[75%] pr-2.5" : "max-w-[30px] pr-1 group-hover/screen:max-w-[75%] group-hover/screen:pr-2.5"
          }`}
        >
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full text-white" style={{ background: w.alert ? "#0A0A0A" : away ? "#9A9A98" : WATCH }}>
            <WatchEye size={13} blink={!w.alert && !away} color={w.alert ? "#E8FF3A" : "#FFFFFF"} />
          </span>
          <span className="min-w-0 truncate text-[12px] leading-4 text-ink">
            <PillText watch={w} away={away} ago={ago} />
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * On a Mac window: the eye sits exactly on the purple capsule macOS draws over a shared window's
 * traffic lights (same size and place). What's watched for slides out beside it while you point at
 * the screen (news and Paused stay out), so nothing covers the window otherwise.
 */
function AnchoredPill({ watch: w, anchor: a, away, ago }: { watch: Watch; anchor: Spot; away: boolean; ago: string }) {
  const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
  return (
    <>
      <span
        className={`absolute flex max-w-[70%] -translate-y-1/2 items-center rounded-full bg-white/95 py-[3px] pl-2.5 pr-2.5 text-[12px] leading-4 text-ink shadow-[0_0_0_1px_#0000000F,0_6px_16px_-8px_#00000059] backdrop-blur transition-opacity duration-200 ${
          w.alert || away ? "opacity-100" : "opacity-0 group-hover/screen:opacity-100"
        }`}
        style={{ left: `calc(${pct(a.left + a.width)} + 5px)`, top: pct(a.top + a.height / 2) }}
      >
        <span className="min-w-0 truncate">
          <PillText watch={w} away={away} ago={ago} />
        </span>
      </span>
    <span
      className="absolute flex items-center justify-center rounded-full"
      style={{
        // A pixel past the mark all round, so none of it shows at the edges.
        left: `calc(${pct(a.left)} - 1px)`,
        top: `calc(${pct(a.top)} - 1px)`,
        width: `calc(${pct(a.width)} + 2px)`,
        height: `calc(${pct(a.height)} + 2px)`,
        background: w.alert ? "#E8FF3A" : away ? "#9A9A98" : WATCH,
      }}
    >
      <WatchEye size={12} blink={!w.alert && !away} color={w.alert ? "#0A0A0A" : "#FFFFFF"} />
    </span>
    </>
  );
}

/** What a watch is doing, in a line: Paused, New, or what it's watching for. */
function PillText({ watch: w, away, ago }: { watch: Watch; away: boolean; ago: string }) {
  return away ? (
    <>
      <span className="font-semibold">Paused</span>
      <span className="text-[#6B6B6B]"> · {watchName(w)} isn&rsquo;t showing here right now</span>
    </>
  ) : w.alert ? (
    <>
      <span className="font-semibold">New</span> · {w.alert.text}
    </>
  ) : (
    <>
      <span className="font-semibold">Watching</span> for {w.lookFor.charAt(0).toLowerCase()}
      {w.lookFor.slice(1)}
      <span className="text-[#9A9A98]"> · looked {ago}</span>
    </>
  );
}

/** On a watched screen's tile: the eye in the watch color (or yellow when something came in). */
export function WatchBadge({ watch: w }: { watch: Watch }) {
  return (
    <span
      className="absolute left-1 top-1 z-10 flex size-[18px] items-center justify-center rounded-full shadow-[0_0_0_1.5px_#FFFFFF]"
      style={{ background: w.alert ? "#E8FF3A" : w.away ? "#9A9A98" : WATCH }}
      title={w.alert ? `New: ${w.alert.text}` : w.away ? `Paused: ${watchName(w)} isn't showing right now` : `Watching for ${w.lookFor}`}
    >
      <WatchEye size={11} blink={!w.alert && !w.away} color={w.alert ? "#0A0A0A" : "#FFFFFF"} />
    </span>
  );
}
