"use client";

import { useEffect, useRef, useState } from "react";
import { Waking } from "./live-desktop";
import { useWindowVisible } from "./window-visible";

/**
 * A live view of one screen on a bot's computer, refreshed by polling screenshots.
 * Each frame is preloaded before it replaces the last, so the image never flashes.
 * Give it a `key` of bot + display so switching screens starts from a blank frame.
 * No screenshots while the window is hidden: the last frame stays, and they start again as it shows.
 *
 * When `interactive` (you've taken over), clicks are sent as fractions of the real screen
 * and typing goes to whatever is focused there.
 */
export function LiveScreen({
  botId,
  display,
  intervalMs = 1500,
  scale = 0.75,
  className,
  interactive,
  onInput,
  onFail,
  bot,
  mac,
}: {
  /** Whose screen it is, for the loading state. */
  bot?: { id: string; name: string; color: string };
  botId: string;
  display: number;
  intervalMs?: number;
  scale?: number;
  className?: string;
  interactive?: boolean;
  onInput?: (action: ScreenInput) => void;
  /** A screenshot didn't come (the computer may have fallen asleep since: the caller looks again). */
  onFail?: () => void;
  /** The Chrome a task of the bot's has of its own on the user's Mac (Session.macScreen), instead of a screen. */
  mac?: number;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const visible = useWindowVisible();
  const failed = useRef(onFail);
  useEffect(() => {
    failed.current = onFail;
  });

  useEffect(() => {
    if (!visible) return;
    // This run's own: a frame still loading when the window hid (or anything else re-ran this) must not
    // start the old loop again next to the new one.
    let on = true;
    let timer: ReturnType<typeof setTimeout>;
    // Failing since the last frame that came: the caller hears once per run of failures, not each try.
    let failing = false;
    const tick = () => {
      const url = `/api/screen?bot=${botId}&${mac !== undefined ? `mac=${mac}` : `display=${display}`}&scale=${scale}&t=${Date.now()}`;
      const next = new Image();
      next.onload = () => {
        if (!on) return;
        failing = false;
        setSrc(url);
        setError(false);
        timer = setTimeout(tick, interactive ? Math.min(intervalMs, 700) : intervalMs);
      };
      next.onerror = () => {
        if (!on) return;
        setError(true);
        if (!failing) failed.current?.();
        failing = true;
        timer = setTimeout(tick, intervalMs * 3);
      };
      next.src = url;
    };
    tick();
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [botId, display, mac, intervalMs, scale, interactive, visible]);

  /** Map a click on the letterboxed image to a point on the real screen. */
  const point = (e: React.MouseEvent) => {
    const el = img.current;
    if (!interactive || !onInput || !el?.naturalWidth) return;
    const box = el.getBoundingClientRect();
    const ratio = Math.min(box.width / el.naturalWidth, box.height / el.naturalHeight);
    const w = el.naturalWidth * ratio;
    const h = el.naturalHeight * ratio;
    const fx = (e.clientX - box.left - (box.width - w) / 2) / w;
    const fy = (e.clientY - box.top - (box.height - h) / 2) / h;
    return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? { fx, fy } : null;
  };
  const click = (e: React.MouseEvent) => {
    const p = point(e);
    if (p) onInput?.({ kind: "click", ...p });
  };
  const wheel = (e: React.WheelEvent) => {
    const p = point(e);
    if (p) onInput?.({ kind: "scroll", ...p, dy: e.deltaY });
  };

  const key = useTyping(interactive, onInput);

  return (
    <div
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={key}
      className={`relative overflow-hidden bg-white outline-none ${interactive ? "cursor-crosshair" : ""} ${className ?? ""}`}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img ref={img} src={src} alt={`${botId} screen :${display}`} onClick={click} onWheel={wheel} draggable={false} className="block h-full w-full select-none object-contain" />
      ) : error ? (
        <div className="flex h-full w-full items-center justify-center text-[12px] text-[#9A9A98]">Screen unavailable</div>
      ) : (
        <div className="relative h-full w-full bg-[#F7F7F6]">
          <Waking thumbnail={scale < 0.5} bot={bot} text={bot ? `Reaching ${bot.name}'s computer…` : "Reaching the computer…"} />
        </div>
      )}
    </div>
  );
}

export type ScreenInput =
  | { kind: "click"; fx: number; fy: number }
  | { kind: "scroll"; fx: number; fy: number; dy: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string };

/** Keyboard handling while you've taken over: quick typing is batched, special keys sent by name. */
export function useTyping(interactive: boolean | undefined, onInput: ((action: ScreenInput) => void) | undefined) {
  const typed = useRef("");
  const flush = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  return (e: React.KeyboardEvent) => {
    if (!interactive || !onInput) return;
    const special: Record<string, string> = { Enter: "Return", Backspace: "BackSpace", Tab: "Tab", Escape: "Escape", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
    if (e.metaKey || e.ctrlKey) {
      if (e.key.length === 1) {
        e.preventDefault();
        onInput({ kind: "key", key: `ctrl+${e.key.toLowerCase()}` });
      }
      return;
    }
    e.preventDefault();
    if (e.key.length === 1) {
      typed.current += e.key;
      clearTimeout(flush.current);
      flush.current = setTimeout(() => {
        const text = typed.current;
        typed.current = "";
        if (text) onInput({ kind: "type", text });
      }, 160);
    } else if (special[e.key]) onInput({ kind: "key", key: special[e.key] });
  };
}
