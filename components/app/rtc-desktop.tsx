"use client";

import { useEffect, useRef, useState } from "react";
import {
  containedRect,
  parseChannelMsg,
  parseServerMsg,
  RFB_BUTTON,
  rfbButtons,
  RTC_ANSWER_MS,
  RTC_ATTEMPT_MS,
  RTC_CHANNEL_MS,
  RTC_CLOSE,
  RTC_INPUT_CHANNEL,
  RTC_LOSSY_CHANNEL,
  RTC_OPEN_MS,
  RTC_PING_MS,
  RTC_PONG_MS,
  RTC_READY_MS,
  RTC_RECOVER_MS,
  RTC_STALL_POLLS,
  RTC_STATS_MS,
  rtcRetryAfter,
  rtcShrank,
  toScreenPoint,
  wheelClicks,
  type RtcInput,
} from "@/lib/rtc";

type Keyboard = { onkeyevent: (keysym: number, code: string, down: boolean) => void; grab: () => void; ungrab: () => void };

/**
 * noVNC's keyboard, the one the VNC view types with: it turns key events into X11 keysyms with the
 * layout, AltGr, dead keys and releases on blur handled, so typing is the same on either transport.
 * The package exports only its RFB client, so the file is imported by its path (types/novnc.d.ts).
 */
const loadKeyboard = async (): Promise<new (target: HTMLElement) => Keyboard> => (await import("@/node_modules/@novnc/novnc/core/input/keyboard.js")).default;

/** Computers WebRTC didn't work for lately, until when (by signaling address): they stream over VNC till then. */
const skipUntil = new Map<string, number>();
const computerOf = (url: string) => url.split("?")[0];

/** Whether to try WebRTC for this computer now: it's in this browser, and it didn't just fail there. */
export function rtcWorthTrying(url: string) {
  return typeof RTCPeerConnection !== "undefined" && (skipUntil.get(computerOf(url)) ?? 0) <= Date.now();
}

/**
 * One screen over Orgo's WebRTC: the picture in a <video> fed over UDP, and the user's mouse and keys
 * back over a DataChannel while they've taken over. The connection carries full control, like the
 * VNC view's; input is only sent while `interactive`, so taking over and handing back never reconnect.
 *
 * Any failure ends it (`onEnd`) and the caller streams the screen over VNC instead: no socket in
 * time, no "ready" or answer from Orgo, a stream smaller than the screen (`size`: Orgo's gateway
 * shrank the screen to fit its limit, rtcShrank), UDP that doesn't get through, no first frame within
 * RTC_ATTEMPT_MS, a frozen picture, an input channel that never opens or stops answering. A computer
 * it didn't work for is streamed over VNC for a while before WebRTC is tried again (rtcRetryAfter).
 */
export function RtcDesktop({
  url,
  size,
  interactive,
  className,
  onLive,
  onSize,
  onEnd,
}: {
  /** Orgo's signaling socket for the computer, with its token. */
  url: string;
  /** The screen's real size: a stream Orgo says is smaller ends at once ("shrunk"). */
  size?: { w: number; h: number };
  interactive: boolean;
  className?: string;
  /** The first frame is on screen, at this size. */
  onLive: (width: number, height: number) => void;
  /** The remote screen changed size. */
  onSize?: (width: number, height: number) => void;
  /** It stopped, and why; `streamed`: it had been showing the screen. */
  onEnd: (reason: string, streamed: boolean) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const channel = useRef<{ send: (m: RtcInput) => boolean; sendMove: (m: RtcInput) => void } | null>(null);
  const screen = useRef(size ?? { w: 1280, h: 960 });
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState(false);
  const cb = useRef({ onLive, onSize, onEnd });
  useEffect(() => {
    cb.current = { onLive, onSize, onEnd };
  });
  const realW = size?.w;
  const realH = size?.h;

  useEffect(() => {
    const real = realW && realH ? { w: realW, h: realH } : undefined;
    let done = false;
    let streaming = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const after = (ms: number, fn: () => void) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
      return t;
    };
    const cancel = (t?: ReturnType<typeof setTimeout>) => {
      if (t === undefined) return;
      clearTimeout(t);
      timers.delete(t);
    };
    const polls = new Set<ReturnType<typeof setInterval>>();
    let ws: WebSocket | null = null;
    let pc: RTCPeerConnection | null = null;
    let dc: RTCDataChannel | null = null;
    let lossy: RTCDataChannel | null = null;
    let readyBy: ReturnType<typeof setTimeout> | undefined;
    let answerBy: ReturnType<typeof setTimeout> | undefined;
    let answered = false;

    const close = () => {
      timers.forEach(clearTimeout);
      timers.clear();
      polls.forEach(clearInterval);
      polls.clear();
      channel.current = null;
      for (const c of [dc, lossy]) {
        try {
          c?.close();
        } catch {}
      }
      try {
        pc?.close();
      } catch {}
      // Closed last and cleanly, so the gateway stops the computer's encoder right away.
      try {
        ws?.close(1000, "done");
      } catch {}
    };
    const end = (reason: string) => {
      if (done) return;
      done = true;
      close();
      setOpen(false);
      setLive(false);
      const wait = rtcRetryAfter(reason);
      if (wait && !streaming) skipUntil.set(computerOf(url), Date.now() + wait);
      console.info(`[screen] WebRTC ${streaming ? "stopped" : "didn't connect"} (${reason}); streaming over VNC`);
      cb.current.onEnd(reason, streaming);
    };
    const send = (m: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

    // The whole attempt, up to the first frame. Answered but never connected: UDP didn't get through.
    after(RTC_ATTEMPT_MS, () => !streaming && end(answered && pc?.connectionState !== "connected" ? "not_connected" : "no_first_frame"));

    /** Decoded frames so far, from the receiver's stats (null: no video stats yet). */
    const framesDecoded = async () => {
      let n: number | null = null;
      try {
        (await pc!.getStats()).forEach((s) => {
          const r = s as unknown as { type: string; kind?: string; framesDecoded?: number };
          if (r.type === "inbound-rtp" && r.kind === "video" && typeof r.framesDecoded === "number") n = r.framesDecoded;
        });
      } catch {}
      return n;
    };

    const firstFrame = () => {
      if (done || streaming) return;
      streaming = true;
      setLive(true);
      const v = video.current;
      cb.current.onLive(v?.videoWidth || screen.current.w, v?.videoHeight || screen.current.h);
      // Connected but frozen raises no event at all: count decoded frames.
      let last = -1;
      let still = 0;
      polls.add(
        setInterval(async () => {
          const n = await framesDecoded();
          if (done || pc?.connectionState !== "connected") return;
          if (n === null || n === last) {
            if (++still >= RTC_STALL_POLLS) end("media_stall");
            return;
          }
          still = 0;
          last = n;
        }, RTC_STATS_MS),
      );
    };

    const negotiate = async (lossyOffered: boolean) => {
      try {
        pc = new RTCPeerConnection({ iceServers: [] });
      } catch {
        return end("pc_construct_failed");
      }
      pc.ontrack = (e) => {
        const v = video.current;
        if (!v) return;
        v.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        // As little buffering as the network allows: lower latency on a clean link (Chrome's hints).
        try {
          const r = e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number };
          if ("jitterBufferTarget" in r) r.jitterBufferTarget = 0;
          if ("playoutDelayHint" in r) r.playoutDelayHint = 0;
        } catch {}
        void v.play().catch(() => {});
        // A frame decoded, not just a track: a track can arrive with no media behind it. The decoded
        // count is watched too, since the picture is see-through until then (and a screen that isn't
        // the one on show sits under a see-through layer), where the browser may not paint its frames.
        const rvfc = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
        rvfc.requestVideoFrameCallback?.(firstFrame);
        const poll = setInterval(async () => ((await framesDecoded()) ?? 0) > 0 && (clearInterval(poll), polls.delete(poll), firstFrame()), 250);
        polls.add(poll);
      };
      pc.onicecandidate = (e) => send({ type: "candidate", candidate: e.candidate ? e.candidate.toJSON() : null });
      let recover: ReturnType<typeof setTimeout> | undefined;
      pc.onconnectionstatechange = () => {
        if (done || !pc) return;
        const s = pc.connectionState;
        if (s === "connected") {
          cancel(recover);
          recover = undefined;
          // The input channel must open now too, or there's a picture nobody can click.
          after(RTC_CHANNEL_MS, () => dc?.readyState !== "open" && end("channel_never_opened"));
        } else if (s === "failed") end(streaming ? "ice_unrecovered" : "ice_failed");
        else if (s === "disconnected" && !recover) recover = after(RTC_RECOVER_MS, () => pc?.connectionState !== "connected" && end("ice_unrecovered"));
      };

      // Both channels are negotiated (same id on both sides): no renegotiation, nothing to wait for.
      try {
        dc = pc.createDataChannel(RTC_INPUT_CHANNEL.label, { ordered: true, negotiated: true, id: RTC_INPUT_CHANNEL.id });
        if (lossyOffered) lossy = pc.createDataChannel(RTC_LOSSY_CHANNEL.label, { ordered: false, maxRetransmits: 0, negotiated: true, id: RTC_LOSSY_CHANNEL.id });
      } catch {
        if (!dc) return end("channel_create_failed");
        lossy = null;
      }
      let pongAt = 0;
      dc.onopen = () => {
        const ch = dc!;
        const out = (c: RTCDataChannel | null, m: RtcInput) => {
          if (c?.readyState !== "open") return false;
          try {
            c.send(JSON.stringify(m));
            return true;
          } catch {
            return false;
          }
        };
        channel.current = { send: (m) => out(ch, m), sendMove: (m) => void (out(lossy, m) || out(ch, m)) };
        setOpen(true);
        // An open channel to a gateway that's gone quiet raises nothing either: it must answer pings.
        pongAt = performance.now();
        polls.add(
          setInterval(() => {
            if (done || ch.readyState !== "open") return;
            if (performance.now() - pongAt > RTC_PONG_MS) return end("input_unresponsive");
            out(ch, { t: "pi", ts: Date.now() });
          }, RTC_PING_MS),
        );
      };
      dc.onclose = () => streaming && end("channel_closed");
      dc.onmessage = (e) => {
        const m = typeof e.data === "string" ? parseChannelMsg(e.data) : null;
        if (!m) return;
        if (m.t === "po") pongAt = performance.now();
        else if (m.t === "sz") {
          screen.current = { w: m.w, h: m.h };
          cb.current.onSize?.(m.w, m.h);
        } else if (m.t === "err" && m.code === "input_backend_down") end("input_backend_down");
      };
      try {
        pc.addTransceiver("video", { direction: "recvonly" });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: "offer", sdp: offer.sdp });
      } catch {
        return end("offer_failed");
      }
      answerBy = after(RTC_ANSWER_MS, () => end("no_answer"));
    };

    const openBy = after(RTC_OPEN_MS, () => end("socket_open_timeout"));
    try {
      ws = new WebSocket(url);
    } catch {
      end("socket_failed");
      return close;
    }
    ws.onopen = () => {
      cancel(openBy);
      readyBy = after(RTC_READY_MS, () => end("no_ready"));
    };
    ws.onmessage = (e) => {
      if (done || typeof e.data !== "string") return;
      const m = parseServerMsg(e.data);
      if (!m) return;
      if (m.type === "ready") {
        cancel(readyBy);
        // Orgo's gateway shrinks a screen bigger than its limit before it says so: stop before any picture.
        if (rtcShrank(m.video, real)) {
          console.info(`[screen] WebRTC would stream the screen at ${m.video!.w}x${m.video!.h}, not ${real!.w}x${real!.h}`);
          return end("shrunk");
        }
        if (m.video) screen.current = { w: m.video.w, h: m.video.h };
        void negotiate(!!m.lossyInputChannel && m.lossyInputChannel.id === RTC_LOSSY_CHANNEL.id);
      } else if (m.type === "answer") {
        cancel(answerBy);
        answered = true;
        pc?.setRemoteDescription({ type: "answer", sdp: m.sdp }).catch(() => end("answer_rejected"));
      } else if (m.type === "candidate") {
        if (m.candidate) pc?.addIceCandidate(m.candidate).catch(() => {});
      } else if (m.type === "error") end(`error_${m.code}`);
    };
    ws.onerror = () => !streaming && end("socket_error");
    ws.onclose = (e) => {
      if (done) return;
      // Orgo hung up. A protocol or rate close would come again on a new try; anything else may not.
      end(e.code === 1000 ? "socket_closed" : e.code === RTC_CLOSE.PROTOCOL || e.code === RTC_CLOSE.RATE ? `ws_protocol_${e.code}` : `ws_close_${e.code}`);
    };
    return () => {
      done = true;
      close();
    };
  }, [url, realW, realH]);

  // Taking over sends this screen the user's mouse and keys; handing back stops them, on the same connection.
  useEffect(() => {
    const el = surface.current;
    if (!interactive || !open || !el) return;
    let detach: (() => void) | undefined;
    let gone = false;
    void loadKeyboard()
      .then((K) => {
        if (gone || !channel.current) return;
        detach = attachInput(el, () => video.current, screen, channel.current, K);
        el.focus();
      })
      .catch((e: Error) => console.warn(`[screen] no keyboard for WebRTC: ${e.message}`));
    return () => {
      gone = true;
      detach?.();
    };
  }, [interactive, open]);

  return (
    <div
      ref={surface}
      tabIndex={interactive ? 0 : -1}
      // The computer draws its own pointer into the picture; a second one here would just trail it.
      className={`relative flex h-full w-full items-center justify-center outline-none ${interactive ? "cursor-none" : "pointer-events-none"} ${className ?? ""}`}
      style={{ touchAction: interactive ? "none" : "auto", userSelect: "none" }}
    >
      <video ref={video} autoPlay playsInline muted aria-hidden className={`h-full w-full object-contain transition-opacity duration-500 ${live ? "opacity-100" : "opacity-0"}`} />
    </div>
  );
}

/**
 * The user's mouse, wheel and keys on the picture, to the computer: pointer positions in the remote
 * screen's pixels (moves coalesced, and on the lossy channel when there is one), presses and releases
 * at once, a wheel click as a press and a release, keys as keysyms. Everything held is let go when
 * the window loses focus and when this detaches, so nothing stays pressed on the computer.
 */
function attachInput(
  el: HTMLElement,
  picture: () => HTMLVideoElement | null,
  screen: { current: { w: number; h: number } },
  out: { send: (m: RtcInput) => boolean; sendMove: (m: RtcInput) => void },
  KeyboardClass: new (target: HTMLElement) => Keyboard,
) {
  let mask = 0;
  let at: { x: number; y: number } | null = null;
  let move: { x: number; y: number } | null = null;
  let moveTimer: ReturnType<typeof setTimeout> | null = null;
  let carryX = 0;
  let carryY = 0;
  const keys = new Map<string, number>();

  const point = (e: MouseEvent) => {
    const v = picture();
    const box = v?.getBoundingClientRect();
    const rect = box && box.width > 0 ? containedRect(box, v!.videoWidth ? { w: v!.videoWidth, h: v!.videoHeight } : screen.current) : el.getBoundingClientRect();
    return toScreenPoint(e.clientX, e.clientY, rect, screen.current);
  };
  const now = (x: number, y: number, b: number) => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = null;
    move = null;
    at = { x, y };
    out.send({ t: "p", x, y, b });
  };
  const onMove = (e: PointerEvent) => {
    if (!e.isPrimary) return;
    const p = point(e);
    const b = mask ? rfbButtons(e.buttons) : 0;
    // A button pressed or let go mid-drag arrives as a move: it goes at once, like a press.
    if (b !== mask) {
      mask = b;
      return now(p.x, p.y, mask);
    }
    at = p;
    move = p;
    moveTimer ??= setTimeout(() => {
      moveTimer = null;
      if (move) out.sendMove({ t: "p", ...move, b: mask });
      move = null;
    }, 8);
  };
  const onDown = (e: PointerEvent) => {
    if (!e.isPrimary) return;
    el.focus();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    mask = rfbButtons(e.buttons);
    const p = point(e);
    now(p.x, p.y, mask);
  };
  const onUp = (e: PointerEvent) => {
    if (!e.isPrimary) return;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {}
    mask = rfbButtons(e.buttons);
    const p = point(e);
    now(p.x, p.y, mask);
  };
  const letGo = () => {
    if (mask && at) now(at.x, at.y, 0);
    mask = 0;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = point(e);
    const y = wheelClicks(carryY, e.deltaY, e.deltaMode);
    const x = wheelClicks(carryX, e.deltaX, e.deltaMode);
    carryY = y.rest;
    carryX = x.rest;
    const click = (bit: number, n: number) => {
      for (let i = 0; i < n; i++) {
        out.send({ t: "p", ...p, b: mask | bit });
        out.send({ t: "p", ...p, b: mask });
      }
    };
    click(RFB_BUTTON.WHEEL_UP, Math.max(0, -y.clicks));
    click(RFB_BUTTON.WHEEL_DOWN, Math.max(0, y.clicks));
    click(RFB_BUTTON.WHEEL_LEFT, Math.max(0, -x.clicks));
    click(RFB_BUTTON.WHEEL_RIGHT, Math.max(0, x.clicks));
  };
  const noMenu = (e: MouseEvent) => e.preventDefault();

  const kbd = new KeyboardClass(el);
  kbd.onkeyevent = (sym, code, down) => {
    if (down) keys.set(code, sym);
    else keys.delete(code);
    out.send({ t: "k", sym, code, d: down });
  };
  kbd.grab();
  const releaseAll = () => {
    for (const [code, sym] of keys) out.send({ t: "k", sym, code, d: false });
    keys.clear();
    letGo();
  };
  const onHidden = () => document.visibilityState !== "visible" && releaseAll();

  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", letGo);
  el.addEventListener("pointerleave", letGo);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("contextmenu", noMenu);
  window.addEventListener("blur", releaseAll);
  document.addEventListener("visibilitychange", onHidden);
  return () => {
    releaseAll();
    if (moveTimer) clearTimeout(moveTimer);
    try {
      kbd.ungrab();
    } catch {}
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", letGo);
    el.removeEventListener("pointerleave", letGo);
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("contextmenu", noMenu);
    window.removeEventListener("blur", releaseAll);
    document.removeEventListener("visibilitychange", onHidden);
  };
}
