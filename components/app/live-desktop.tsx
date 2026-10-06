"use client";

import { useEffect, useRef, useState } from "react";
import { Mascot } from "./mascot";

// noVNC reports a screen's connection coming and going (couldn't connect yet, dropped, didn't say
// goodbye, data still arriving while it closes) as console errors. Bops handles all of those itself (it waits, retries, falls back), and in
// development a console error pops Next's error overlay, so those go to the debug log instead. Other
// noVNC errors (a display problem, say) still show. This runs before noVNC loads (lazily, below),
// which is when noVNC takes hold of console.error. The patch goes in once per page but reads the
// pattern fresh each time, so an edit here applies on hot reload too.
const CONNECTION_NOISE = /^(Disconnection timed out\.|Failed (when connecting|while connected|when disconnecting): |Tried changing state of a disconnected RFB object|Got data while (disconnected|in an invalid state))/;
const quiet = globalThis as typeof globalThis & { __bopsNoVncNoise?: RegExp };
if (typeof window !== "undefined") {
  const patched = !!quiet.__bopsNoVncNoise;
  quiet.__bopsNoVncNoise = CONNECTION_NOISE;
  if (!patched) {
    const error = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && quiet.__bopsNoVncNoise?.test(args[0])) return console.debug("[screen]", ...args);
      error(...args);
    };
  }
}

/**
 * The bot's real desktop, live: its screen's VNC stream (over the tailnet), drawn with noVNC.
 * Real windows you can drag and resize, the real terminal, Files, every installed app, at full
 * frame rate. View-only while the bot drives; full mouse and keyboard once you've taken over.
 *
 * Falls back (onFail) when the stream can't connect, and the caller shows the mirror or video.
 */
export function LiveDesktop({
  botId,
  display,
  interactive,
  className,
  onFail,
  onSize,
  thumbnail,
  bot,
}: {
  botId: string;
  display: number;
  interactive: boolean;
  className?: string;
  onFail?: () => void;
  /** The real screen's size once connected, so the view can match its shape. */
  onSize?: (width: number, height: number) => void;
  /** A small live preview: lighter on the network and quiet while it connects. */
  thumbnail?: boolean;
  /** Whose screen it is, for the loading state ("Opening Sam's screen…"). */
  bot?: { id: string; name: string; color: string };
}) {
  const host = useRef<HTMLDivElement>(null);
  const rfb = useRef<import("@novnc/novnc").default | null>(null);
  const [connected, setConnected] = useState(false);
  // How far the connection has got, for the loading state: reaching the computer, opening the
  // stream, or getting it back after a drop. "slow" once it has taken longer than usual.
  const [stage, setStage] = useState<"reaching" | "opening" | "reconnecting">("reaching");
  const [slow, setSlow] = useState(false);
  const failed = useRef(onFail);
  const sized = useRef(onSize);
  useEffect(() => {
    failed.current = onFail;
    sized.current = onSize;
  });

  useEffect(() => {
    let gone = false;
    let ever = false;
    const el = host.current!;
    void (async () => {
      const res = await fetch(`/api/vnc?bot=${botId}&display=${display}`, { cache: "no-store" });
      const info = (await res.json()) as { url?: string; password?: string };
      if (gone) return;
      if (!info.url) return failed.current?.();
      const { default: RFB } = await import("@novnc/novnc");
      if (gone) return;
      setStage("opening");
      const r = new RFB(el, info.url, { shared: true, credentials: { password: info.password } });
      // A thumbnail fills its slot (cropped at the bottom, like a peek); the main view fits the whole screen.
      r.scaleViewport = !thumbnail;
      r.background = "transparent";
      r.qualityLevel = thumbnail ? 2 : 7;
      r.compressionLevel = thumbnail ? 8 : 2;
      r.viewOnly = true;
      r.addEventListener("connect", () => {
        ever = true;
        setConnected(true);
        // The canvas takes the remote framebuffer's size.
        const canvas = el.querySelector("canvas");
        if (canvas?.width && canvas.height) sized.current?.(canvas.width, canvas.height);
      });
      r.addEventListener("disconnect", () => {
        setConnected(false);
        if (ever) setStage("reconnecting");
        if (!ever && !gone) failed.current?.();
      });
      rfb.current = r;
    })().catch(() => !gone && failed.current?.());
    return () => {
      gone = true;
      rfb.current?.disconnect();
      rfb.current = null;
      el.replaceChildren();
    };
    // A thumbnail's quality is fixed for its life; it never changes on a mounted view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, display]);

  // Past a few seconds, the loading state says so.
  useEffect(() => {
    if (connected) return;
    const t = setTimeout(() => setSlow(true), 8000);
    return () => {
      clearTimeout(t);
      setSlow(false);
    };
  }, [connected, botId, display]);

  // Taking over flips the same connection to full control; no reconnect.
  useEffect(() => {
    const r = rfb.current;
    if (!r) return;
    r.viewOnly = !interactive;
    if (interactive) r.focus();
  }, [interactive, connected]);

  return (
    <div className={`relative overflow-hidden ${className ?? ""}`}>
      <div
        ref={host}
        className={`h-full w-full transition-opacity duration-500 ${connected ? "opacity-100" : "opacity-0"} ${interactive ? "" : "pointer-events-none"} ${thumbnail ? "[&_canvas]:!h-auto [&_canvas]:!w-full [&>div]:!overflow-hidden" : ""}`}
      />
      {!connected && <Waking thumbnail={!!thumbnail} bot={bot} text={stage === "reconnecting" ? "Reconnecting…" : slow ? "Taking a little longer than usual…" : stage === "opening" ? "Opening the screen…" : bot ? `Reaching ${bot.name}'s computer…` : "Reaching the computer…"} />}
    </div>
  );
}

/**
 * While a screen connects: a ghost of the desktop (a window and the dock) with light sweeping
 * across it, and the bot waiting for its screen, saying how far along it is. Thumbnails get just
 * the ghost.
 */
export function Waking({ thumbnail, bot, text }: { thumbnail: boolean; bot?: { id: string; name: string; color: string }; text: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-live="polite" aria-label={text}>
      <div className={`absolute left-1/2 -translate-x-1/2 rounded-[6%/9%] bg-white/45 shadow-[inset_0_0_0_1px_#FFFFFF99] ${thumbnail ? "top-[10%] h-[70%] w-[84%]" : "top-[7%] h-[76%] w-[86%]"}`}>
        <div className={`flex items-center gap-[3%] border-b border-white/60 px-[2.5%] ${thumbnail ? "h-[16%]" : "h-[7%]"}`}>
          {[0, 1, 2].map((i) => (
            <span key={i} className="aspect-square h-[38%] rounded-full bg-white/80" />
          ))}
        </div>
      </div>
      <div className={`absolute bottom-[3%] left-1/2 -translate-x-1/2 rounded-[30%] bg-white/45 ${thumbnail ? "h-[10%] w-[30%]" : "h-[7%] w-[24%]"}`} />
      <div className="absolute inset-0 animate-[shimmer_1.8s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/45 to-transparent" />
      {!thumbnail && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5">
          {bot && (
            <span className="animate-[bob_2.4s_ease-in-out_infinite]">
              <Mascot botId={bot.id} color={bot.color} size={40} />
            </span>
          )}
          <span className="rounded-full bg-white/85 px-3 py-1 text-[12.5px] font-medium leading-4 text-[#3A3A38] shadow-[0_0_0_1px_#0000000D,0_6px_16px_-8px_#00000033] backdrop-blur">{text}</span>
        </div>
      )}
    </div>
  );
}
