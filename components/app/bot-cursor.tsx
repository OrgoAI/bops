"use client";

import { useEffect, useState } from "react";
import type { Bot } from "@/lib/types";
import { Mascot } from "./mascot";

/**
 * The bot's own cursor over its live desktop. A VNC view only draws your pointer, so while the bot
 * drives we follow its real pointer (streamed from the computer's home server over the tailnet)
 * and draw it as a pointer with the bot's mascot, plus a word on what it's doing.
 */
export function BotCursor({ bot: b, ip = b.tailnet?.ip, display, caption, helper }: { bot: Bot; /** The computer's tailnet address, when it's not the bot's own (a shared one). */ ip?: string; display: number; caption?: string; helper?: string }) {
  const [at, setAt] = useState<{ fx: number; fy: number } | null>(null);

  useEffect(() => {
    if (!ip) return;
    const es = new EventSource(`http://${ip}:7600/pointer?display=:${display}`);
    es.onmessage = (m) => {
      const p = JSON.parse(m.data) as { x: number; y: number; w: number; h: number };
      if (p.w && p.h) setAt({ fx: p.x / p.w, fy: p.y / p.h });
    };
    return () => es.close();
  }, [ip, display]);

  if (!at) return null;
  return (
    <div
      className="pointer-events-none absolute z-10 transition-[left,top] duration-200 ease-out"
      style={{ left: `${at.fx * 100}%`, top: `${at.fy * 100}%` }}
    >
      <svg width="18" height="20" viewBox="0 0 18 20" className="-ml-px -mt-px drop-shadow-[0_2px_3px_rgba(0,0,0,0.35)]">
        <path d="M1.5 1.5l14 7.2-6.2 1.6-3 6.2z" fill={b.isMain ? "#0A0A0A" : b.color} stroke="#FFFFFF" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <div className="ml-3 mt-0.5 flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white/95 py-[3px] pl-[3px] pr-2.5 shadow-[0_0_0_1px_#0000000F,0_6px_14px_-6px_#00000059]">
        <Mascot botId={b.id} color={b.color} size={18} />
        <span className="text-[11.5px] font-medium leading-[14px] text-ink">
          {helper !== undefined ? `${b.name}'s helper${helper ? ` ${helper}` : ""}${caption ? ` · ${caption}` : ""}` : caption ? `${b.name} is ${caption}` : b.name}
        </span>
      </div>
    </div>
  );
}
