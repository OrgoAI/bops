"use client";

import { useEffect, useRef, useState } from "react";
import { afterVncClose, STREAM_RETRY_MS, type StreamPlan } from "@/lib/rtc";
import { Mascot } from "./mascot";
import { RtcDesktop, rtcWorthTrying } from "./rtc-desktop";
import { useWindowVisible } from "./window-visible";

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

/** How a screen is streaming, on the view as data-transport (for debugging): Orgo's WebRTC (UDP) or VNC. */
export type Transport = "udp" | "vnc";

/**
 * The bot's real desktop, live (app/api/vnc says how this screen can stream): VNC, drawn with noVNC,
 * through Orgo's proxy or over the tailnet, and for the boot screen Orgo's WebRTC too, H.264 over UDP.
 * Real windows you can drag and resize, the real terminal, Files, every installed app. View-only while
 * the bot drives; full mouse and keyboard once you've taken over.
 *
 * VNC shows the screen as soon as it connects, and WebRTC is tried alongside: its first frame fades in
 * over VNC, which is then let go. WebRTC that doesn't get there (UDP blocked on this network, a stream
 * smaller than the screen, anything else RtcDesktop gives up on) just ends, and the screen carries on
 * over VNC with nothing said. When it would have shrunk the screen, Bops puts the screen back (POST
 * /api/vnc). A stream that drops after it was live comes back by itself, the same way. Falls back
 * (onFail) when nothing connects at first, and the caller shows the mirror or video. Another screen
 * streamed through Orgo (?screen=) also goes by how Orgo closed it (afterVncClose): a screen Orgo can't
 * stream falls back at once and for good, one Orgo couldn't reach just then is tried again, and a
 * refused password gets one try with a fresh one. Thumbnails always use VNC: Orgo encodes at most two
 * WebRTC streams per computer. While the window is hidden a while, the screen rests (nothing streams).
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
  /**
   * Nothing connected, and the caller shows the screen another way. `noStream`: Orgo said it can't
   * stream this screen at all, so no view of it should try again.
   */
  onFail?: (noStream: boolean) => void;
  /** The real screen's size once connected, so the view can match its shape. */
  onSize?: (width: number, height: number) => void;
  /** A small live preview: lighter on the network and quiet while it connects. */
  thumbnail?: boolean;
  /** Whose screen it is, for the loading state ("Opening Sam's screen…"). */
  bot?: { id: string; name: string; color: string };
}) {
  const [plan, setPlan] = useState<StreamPlan | null>(null);
  // WebRTC for this plan: being tried (VNC shows the screen meanwhile), showing it, or not used.
  const [rtc, setRtc] = useState<"trying" | "live" | "off">("off");
  // VNC has the screen on show; it's let go once WebRTC's picture has faded in over it.
  const [vncUp, setVncUp] = useState(false);
  const [vncGone, setVncGone] = useState(false);
  // Bumped to try again (a fresh plan: the VNC password changes when the computer restarts).
  const [attempt, setAttempt] = useState(0);
  const connected = vncUp || rtc === "live";
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
  // Live at least once on this mount: after that a drop is retried here rather than handed to onFail.
  const ever = useRef(false);
  const backoff = useRef(0);
  // Orgo already turned this screen's password away once since it was last live: the next time is final.
  const refused = useRef(false);
  // VNC ended while WebRTC was still being tried (with its close code, when it had one): what follows
  // waits for WebRTC, which may yet show the screen.
  const vncDown = useRef<{ code?: number } | null>(null);
  // The window hidden a while (a thumbnail 10 seconds, the open screen a minute): the stream is let go, and
  // what drawing it holds with it, and a fresh plan connects again once the window is back.
  const visible = useWindowVisible();
  const [resting, setResting] = useState(false);
  useEffect(() => {
    if (visible) return;
    const t = setTimeout(
      () => {
        setResting(true);
        setVncUp(false);
        setRtc("off");
        setPlan(null);
        if (ever.current) setStage("reconnecting");
      },
      thumbnail ? 10_000 : 60_000,
    );
    return () => {
      clearTimeout(t);
      setResting(false);
    };
  }, [visible, thumbnail]);

  useEffect(() => {
    if (resting) return;
    let gone = false;
    void (async () => {
      const res = await fetch(`/api/vnc?bot=${botId}&display=${display}`, { cache: "no-store" });
      const p = (await res.json()) as StreamPlan;
      if (gone) return;
      const tryRtc = !thumbnail && !!p.rtc && rtcWorthTrying(p.rtc);
      if (!tryRtc && !p.vnc) throw new Error("no stream");
      vncDown.current = null;
      setPlan(p);
      setRtc(tryRtc ? "trying" : "off");
      setVncGone(false);
      setStage(ever.current ? "reconnecting" : "opening");
    })().catch(() => !gone && dropped());
    return () => {
      gone = true;
    };
    // A thumbnail's quality is fixed for its life; it never changes on a mounted view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, display, attempt, resting]);

  // WebRTC's picture fades in over VNC's (RtcDesktop, half a second); then VNC is let go.
  useEffect(() => {
    if (rtc !== "live") return;
    const t = setTimeout(() => {
      setVncGone(true);
      setVncUp(false);
    }, 600);
    return () => clearTimeout(t);
  }, [rtc]);

  const live = (w: number, h: number) => {
    ever.current = true;
    backoff.current = 0;
    refused.current = false;
    sized.current?.(w, h);
  };
  /** The stream ended or never started: try again if it had been live, else let the caller fall back. */
  function dropped() {
    if (!ever.current) return fail();
    retry();
  }
  function fail(noStream = false) {
    setVncUp(false);
    setRtc("off");
    failed.current?.(noStream);
  }
  /** Try again with a fresh plan, after a wait that grows with each try. */
  function retry() {
    setVncUp(false);
    setRtc("off");
    // Nothing connects until the fresh plan is in: the old one may carry a password gone with a restart.
    setPlan(null);
    if (ever.current) setStage("reconnecting");
    const wait = STREAM_RETRY_MS[Math.min(backoff.current++, STREAM_RETRY_MS.length - 1)];
    setTimeout(() => setAttempt((a) => a + 1), wait);
  }
  /** The VNC socket closed (`code`: how, when it closed with a code). */
  function vncEnded(code?: number) {
    setVncUp(false);
    // WebRTC has the screen, and VNC was on its way out.
    if (rtc === "live") return;
    if (rtc === "trying") {
      vncDown.current = { code };
      return;
    }
    afterVnc(code);
  }
  function afterVnc(code?: number) {
    const next = afterVncClose(code, { screen: !!plan?.screen, ever: ever.current, tries: backoff.current, refused: refused.current });
    if (next === "fail" || next === "no_stream") return fail(next === "no_stream");
    if (next === "reauth") refused.current = true;
    retry();
  }
  /** WebRTC ended, and why; `streamed`: it had been showing the screen. */
  function rtcEnded(reason: string, streamed: boolean) {
    // Orgo's gateway shrank the screen to fit its limit before saying so: Bops puts it back.
    if (reason === "shrunk") void fetch(`/api/vnc?bot=${botId}&display=${display}`, { method: "POST" }).catch(() => {});
    setRtc("off");
    // Live before: a fresh try, VNC first and WebRTC alongside again.
    if (streamed || !plan?.vnc) return dropped();
    // Never live: the screen carries on over VNC, unless VNC ended meanwhile.
    const down = vncDown.current;
    vncDown.current = null;
    if (down) afterVnc(down.code);
  }

  // Past a few seconds, the loading state says so.
  useEffect(() => {
    if (connected) return;
    const t = setTimeout(() => setSlow(true), 8000);
    return () => {
      clearTimeout(t);
      setSlow(false);
    };
  }, [connected, botId, display]);

  const transport: Transport | undefined = rtc === "live" ? "udp" : vncUp ? "vnc" : undefined;
  return (
    <div className={`relative overflow-hidden ${className ?? ""}`} data-transport={transport}>
      {plan?.vnc && !vncGone && (
        <VncDesktop
          key={`vnc-${attempt}`}
          url={plan.vnc}
          password={plan.password}
          interactive={interactive && rtc !== "live"}
          thumbnail={thumbnail}
          connected={vncUp}
          onLive={(w, h) => {
            setVncUp(true);
            live(w, h);
          }}
          onEnd={vncEnded}
        />
      )}
      {plan?.rtc && rtc !== "off" && (
        // Over VNC, and let through to it until WebRTC has the screen.
        <div className={`absolute inset-0 ${rtc === "live" ? "" : "pointer-events-none"}`}>
          <RtcDesktop
            key={`rtc-${attempt}`}
            url={plan.rtc}
            size={plan.size}
            interactive={interactive && rtc === "live"}
            onLive={(w, h) => {
              vncDown.current = null;
              setRtc("live");
              live(w, h);
            }}
            onSize={(w, h) => sized.current?.(w, h)}
            onEnd={rtcEnded}
          />
        </div>
      )}
      {!connected && <Waking thumbnail={!!thumbnail} bot={bot} text={stage === "reconnecting" ? "Reconnecting…" : slow ? "Taking a little longer than usual…" : stage === "opening" ? "Opening the screen…" : bot ? `Reaching ${bot.name}'s computer…` : "Reaching the computer…"} />}
    </div>
  );
}

/** The parts of noVNC's display (core/display.js) that decodeOffThePage takes over. */
type NoVncDisplay = {
  imageRect: (x: number, y: number, width: number, height: number, mime: string, arr: Uint8Array) => void;
  drawImage: (img: CanvasImageSource | DecodedRect, ...args: number[]) => void;
  _renderQPush: (action: object) => void;
};

/**
 * One JPEG or PNG piece of a frame, decoded in the window (ImageDecoder, else createImageBitmap), as noVNC's
 * render queue waits on an image: `complete`, its size, a "load" listener, and `src = ""` once drawn, which
 * closes the frame. Its size stays the piece's own (noVNC stops drawing a screen for good when they differ). A
 * piece that won't decode counts as loaded and draws nothing, so the queue never waits on it.
 */
class DecodedRect {
  complete = false;
  frame: VideoFrame | ImageBitmap | null = null;
  private loads: ((this: DecodedRect) => void)[] = [];
  constructor(
    bytes: Uint8Array,
    mime: string,
    public width: number,
    public height: number,
  ) {
    const done = (f: VideoFrame | ImageBitmap | null) => {
      this.frame = f;
      this.loaded();
    };
    // The bytes are copied now: noVNC reuses the buffer they sit in.
    const copy = bytes.slice();
    if (typeof ImageDecoder !== "function") {
      createImageBitmap(new Blob([copy], { type: mime })).then(done, () => done(null));
      return;
    }
    let dec: ImageDecoder;
    try {
      dec = new ImageDecoder({ data: copy, type: mime });
    } catch {
      done(null);
      return;
    }
    dec
      .decode()
      .then(
        (r) => done(r.image),
        () => done(null),
      )
      .finally(() => dec.close());
  }
  private loaded() {
    this.complete = true;
    for (const f of this.loads.splice(0)) f.call(this);
  }
  addEventListener(type: string, f: (this: DecodedRect) => void) {
    if (type === "load") this.loads.push(f);
  }
  removeEventListener(type: string, f: (this: DecodedRect) => void) {
    this.loads = this.loads.filter((x) => x !== f);
  }
  set src(v: string) {
    if (v !== "") return;
    this.frame?.close();
    this.frame = null;
  }
}

/**
 * noVNC draws each JPEG or PNG piece of a frame through a new <img> holding it as a base64 data URL
 * (display.js imageRect), and Chromium decodes and keeps every one: with a few screens live (the sidebar's
 * thumbnails are each a whole 1280x960 screen), the window grew about 350 MB a minute, 0.6 GB to 2.5 GB in
 * four minutes, until macOS killed it (10-18). Here each piece is decoded in the window with ImageDecoder
 * instead, drawn in order by noVNC's own queue, and closed as soon as it's drawn: no element, no data URL,
 * nothing kept. Not as a Blob for createImageBitmap, which is only the fallback: every Blob is kept track of in
 * Bops' main process, and at the 5,000 or so pieces a second of one moving screen (open, and as its thumbnail),
 * main and the window each grew about 60 MB a minute (10-18). A noVNC whose display isn't the one this was
 * written for (1.7) is left as it is. (scripts/test-vnc-decode.mjs)
 */
export function decodeOffThePage(rfb: object) {
  const display = (rfb as { _display?: Partial<NoVncDisplay> })._display;
  if (!display || typeof display.imageRect !== "function" || typeof display.drawImage !== "function" || typeof display._renderQPush !== "function") return;
  if (typeof ImageDecoder !== "function" && typeof createImageBitmap !== "function") return;
  const d = display as NoVncDisplay;
  const draw = d.drawImage.bind(d);
  d.drawImage = (img, ...args) => {
    if (!(img instanceof DecodedRect)) return draw(img, ...args);
    // Drawn with its source and size given: a VideoFrame has no width or height for noVNC to mark what changed.
    if (img.frame) draw(img.frame, 0, 0, img.width, img.height, args[0], args[1], img.width, img.height);
  };
  d.imageRect = (x, y, width, height, mime, arr) => {
    if (!width || !height) return;
    d._renderQPush({ type: "img", img: new DecodedRect(arr, mime, width, height), x, y, width, height });
  };
}

/** One screen over VNC, drawn with noVNC. `onEnd`: it couldn't connect, or it dropped, with the socket's close code when it had one. */
function VncDesktop({
  url,
  password,
  interactive,
  thumbnail,
  connected,
  onLive,
  onEnd,
}: {
  url: string;
  password?: string;
  interactive: boolean;
  thumbnail?: boolean;
  connected: boolean;
  onLive: (width: number, height: number) => void;
  onEnd: (code?: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const rfb = useRef<import("@novnc/novnc").default | null>(null);
  const cb = useRef({ onLive, onEnd });
  useEffect(() => {
    cb.current = { onLive, onEnd };
  });

  useEffect(() => {
    let gone = false;
    const el = host.current!;
    void (async () => {
      const { default: RFB } = await import("@novnc/novnc");
      if (gone) return;
      // The socket is opened here and handed to noVNC, which doesn't pass its close code on: the code is
      // how Orgo says why a screen didn't stream. This listener runs before noVNC's own.
      const ws = new WebSocket(url);
      let code: number | undefined;
      ws.addEventListener("close", (e) => (code = e.code));
      const r = new RFB(el, ws, { shared: true, credentials: { password } });
      decodeOffThePage(r);
      // A thumbnail fills its slot (cropped at the bottom, like a peek); the main view fits the whole screen.
      r.scaleViewport = !thumbnail;
      r.background = "transparent";
      r.qualityLevel = thumbnail ? 2 : 7;
      r.compressionLevel = thumbnail ? 8 : 2;
      r.viewOnly = true;
      r.addEventListener("connect", () => {
        // The canvas takes the remote framebuffer's size.
        const canvas = el.querySelector("canvas");
        cb.current.onLive(canvas?.width || 1280, canvas?.height || 960);
      });
      r.addEventListener("disconnect", () => !gone && cb.current.onEnd(code));
      rfb.current = r;
    })().catch(() => !gone && cb.current.onEnd());
    return () => {
      gone = true;
      rfb.current?.disconnect();
      rfb.current = null;
      el.replaceChildren();
    };
    // A thumbnail's quality is fixed for its life; it never changes on a mounted view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Taking over flips the same connection to full control; no reconnect.
  useEffect(() => {
    const r = rfb.current;
    if (!r) return;
    r.viewOnly = !interactive;
    if (interactive) r.focus();
  }, [interactive, connected]);

  return (
    <div
      ref={host}
      className={`h-full w-full transition-opacity duration-500 ${connected ? "opacity-100" : "opacity-0"} ${interactive ? "" : "pointer-events-none"} ${thumbnail ? "[&_canvas]:!h-auto [&_canvas]:!w-full [&>div]:!overflow-hidden" : ""}`}
    />
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
      <div className="absolute inset-0 animate-[shimmer_1.8s_ease-in-out_infinite] bg-gradient-to-r motion-reduce:hidden from-transparent via-white/45 to-transparent" />
      {!thumbnail && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5">
          {bot && (
            <span className="animate-[bob_2.4s_ease-in-out_infinite] motion-reduce:animate-none">
              <Mascot botId={bot.id} color={bot.color} size={40} />
            </span>
          )}
          <span className="rounded-full bg-white/85 px-3 py-1 text-[12.5px] font-medium leading-4 text-[#3A3A38] shadow-[0_0_0_1px_#0000000D,0_6px_16px_-8px_#00000033] backdrop-blur">{text}</span>
        </div>
      )}
    </div>
  );
}
