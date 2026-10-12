"use client";

import { createContext, useContext } from "react";
import { mascotMarkup } from "@/lib/mascot";

/**
 * Plush-style bot mascots with headphones (lib/mascot.ts draws them). Every mascot in the app reads
 * which bots are at work from one place (BusyBots, set at the top of the app): a busy bot opens its
 * eyes, an idle one vibes with them closed.
 */
export const BusyBots = createContext<ReadonlySet<string>>(new Set());

export function Mascot({
  botId,
  color,
  size = 24,
  antenna = true,
}: {
  botId: string;
  color: string;
  size?: number;
  /** The main bot's highlighter headphones; false draws them in ink (the chat pill's small mark). */
  antenna?: boolean;
}) {
  const awake = useContext(BusyBots).has(botId);
  // Markup comes from our own constant shapes and bot colors, never from user text.
  return (
    <svg
      viewBox="0 0 40 40"
      style={{ width: size, height: size, flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: mascotMarkup(botId, color, { mood: awake ? "awake" : "idle", accent: antenna }) }}
    />
  );
}

export function Spinner({ size = 13, color = "#0A0A0A" }: { size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 14 14" width={size} height={size} className="animate-spin" style={{ flexShrink: 0 }}>
      <circle cx="7" cy="7" r="5.2" fill="none" stroke={color} strokeWidth="1.6" strokeDasharray="24 9" strokeLinecap="round" />
    </svg>
  );
}

/** ♪ and ♫, as on bops.bot (site/notes.js). */
const NOTES = [
  '<ellipse cx="7" cy="17.5" rx="3.3" ry="2.5" transform="rotate(-20 7 17.5)"/><rect x="9.4" y="4" width="1.8" height="13.6" rx=".9"/><path d="M11.2 4c0 3.2 4.8 3.8 4.8 7.6-.9-1.7-2.7-2.4-4.8-2.7z"/>',
  '<ellipse cx="6" cy="18.3" rx="3" ry="2.3" transform="rotate(-20 6 18.3)"/><ellipse cx="17.6" cy="16.3" rx="3" ry="2.3" transform="rotate(-20 17.6 16.3)"/><rect x="8.1" y="6.2" width="1.7" height="12" rx=".85"/><rect x="19.7" y="4.2" width="1.7" height="12" rx=".85"/><path d="M8.1 6.2 21.4 3.6v2.9L8.1 9.1z"/>',
];

/**
 * Boppy listening to music, bopping to the beat while notes drift out of its headphones: the app's
 * first load, the same scene as the window's splash (desktop/splash.html). CSS only (globals.css).
 */
export function BoppyLoading({ label }: { label: string }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3.5 text-[13px] text-pencil select-none">
      <div className="boppy-loading-scene" aria-hidden="true">
        <div className="boppy-loading-shadow" />
        {(["l", "r", "l", "r"] as const).map((side, i) => (
          <svg key={i} className={`boppy-loading-note ${side}`} viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: `<g fill="#0A0A0A">${NOTES[i === 0 || i === 3 ? 0 : 1]}</g>` }} />
        ))}
        <svg className="boppy-loading-boppy" viewBox="0 0 40 40" dangerouslySetInnerHTML={{ __html: mascotMarkup("boppy", "#0A0A0A", { mood: "awake" }) }} />
      </div>
      <div>{label}</div>
    </div>
  );
}
