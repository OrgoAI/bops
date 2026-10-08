/**
 * Orgo's WebRTC screen stream, the parts the app and the tests share: what the signaling socket and the
 * input channel carry, how long each step may take before the app streams over VNC instead, and how a
 * point on the picture becomes a point on the remote screen. Ported from orgo-web's own client
 * (lib/rtc/protocol.ts, lib/rtc/input.ts, hooks/useRtcSession.ts); keep the shapes in step with them.
 *
 * The path: the app and Orgo talk over wss://<orgo>/desktops/{id}/ws/rtc?token=<VNC password> (JSON
 * text frames); Orgo passes that on to the WebRTC gateway on the computer's server; the gateway sends
 * the screen as H.264 over UDP straight to the app, and types the app's input (a DataChannel) into the
 * computer's VNC. There's no STUN or TURN: the server has a public address, so a network that blocks
 * UDP to it gets VNC. Orgo's WebRTC streams the boot screen (display 99) only.
 */

/** How the app can stream one screen's real desktop, best first (app/api/vnc, LiveDesktop). */
export type StreamPlan = {
  /** Orgo's WebRTC signaling socket: H.264 over UDP, input over a DataChannel. */
  rtc?: string;
  /**
   * The screen's real size, with `rtc`: WebRTC that would stream it smaller isn't used (rtcShrank),
   * since Orgo's gateway gets there by shrinking the screen itself.
   */
  size?: { w: number; h: number };
  /** A VNC websocket for noVNC: Orgo's own proxy, or the screen's own bridge over the tailnet. */
  vnc?: string;
  /** The computer's VNC password, for the VNC handshake. */
  password?: string;
  /**
   * Orgo's id for the screen when `vnc` is Orgo's proxy streaming one of the other screens
   * (?screen=): how Orgo closes that socket then says what to do next (afterVncClose).
   */
  screen?: string;
};

/** Orgo closes its stream sockets with these: the signaling socket, and the VNC one where it says so. */
export const RTC_CLOSE = {
  /** Not allowed (bad token, or an origin Orgo doesn't take). VNC would be turned away too. */
  AUTH: 4001,
  /** The computer isn't running. */
  INACTIVE: 4003,
  NOT_FOUND: 4004,
  /** Orgo couldn't look the computer up. */
  LOOKUP_FAILED: 4503,
  /** Something sent broke the protocol (a third offer, a binary frame). */
  PROTOCOL: 4008,
  /** Too big or too many messages. */
  RATE: 4009,
  /** WebRTC is off for this computer, or it was asked for a screen other than the boot screen. */
  DISABLED: 4010,
  /** VNC (?screen=): the computer has no such screen, or Orgo can't stream it (a computer not on an Orgo host). */
  NO_SUCH_SCREEN: 4012,
  /** Orgo couldn't reach the computer (for ?screen=, ask it about the screen). */
  NO_BACKEND: 4502,
  /** The gateway is down or turned the session away. */
  GATEWAY_DOWN: 4520,
} as const;

/**
 * How long one WebRTC attempt may take before the app gives up on it and keeps the screen on VNC, which
 * shows it meanwhile, from the start (ms). The steps' own limits fail a dead path sooner: the socket opening, Orgo's "ready" (the gateway
 * has started the computer's encoder by then), the answer to the app's offer, and the first frame.
 */
export const RTC_ATTEMPT_MS = 10_000;
export const RTC_OPEN_MS = 3_000;
export const RTC_READY_MS = 5_000;
export const RTC_ANSWER_MS = 3_000;
/** The input channel must open this soon after the connection does: a picture you can't click is worse than VNC. */
export const RTC_CHANNEL_MS = 6_000;
/** Decoded frames are counted this often; this many counts in a row without a new frame is a frozen stream. */
export const RTC_STATS_MS = 2_000;
export const RTC_STALL_POLLS = 3;
/** The input channel is pinged this often, and is dead with no answer for the second. */
export const RTC_PING_MS = 5_000;
export const RTC_PONG_MS = 12_000;
/** A connection that drops (Wi-Fi blips) gets this long to come back by itself. */
export const RTC_RECOVER_MS = 5_000;

/**
 * After WebRTC didn't work for a computer, how long the app streams it over VNC before trying WebRTC
 * again (ms). A day when it would have shrunk the screen (RTC_SHRUNK_MS). Long when UDP itself never
 * got through (blocked on this network) or Orgo has WebRTC off for the computer; short for anything else (a slow start, the gateway busy or restarting, two other
 * viewers already streaming), which says little about the next try; none when the computer itself is
 * unreachable (stopped, gone), since VNC fails the same way and WebRTC goes first again once it's back.
 */
export function rtcRetryAfter(reason: string): number {
  if (reason === "shrunk") return RTC_SHRUNK_MS;
  if (/^ws_close_(4001|4003|4004|4503)$/.test(reason)) return 0;
  if (["ice_failed", "not_connected", "ice_unrecovered", "ws_close_4010"].includes(reason)) return 10 * 60_000;
  return 45_000;
}

/**
 * How long a computer whose screen Orgo's WebRTC shrank streams over VNC (ms): a day. A gateway that
 * caps screens below the computer's (ORGO_RTC_WIDTH/HEIGHT on the host, 1280x720 unless set) shrinks
 * it again on every try, so it isn't tried again soon.
 */
export const RTC_SHRUNK_MS = 24 * 60 * 60_000;

/**
 * Whether WebRTC would stream the screen smaller than it is (`video`, the size Orgo's "ready" says,
 * against the screen's real `size`). Orgo's gateway fits a screen inside its limit by resizing the
 * screen itself before it says how big the stream is, and never sizes it back: a 1280x960 screen under
 * the default 1280x720 limit comes out 960x720. Then the app stops, streams over VNC, and Bops puts
 * the screen back (POST /api/vnc).
 */
export function rtcShrank(video: { w: number; h: number } | undefined, size: { w: number; h: number } | undefined) {
  return !!video && !!size && (video.w < size.w || video.h < size.h);
}

/** The waits before a stream is tried again (ms), longer each time (LiveDesktop). */
export const STREAM_RETRY_MS = [2000, 5000, 10_000, 30_000];

/**
 * What LiveDesktop does when a VNC stream ends, by its close code: "fail" (the caller shows the screen
 * another way), "no_stream" (the same, and no view of the screen tries it again), "retry" (a fresh
 * plan after the next wait), or "reauth" (the same, once, after the password was turned away).
 *
 * Any stream comes back by itself if it had been live, else fails. A screen Orgo streams by ?screen=
 * (`screen`, StreamPlan.screen) also goes by Orgo's code: a screen Orgo can't stream (4012) shows as
 * screenshots from then on, live before or not; one Orgo couldn't reach or look up just then (4502,
 * 4503) is tried again, as many times as there are waits even if it never connected; a token turned
 * away (4001) gets one more try with a fresh plan, since the VNC password changes when the computer
 * restarts, then screenshots, which need no password. `tries`: tries since it was last live;
 * `refused`: Orgo already turned its password away since then.
 */
export function afterVncClose(code: number | undefined, at: { screen: boolean; ever: boolean; tries: number; refused: boolean }): "fail" | "no_stream" | "retry" | "reauth" {
  if (at.screen && code === RTC_CLOSE.NO_SUCH_SCREEN) return "no_stream";
  if (at.screen && code === RTC_CLOSE.AUTH) return at.refused ? "fail" : "reauth";
  if (at.screen && (code === RTC_CLOSE.NO_BACKEND || code === RTC_CLOSE.LOOKUP_FAILED) && at.tries < STREAM_RETRY_MS.length) return "retry";
  return at.ever ? "retry" : "fail";
}

/* ---------------- Signaling (text frames) ---------------- */

export type RtcReady = {
  type: "ready";
  sessionId: string;
  /** Always empty: no STUN, no TURN. */
  iceServers: RTCIceServer[];
  /** The remote screen's size the stream starts at. */
  video?: { w: number; h: number; fps: number };
  encoder?: string;
  inputChannel?: { label: string; id: number };
  /** Present when the gateway has the second, lossy channel for pointer moves. */
  lossyInputChannel?: { label: string; id: number };
  cursor?: "server" | "client";
};
export type RtcServerMsg =
  | RtcReady
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: RTCIceCandidateInit | null }
  | { type: "stats"; rttMs: number; lossPct: number; kbps: number; fps: number }
  | { type: "error"; code: string; message?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** One frame from Orgo, or null when it isn't one the app knows. */
export function parseServerMsg(raw: string): RtcServerMsg | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  if (v.type === "ready" && typeof v.sessionId === "string") return v as RtcReady;
  if (v.type === "answer" && typeof v.sdp === "string") return v as RtcServerMsg;
  if (v.type === "candidate" && "candidate" in v) return v as RtcServerMsg;
  if (v.type === "stats") return v as RtcServerMsg;
  if (v.type === "error" && typeof v.code === "string") return v as RtcServerMsg;
  return null;
}

/* ---------------- Input (the DataChannel) ---------------- */

/** The input channel: negotiated on both sides, so there's no renegotiation. */
export const RTC_INPUT_CHANNEL = { label: "input", id: 0 };
/** The optional lossy one, for pointer moves only (the next move makes up for a lost one). */
export const RTC_LOSSY_CHANNEL = { label: "input-unreliable", id: 1 };

/** RFB's button bits. The app always sends the whole mask, never a change. */
export const RFB_BUTTON = { LEFT: 1, MIDDLE: 2, RIGHT: 4, WHEEL_UP: 8, WHEEL_DOWN: 16, WHEEL_LEFT: 32, WHEEL_RIGHT: 64 } as const;

/** What the app sends: a pointer (remote pixels, full button mask), a key (X11 keysym), a ping. */
export type RtcInput = { t: "p"; x: number; y: number; b: number } | { t: "k"; sym: number; code: string; d: boolean } | { t: "pi"; ts: number };

/** What comes back: the screen's new size, a pong, the computer's clipboard, or an error. */
export type RtcChannelMsg = { t: "sz"; w: number; h: number } | { t: "po"; ts: number } | { t: "cb"; text: string } | { t: "err"; code: string; message?: string } | { t: "caps" };

export function parseChannelMsg(raw: string): RtcChannelMsg | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  if (v.t === "sz" && typeof v.w === "number" && typeof v.h === "number") return v as RtcChannelMsg;
  if (v.t === "po" && typeof v.ts === "number") return v as RtcChannelMsg;
  if (v.t === "cb" && typeof v.text === "string") return v as RtcChannelMsg;
  if (v.t === "err" && typeof v.code === "string") return v as RtcChannelMsg;
  if (v.t === "caps") return v as RtcChannelMsg;
  return null;
}

type Box = { left: number; top: number; width: number; height: number };

/**
 * Where an object-fit: contain picture is drawn inside its element: the largest box of the content's
 * shape that fits, centered. The element's own box is wider or taller than the picture whenever
 * their shapes differ, and mapping clicks onto it would put them off by the bars.
 */
export function containedRect(box: Box, content: { w: number; h: number }): Box {
  if (box.width <= 0 || box.height <= 0 || content.w <= 0 || content.h <= 0) return box;
  const scale = Math.min(box.width / content.w, box.height / content.h);
  const width = content.w * scale;
  const height = content.h * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** A point on the page to a pixel on the remote screen, kept on the screen (a press in a bar lands on its edge). */
export function toScreenPoint(clientX: number, clientY: number, rect: Box, screen: { w: number; h: number }) {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  const x = Math.round(((clientX - rect.left) / rect.width) * screen.w);
  const y = Math.round(((clientY - rect.top) / rect.height) * screen.h);
  return { x: Math.max(0, Math.min(screen.w - 1, x)), y: Math.max(0, Math.min(screen.h - 1, y)) };
}

/** The DOM's MouseEvent.buttons as RFB's mask: the DOM has right as 2 and middle as 4, RFB the other way round. */
export function rfbButtons(buttons: number): number {
  return (buttons & 1 ? RFB_BUTTON.LEFT : 0) | (buttons & 4 ? RFB_BUTTON.MIDDLE : 0) | (buttons & 2 ? RFB_BUTTON.RIGHT : 0);
}

/** One wheel click per this many pixels of scrolling, and at most this many clicks per event. */
const WHEEL_PX = 100;
const WHEEL_MAX = 10;

/**
 * A wheel event's scrolling as whole wheel clicks, with what's left over carried to the next event,
 * so slow trackpad scrolling still adds up to a click instead of rounding to nothing each time.
 * Line and page scrolling (deltaMode 1, 2) are a click per unit.
 */
export function wheelClicks(carried: number, delta: number, deltaMode: number) {
  if (deltaMode !== 0) return { clicks: Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, Math.trunc(delta))), rest: 0 };
  const total = carried + delta;
  const whole = Math.trunc(total / WHEEL_PX);
  return { clicks: Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, whole)), rest: total - whole * WHEEL_PX };
}
