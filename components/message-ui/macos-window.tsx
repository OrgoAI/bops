"use client";

import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * macOS 26 Messages window frame. The pane captures are crops of window x 330–960, so they carry the
 * window's top, right and bottom edges but never its left column. Measured at 2x:
 * - corners: continuous. `conversation-pane-light.png` and `conversation-pane-dark-2.png` are both
 *   shadow-free captures, so their alpha edge is the window's own outline: fitting it with the
 *   exponent Chrome's `superellipse(1.4)` draws (2.639) gives radius 31.67 and 31.81 pt at 0.23 px
 *   rms, and the best plain circle is 25.5 pt at 0.38 px rms (0.9 px worst point). Tracing a Chrome
 *   render of those two values back returns them to 0.06 pt, so the fit reads a radius honestly.
 *   The rim ridge of `conversation-pane-dark.png` reads 0.8 pt larger; that capture sits on the
 *   desktop and its rim is a lit band, so the two alpha outlines are the better evidence.
 * - dark frame: 1 pt #4b4b4b down the sides and along the bottom (two device columns at window
 *   x 959–960 of `conversation-pane-dark.png`). The top edge is brighter and is not painted gray: it
 *   reads #6f6f6f then #5d5d5d over the #1e1e1e pane, and #74787f then #63696f where a blue bubble
 *   sits under the header, which is white at 0.36 and 0.28 over both.
 * - light frame: no side or bottom rim, the pane runs to the edge. The same top highlight is there,
 *   white at 0.70 then 0.40: #fefefe then #fdfdfd over the #fcfcfc header glass, and white over the
 *   plain pane of `conversation-pane-light-partial.png`.
 * - traffic lights: Ø14 centred (25.75, 25.75), (48.75, 25.75), (71.75, 25.75), from SPEC "macOS
 *   Chrome". No committed capture contains them: every pane crop starts at window x 330, so these
 *   come from the full-window frames held outside the repo and cannot be re-measured here. Their
 *   inactive fills are not measured at all, since no capture shows a window that is not key.
 */
export const macWindowMetrics = {
  width: 960,
  height: 640,
  sidebarWidth: 330,
  /** Best circular fit to the window outline. Browsers with `corner-shape` get `continuousRadius`. */
  cornerRadius: 25.5,
  continuousRadius: 31.75,
  trafficLight: { diameter: 14, centers: [25.75, 48.75, 71.75] as const, y: 25.75 },
};

export type MacWindowProps = Omit<ComponentProps<"div">, "children" | "content"> & {
  width?: number;
  height?: number;
  /** Key window: colored traffic lights and the blue sidebar selection. */
  active?: boolean;
  /** The conversation list. Rendered in the left `sidebarWidth` (330 pt) column. */
  sidebar?: ReactNode;
  sidebarWidth?: number;
  /** The conversation pane. */
  content?: ReactNode;
  children?: ReactNode;
};

const lights = [
  { name: "Close", fill: "#ff5f57", rim: "#e0443e" },
  { name: "Minimize", fill: "#febc2e", rim: "#dea123" },
  { name: "Zoom", fill: "#28c840", rim: "#1aab29" },
];

export function MacWindow({ width = macWindowMetrics.width, height = macWindowMetrics.height, active = true, sidebar, sidebarWidth = macWindowMetrics.sidebarWidth, content, children, className, style, ...props }: MacWindowProps) {
  const { diameter, centers, y } = macWindowMetrics.trafficLight;
  return (
    <div
      data-slot="mac-window"
      data-active={active ? "true" : "false"}
      className={cn("mac-window relative isolate overflow-hidden bg-white text-black [--mac-light-inactive-rim:rgba(0,0,0,0.12)] [--mac-light-inactive:#dcdcdc] [--mac-rim-top-1:rgba(255,255,255,0.50)] [--mac-rim-top-2:rgba(255,255,255,0.40)] dark:bg-[#1e1e1e] dark:text-white dark:[--mac-light-inactive-rim:rgba(255,255,255,0.08)] dark:[--mac-light-inactive:#4f4f4f] dark:[--mac-rim-top-1:rgba(255,255,255,0.111)] dark:[--mac-rim-top-2:rgba(255,255,255,0.28)]", className)}
      style={{ width, height, fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif", WebkitFontSmoothing: "antialiased", ...style }}
      {...props}
    >
      <style>{`
        .mac-window { border-radius: ${macWindowMetrics.cornerRadius}px; }
        @supports (corner-shape: superellipse(1.4)) { .mac-window { border-radius: ${macWindowMetrics.continuousRadius}px; corner-shape: superellipse(1.4); } }
      `}</style>
      <div data-slot="mac-window-sidebar" className="absolute inset-y-0 left-0" style={{ width: sidebarWidth }}>{sidebar}</div>
      <div data-slot="mac-window-content" className="absolute inset-y-0 right-0" style={{ left: sidebarWidth }}>{content ?? children}</div>
      <div data-slot="traffic-lights" role="group" aria-label="Window controls" className="absolute left-0 top-0 z-20" style={{ height: y * 2, width: centers[2] + diameter }}>
        {lights.map((light, index) => (
          <span
            key={light.name}
            data-slot="traffic-light"
            role="img"
            aria-label={light.name}
            className="absolute rounded-full"
            style={{
              width: diameter, height: diameter, left: Math.floor(centers[index] - diameter / 2), top: Math.floor(y - diameter / 2),
              // The measured box starts on a quarter point (18.75). A positioned box is snapped to whole
              // device pixels, which would round that away; a fractional transform is not, so it carries
              // the remainder and the light lands where the capture puts it.
              transform: `translate(${((centers[index] - diameter / 2) % 1).toFixed(3)}px, ${((y - diameter / 2) % 1).toFixed(3)}px)`,
              background: active ? light.fill : "var(--mac-light-inactive)",
              boxShadow: `inset 0 0 0 0.5px ${active ? light.rim : "var(--mac-light-inactive-rim)"}`,
            } as CSSProperties}
          />
        ))}
      </div>
      {/* Frame rim, in two parts because native's top edge replaces the side rim rather than sitting on
          top of it: dark draws #4b4b4b down the sides and along the bottom, and both themes draw the
          top edge as white glass, so whatever scrolls under the header shows through it. */}
      <div aria-hidden="true" data-slot="mac-window-rim" className="mac-window pointer-events-none absolute inset-0 z-30 hidden dark:block" style={{ boxShadow: "inset 1px 0 0 #4b4b4b, inset -1px 0 0 #4b4b4b, inset 0 -1px 0 #4b4b4b" }} />
      {/* The top edge is two device rows at 2x: white 0.36 then 0.28 in dark, 0.70 then 0.40 in light.
          The first shadow paints over the second, so `--mac-rim-top-1` carries only the difference. */}
      <div aria-hidden="true" data-slot="mac-window-top-edge" className="mac-window pointer-events-none absolute inset-0 z-30" style={{ boxShadow: "inset 0 0.5px 0 var(--mac-rim-top-1), inset 0 1px 0 var(--mac-rim-top-2)" }} />
    </div>
  );
}
