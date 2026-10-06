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
