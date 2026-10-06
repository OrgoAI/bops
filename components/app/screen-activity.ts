"use client";

import { useEffect, useState } from "react";
import type { Bot } from "@/lib/types";

/**
 * When an agent last acted (clicked, typed, scrolled) on each of a bot's screens, by display, in
 * this Mac's clock. Streamed live from the computer's home server over the tailnet, so following
 * the action lags by well under a second. Empty for computers Bops can't reach directly.
 */
export function useScreenActivity(b: Bot) {
  const ip = b.tailnet?.ip;
  // Kept with the computer it came from, so switching bots never shows the last one's activity.
  const [acted, setActed] = useState<{ ip?: string; at: Record<number, number> }>({ at: {} });

  useEffect(() => {
    if (!ip) return;
    const es = new EventSource(`http://${ip}:7600/activity`);
    es.onmessage = (m) => {
      const a = JSON.parse(m.data) as { display: number; ago: number };
      const at = Date.now() - a.ago * 1000;
      setActed((x) => {
        const prev = x.ip === ip ? x.at : {};
        return prev[a.display] && prev[a.display] >= at ? x : { ip, at: { ...prev, [a.display]: at } };
      });
    };
    return () => es.close();
  }, [ip]);

  return ip && acted.ip === ip ? acted.at : {};
}
