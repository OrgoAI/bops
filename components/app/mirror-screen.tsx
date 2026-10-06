"use client";

import "@rrweb/replay/dist/style.css";
import { Replayer } from "@rrweb/replay";
import { useEffect, useRef, useState } from "react";
import { useTyping, type ScreenInput } from "./live-screen";

export type MirrorTab = { id: string; title: string; url: string; active: boolean };

/**
 * The mirrored computer: the bot's real page, rebuilt here as live DOM from rrweb events instead
 * of shown as screenshots. Crisp at any size, selectable text, and the bot's cursor moves on it.
 * Page scripts never run here (rrweb replays into a sandboxed iframe).
 *
 * Falls back (onFail) when the screen can't be mirrored, and the caller shows video instead.
 * When `interactive`, clicks, scrolls and typing go to the real screen like the video view.
 */
export function MirrorScreen({
  botId,
  display,
  className,
  interactive,
  onInput,
  onFail,
  onTabs,
}: {
  botId: string;
  display: number;
  className?: string;
  interactive?: boolean;
  onInput?: (action: ScreenInput) => void;
  onFail?: () => void;
  /** The bot's open tabs, as the mirror sees them (the active one is mirrored). */
  onTabs?: (tabs: MirrorTab[]) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<{ w: number; h: number } | null>(null);
  const [fit, setFit] = useState(1);
  const failed = useRef(onFail);
  const tabsTo = useRef(onTabs);
  useEffect(() => {
    failed.current = onFail;
    tabsTo.current = onTabs;
  });

  useEffect(() => {
    const root = stage.current!;
    let replayer: Replayer | undefined;
    let seen = false;
    const es = new EventSource(`/api/mirror?bot=${botId}&display=${display}`);
    const fail = () => {
      es.close();
      failed.current?.();
    };
    const timeout = setTimeout(() => !seen && fail(), 8000);
    es.onmessage = (m) => {
      const event = JSON.parse(m.data) as
        | { type: number; timestamp: number; data: { width?: number; height?: number } }
        | { type: "bops-tabs"; tabs: MirrorTab[] };
      if (event.type === "bops-tabs") {
        tabsTo.current?.(event.tabs);
        return;
      }
      if (!replayer) {
        if (event.type !== 4) return; // start from a page's Meta event
        replayer = new Replayer([], { root, liveMode: true, mouseTail: false, showWarning: false, triggerFocus: false, UNSAFE_replayCanvas: false });
        replayer.on("resize", (d) => {
          const { width, height } = d as { width: number; height: number };
          setPage({ w: width, h: height });
        });
        // Play the backlog at once, then follow along a beat behind real time.
        replayer.startLive(Date.now() - 250);
        seen = true;
      }
      if (event.type === 4 && event.data.width) setPage({ w: event.data.width, h: event.data.height ?? 0 });
      replayer.addEvent(event as never);
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && !seen) fail();
    };
    return () => {
      clearTimeout(timeout);
      es.close();
      replayer?.destroy();
      root.replaceChildren();
    };
  }, [botId, display]);

  // Scale the page to fit, like object-contain.
  useEffect(() => {
    const el = host.current;
    if (!el || !page) return;
    const measure = () => setFit(Math.min(el.clientWidth / page.w, el.clientHeight / page.h));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [page]);

  /** A point on the scaled page as fractions of the real viewport. */
  const at = (e: React.MouseEvent) => {
    const box = stage.current!.getBoundingClientRect();
    const fx = (e.clientX - box.left) / box.width;
    const fy = (e.clientY - box.top) / box.height;
    return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? { fx, fy } : null;
  };
  const key = useTyping(interactive, onInput);

  return (
    <div ref={host} tabIndex={interactive ? 0 : undefined} onKeyDown={key} className={`relative overflow-hidden bg-white outline-none ${className ?? ""}`}>
      <div
        ref={stage}
        className="bops-mirror absolute left-1/2 top-1/2 origin-center"
        style={page ? { width: page.w, height: page.h, transform: `translate(-50%, -50%) scale(${fit})` } : { visibility: "hidden" }}
      />
      {interactive && (
        <div
          className="absolute inset-0 cursor-crosshair"
          onClick={(e) => {
            const p = at(e);
            if (p) onInput?.({ kind: "click", ...p });
          }}
          onWheel={(e) => {
            const p = at(e);
            if (p) onInput?.({ kind: "scroll", ...p, dy: e.deltaY });
          }}
        />
      )}
      {!page && <div className="absolute inset-0 flex items-center justify-center text-[12px] text-[#9A9A98]">Mirroring…</div>}
    </div>
  );
}
