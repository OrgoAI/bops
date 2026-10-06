"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Seeing your Mac, live: the Bops Mac app (desktop/main.cjs) lists the displays and windows it can
 * show; the page streams one with getUserMedia. The Your Mac tab (mac-computer.tsx) is built on these.
 */

type Display = { id: string; label: string; width: number; height: number; primary: boolean };
type Source = { id: string; name: string; displayId?: string };
type Screens = { access: string; displays: Display[]; sources: Source[]; bopsOn?: string };

declare global {
  interface Window {
    bopsMac?: { screens: () => Promise<Screens>; openScreenSettings: () => Promise<void> };
  }
}

const noop = () => () => {};
/** True inside the Bops Mac app (false while rendering on the server, so the page hydrates cleanly). */
export const useMacApp = () => useSyncExternalStore(noop, () => !!window.bopsMac, () => false);

/** The displays and windows the Mac app can show, checked every few seconds (displays come and go). */
export function useMacScreens(every = 3000) {
  const [screens, setScreens] = useState<Screens | null>(null);
  const inApp = useMacApp();
  useEffect(() => {
    if (!inApp) return;
    let gone = false;
    const look = () =>
      void window.bopsMac!.screens()
        .then((s) => !gone && setScreens(s))
        .catch(() => {});
    look();
    const t = setInterval(look, every);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [inApp, every]);
  return screens;
}

/** The window each app has on the Mac (from the server, which asks Cua Driver), checked every few seconds. */
export type MacWin = { windowId: number; title: string; size?: { w: number; h: number }; marker?: { x: number; y: number; w: number; h: number } | null };
export function useAppWindows(apps: string[]) {
  const [found, setFound] = useState<Record<string, { windowId?: number; title?: string; windows?: MacWin[] }>>({});
  const key = apps.join(",");
  useEffect(() => {
    if (!key) return;
    let gone = false;
    const look = () =>
      void fetch(`/api/mac/windows?apps=${encodeURIComponent(key)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j: { windows: { app: string; windowId?: number; title?: string; windows?: MacWin[] }[] }) => !gone && setFound(Object.fromEntries(j.windows.map((w) => [w.app, w]))))
        .catch(() => {});
    look();
    const t = setInterval(look, 3000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [key]);
  return found;
}

/** One display or window, as live video. `fps` and `maxWidth` keep small tiles cheap. */
export function MacStream({
  sourceId,
  fps = 30,
  maxWidth = 4096,
  className = "",
  fit = "contain",
  onSize,
}: {
  sourceId: string;
  fps?: number;
  maxWidth?: number;
  className?: string;
  fit?: "contain" | "cover";
  /** The picture's real shape, once the first frame arrives (and when a window is resized). */
  onSize?: (w: number, h: number) => void;
}) {
  const sized = useRef(onSize);
  useEffect(() => {
    sized.current = onSize;
  });
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  // Captured at the size it's shown (in device pixels, in steps so small resizes don't restart it):
  // macOS scales a window down cleanly, while shrinking a full-size stream in the page blurs small text.
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!video) return;
    const measure = () => {
      if (!video.clientWidth) return;
      const dpr = window.devicePixelRatio || 1;
      const step = (n: number) => Math.min(maxWidth, Math.max(256, Math.ceil((n * dpr) / 256) * 256));
      let w = step(video.clientWidth);
      let h = step(video.clientHeight);
      // "cover" crops, so the picture has to be at least as big as the box both ways.
      if (fit === "cover") w = h = Math.max(w, h);
      setBox((x) => (x && x.w === w && x.h === h ? x : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(video);
    return () => ro.disconnect();
  }, [video, fit, maxWidth]);
  useEffect(() => {
    if (!video || !box) return;
    let gone = false;
    let stream: MediaStream | undefined;
    const constraints = { audio: false, video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId, maxWidth: box.w, maxHeight: box.h, maxFrameRate: fps } } };
    navigator.mediaDevices
      .getUserMedia(constraints as unknown as MediaStreamConstraints)
      .then((s) => {
        if (gone) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        video.srcObject = s;
        void video.play().catch(() => {});
        // A window that closes ends its stream.
        s.getVideoTracks()[0]?.addEventListener("ended", () => setFailed(true));
      })
      .catch(() => !gone && setFailed(true));
    return () => {
      gone = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [video, box, sourceId, fps]);
  return (
    <div className={`relative bg-[#111111] ${className}`}>
      <video ref={setVideo} muted playsInline onResize={(e) => e.currentTarget.videoWidth && sized.current?.(e.currentTarget.videoWidth, e.currentTarget.videoHeight)} className={`h-full w-full ${fit === "cover" ? "object-cover object-top" : "object-contain"} ${failed ? "invisible" : ""}`} />
      {failed && <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-[11.5px] text-[#9A9A98]">Can&rsquo;t see this right now</div>}
    </div>
  );
}

/** A window an app has on the Mac, live when the Mac app can stream it (else null, and the caller falls back). */
export function useAppWindowSource(app: string) {
  const screens = useMacScreens(4000);
  const found = useAppWindows(screens?.access === "granted" ? [app] : []);
  const id = found[app]?.windowId;
  const sourceId = id !== undefined ? `window:${id}:0` : undefined;
  return sourceId && screens?.sources.some((s) => s.id === sourceId) ? sourceId : null;
}
