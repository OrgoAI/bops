"use client";

import type { ComponentProps, CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { usePlatform, type Platform } from "@/components/message-ui/platform";
import { bodyClipPath, tailBox, tailPath, tailSeamOverlap } from "@/components/message-ui/bubble-shape";
import { bubbleMetrics, palettes } from "@/components/message-ui/tokens";

/**
 * The "someone is typing" balloon.
 *
 * No capture in `references/` shows a typing indicator - every iOS and macOS still, both 60 fps
 * recordings and every motion contact sheet were checked on 2026-09-08 and none contains one - but
 * ChatKit describes the whole balloon, and the dots that used to be invented here now come from it:
 *
 * | value | ChatKit | what was here |
 * |---|---|---|
 * | dot diameter | `transcriptTypingIndicatorThinkingDotDiameter` **8.5** | 10 |
 * | dot pitch | `transcriptTypingIndicatorThinkingDotSpace` **12.5** centre to centre | 15 (10 + 5) |
 * | balloon | `transcriptTypingIndicatorLargeBubbleSize` **{57.5, 35}** | 3 dots plus the bubble's padding |
 *
 * Read at both idioms: the Mac keeps the same 8.5 dots at the same 12.5 pitch and shrinks only the
 * balloon, to **{44, 27}**.
 * | whole indicator | `transcriptTypingIndicatorDefaultSize` **{78.5, 35}** | - |
 *
 * 12.5 is the pitch and not the gap: three 8.5 dots at that pitch span 33.5, which leaves 12 of
 * padding on each side of the 57.5 balloon. Read as a gap they would span 50.5 and leave 3.5, which
 * no balloon looks like. The balloon's own 35 height replaces the one-line bubble height this used to
 * borrow, and it is 3 pt shorter than the 38 that measured 2 x 10 + 20 gives.
 *
 * ChatKit also has the two smaller bubbles that trail it - `…MediumBubbleSize` {11.5, 11.5} at
 * `…MediumBubbleOffset` (7, -7.5), and the large one at `…LargeBubbleOffset` (14, -28.5) - which is
 * how the 78.5 x 35 whole is bigger than the 57.5 balloon. Those are not drawn here yet.
 *
 * What is still anchored to a capture: the balloon is an incoming bubble, so its corner radius, its
 * traced bottom-left tail and its incoming screen-space fill are read from `bubbleMetrics` and
 * `bubble-shape` and can never drift from a real bubble.
 *
 * Still invented: the 1.2 s pulse and its stagger, and the dot colour, which reuses the platform's
 * measured secondary-label gray because nothing shows the real one.
 * The pulse is a CSS animation with negative delays, so every dot is inside its active phase at every
 * time: pausing `document.getAnimations()` and setting `currentTime` pins the balloon to a frame, and
 * that frozen frame is the one the animation shows while running.
 */
export type TypingIndicatorMetrics = {
  /** Body box, both derived from the measured one-line incoming bubble. */
  width: number;
  height: number;
  /** `transcriptTypingIndicatorThinkingDotDiameter`, and the gap that its 12.5 pitch implies. */
  dot: number;
  dotGap: number;
  /** Measured bubble radius and tail scale, carried through so the balloon matches a bubble exactly. */
  radius: number;
  tailScale: number;
};

/**
 * `transcriptTypingIndicatorThinkingDotDiameter` and `…ThinkingDotSpace`, with the balloon box from
 * `transcriptTypingIndicatorLargeBubbleSize`. macOS scales them by the ratio its bubble already
 * carries, because `CKUIBehaviorMac` does not override any of the three and its balloon is smaller.
 */
const chatKitDots: Record<Platform, { dot: number; pitch: number; balloon: { width: number; height: number } }> = {
  ios: { dot: 8.5, pitch: 12.5, balloon: { width: 57.5, height: 35 } },
  // The Mac class keeps the dots and shrinks the balloon: `transcriptTypingIndicatorLargeBubbleSize`
  // is {44, 27} at idiom 5, read rather than scaled from the phone's.
  macos: { dot: 8.5, pitch: 12.5, balloon: { width: 44, height: 27 } },
};

function metricsFor(platform: Platform): TypingIndicatorMetrics {
  const b = bubbleMetrics[platform];
  const ck = chatKitDots[platform];
  const dot = ck.dot;
  const dotGap = ck.pitch - ck.dot;
  return {
    width: ck.balloon.width,
    height: ck.balloon.height,
    dot,
    dotGap,
    radius: b.radius,
    tailScale: b.tailScale,
  };
}

export const typingIndicatorMetrics: Record<Platform, TypingIndicatorMetrics> = {
  ios: metricsFor("ios"),
  macos: metricsFor("macos"),
};

/** Dot loop and the stagger between two dots. Provisional; no capture times the pulse. */
export const typingLoopMs = 1200;
export const typingStaggerMs = 200;

/**
 * The delays are negative so a dot is never in its "before" phase: at time 0 dot 1 is already
 * `typingStaggerMs` into the loop instead of sitting on its unanimated base style, which is what made
 * a frozen frame at t = 0 disagree with the running animation.
 */
const dotDelayMs = (index: number) => index * typingStaggerMs - typingLoopMs;

const keyframes = `
@keyframes im-typing-dot { 0%, 60%, 100% { opacity: .35; transform: translateY(0) scale(1); } 30% { opacity: 1; transform: translateY(-1px) scale(1.06); } }
[data-slot="typing-indicator"] > span[data-dot] { animation: im-typing-dot ${typingLoopMs}ms ease-in-out infinite both; }
@media (prefers-reduced-motion: reduce) { [data-slot="typing-indicator"] > span[data-dot] { animation: none; opacity: .7; } }
`;

export type TypingIndicatorProps = ComponentProps<"div"> & {
  label?: string;
  /** The balloon is always the last thing in the transcript, so it carries a tail like any last bubble. */
  tail?: boolean;
  /**
   * Screen-space y of the body's bottom edge, in px, for the position-dependent incoming fill. The
   * message list tracks this element too, so it is only needed outside a list: pass it to keep a macOS
   * dark balloon exactly on the incoming ramp; the iOS grays are flat and never need it.
   */
  screenBottom?: number;
  platform?: Platform;
};

export function TypingIndicator({
  label = "Someone is typing", tail = true, screenBottom, platform: platformProp, className, style, ...props
}: TypingIndicatorProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const t = typingIndicatorMetrics[platform];
  const tailW = tailBox.width * t.tailScale;
  const tailH = tailBox.height * t.tailScale;
  const hang = tailBox.hang * t.tailScale;

  // Same screen-space fill an incoming bubble paints: one gradient in screen coordinates, anchored to
  // the body's bottom so the body and the tail (which hangs `hang` lower) share the same image. The
  // fallbacks only matter when the balloon is used outside a palette; inside one they never apply.
  const screen = `var(--im-screen-h, ${palettes[platform].light.incoming.screenHeight}px)`;
  const bottomVar = screenBottom === undefined ? `var(--bubble-bottom, calc(${screen} * 0.55))` : `${screenBottom}px`;
  const fill: CSSProperties = {
    backgroundImage: "linear-gradient(var(--im-fill-top), var(--im-fill-bottom))",
    backgroundSize: `100% ${screen}`,
    backgroundRepeat: "no-repeat",
    backgroundColor: "var(--im-fill-bottom)",
  };
  const bodyFill: CSSProperties = { ...fill, backgroundPosition: `0 calc(100% + (${screen} - ${bottomVar}))` };
  const tailFill: CSSProperties = { ...fill, backgroundPosition: `0 calc(100% + (${screen} - ${bottomVar} - ${hang}px))` };
  const vars = {
    "--im-fill-top": "var(--im-gray-top, #e9e9eb)",
    "--im-fill-bottom": "var(--im-gray-bottom, #e9e9eb)",
    ...(screenBottom === undefined ? {} : { "--bubble-bottom": `${screenBottom}px` }),
  } as CSSProperties;

  return (
    <div role="status" aria-label={label} data-slot="typing-indicator" data-platform={platform}
      className={cn("relative flex shrink-0 items-center justify-center", className)}
      style={{ width: t.width, height: t.height, gap: t.dotGap, ...vars, ...style }} {...props}>
      <style>{keyframes}</style>
      {/* The fill sits behind the dots so clipping the tail corner never clips a dot. */}
      <div aria-hidden="true" data-slot="fill" className="pointer-events-none absolute inset-0"
        style={{ borderRadius: t.radius, clipPath: tail ? bodyClipPath("left", t.tailScale, tailSeamOverlap[platform]) : undefined, ...bodyFill }} />
      {tail && <div aria-hidden="true" data-slot="tail" className="pointer-events-none absolute" style={{
        left: 0, bottom: -hang, width: tailW, height: tailH + hang, clipPath: `path("${tailPath("left", t.tailScale)}")`, ...tailFill,
      }} />}
      {[0, 1, 2].map(index => (
        <span key={index} aria-hidden="true" data-dot={index} className="relative block rounded-full"
          style={{ width: t.dot, height: t.dot, background: "var(--im-secondary, #8a8a8e)", animationDelay: `${dotDelayMs(index)}ms` }} />
      ))}
    </div>
  );
}
