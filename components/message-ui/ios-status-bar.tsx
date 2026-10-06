"use client";

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * iOS 26 status bar for a 402pt-wide screen, measured from the iPhone 17 Pro simulator captures in
 * `references/ios/captures/` (conv3-light, conv2-dark, list-*, newmsg-light). All sizes are points
 * (= CSS px): 54 tall; time 17pt semibold with its cap height centered on y 32.67 and ink starting
 * at x 57.33; Dynamic Island x 138.33–263.67, y 14–50.67; four cellular dots (3.33 rounded squares, pitch 5.33)
 * from x 288.33 on y 35.33–38.67; wifi ink 17×12.33 at (315, 26.33), three annular sectors about
 * (8.5, 13) with a 40.8° half-angle, the innermost one tipped so the glyph ends at y 38.67 and not a
 * pixel lower; battery outline 25×13 at (339.33, 26) with a 21×9 fill and a 1.33×3.67 nub. Theme follows a `.dark` ancestor. A dimming overlay above the screen (see the
 * New Message sheet) darkens it the way iOS does, so it needs no dimmed variant of its own.
 * Other viewport widths retain these insets and center the island; that adaptation is UNVERIFIED.
 */
export type IosStatusBarProps = ComponentProps<"div"> & {
  /** Clock text. Captures show the real time; "9:41" is Apple's marketing default. */
  time?: string;
};

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

const vars =
  "[--ios-sb-label:#000000] [--ios-sb-dot:#cccccc] [--ios-sb-battery:#999999] [--ios-sb-nub:#808080] " +
  "dark:[--ios-sb-label:#ffffff] dark:[--ios-sb-dot:#333333] dark:[--ios-sb-battery:#666666] dark:[--ios-sb-nub:#808080]";

/** Chrome snaps box edges to whole CSS px, so third-point offsets are applied as transforms. */
const third = (x: number, y: number) => ({ transform: `translate(${x}px, ${y}px)` });

export function IosStatusBar({ time = "9:41", className, style, ...props }: IosStatusBarProps) {
  return (
    <div data-slot="ios-status-bar" className={cn("relative h-[54px] w-full select-none", vars, className)}
      style={{ fontFamily: font, ...style }} {...props}>
      <span data-slot="time" className="absolute whitespace-nowrap" style={{ left: 56, top: 24, ...third(1 / 3, 2 / 3), fontSize: 17, lineHeight: 1, fontWeight: 600, letterSpacing: 0, color: "var(--ios-sb-label)" }}>
        {time}
      </span>
      <span aria-hidden="true" data-slot="dynamic-island" className="absolute rounded-full bg-black" style={{ left: "calc(50% - 63px)", top: 14, width: 125.3333, height: 36.6667, ...third(1 / 3, 0) }} />
      <span aria-hidden="true" data-slot="cellular" className="absolute flex" style={{ left: "calc(100% - 114px)", top: 35, gap: 2, ...third(1 / 3, 1 / 3) }}>
        {[0, 1, 2, 3].map(i => <span key={i} style={{ width: 3.3333, height: 3.3333, borderRadius: 1, background: "var(--ios-sb-dot)" }} />)}
      </span>
      <svg aria-hidden="true" data-slot="wifi" className="absolute" style={{ left: "calc(100% - 88px)", top: 25 }} width="19" height="14.6667" viewBox="-1 -1.3333 19 14.6667" fill="var(--ios-sb-label)">
        <path d="M0.01 3.16A13 13 0 0 1 16.99 3.16L15.25 5.18A10.33 10.33 0 0 0 1.75 5.18Z" />
        <path d="M2.84 6.44A8.67 8.67 0 0 1 14.16 6.44L12.42 8.46A6 6 0 0 0 4.58 8.46Z" />
        <path d="M5.45 9.47A4.67 4.67 0 0 1 11.55 9.47L8.94 12.16A0.67 0.67 0 0 0 8.06 12.16Z" />
      </svg>
      <span aria-hidden="true" data-slot="battery" className="absolute" style={{ left: "calc(100% - 63px)", top: 26, width: 25, height: 13, borderRadius: 4.3333, boxShadow: "inset 0 0 0 1px var(--ios-sb-battery)", ...third(1 / 3, 0) }}>
        <span className="absolute" style={{ left: 2, top: 2, width: 21, height: 9, borderRadius: 2.75, background: "var(--ios-sb-label)" }} />
        <span className="absolute" style={{ left: 26, top: 4.6667, width: 1.3333, height: 3.6667, borderRadius: "0 1.3333px 1.3333px 0", background: "var(--ios-sb-nub)" }} />
      </span>
    </div>
  );
}
