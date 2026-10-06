"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { usePlatform, type Platform } from "@/components/message-ui/platform";

/**
 * In-conversation notices.
 *
 * **Unknown sender** — measured from `references/ios/captures/incoming-light.png` / `-dark.png`
 * (402×874 @3x): centred secondary text whose ink runs 721.33–731.67 on line 1 and 734.67–745 on
 * line 2 (ascender 8.33, x-height 6.0 → 11pt, 13.33 pitch), colour #8a8a8e / #8d8d93. Line 1's ink
 * spans x 22.67–379 and line 2 ("be spam.") x 177–224, so the paragraph is centred on x 201 and
 * wraps inside the 370pt content width. The last bubble body ends at 702.67, 16 above the text box.
 * The "Report Spam" pill is 91 × 22.33 centred on (200.83, 766.83) — a capsule filled with the
 * incoming gray (#e9e9eb / #262629) carrying a 69pt-wide #0088ff / #0091ff label.
 *
 * **Not delivered** — measured from `references/macos/captures/attachment-not-delivered-dark-2x.png`
 * (960×640 @2x): a Ø17 red ring badge (#eb534e) centred 9.5 past the bubble's trailing edge, on the
 * body's vertical centre, plus "Not Delivered" in the same 10pt semibold slot "Delivered" uses,
 * right-aligned 16.5 inside the badge's trailing edge. iOS scales that to the 11pt status world.
 */

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

const noticeVars =
  "[--ios-nt-secondary:#8a8a8e] [--ios-nt-pill:#e9e9eb] [--ios-nt-link:#0088ff] " +
  "dark:[--ios-nt-secondary:#8d8d93] dark:[--ios-nt-pill:#262629] dark:[--ios-nt-link:#0091ff]";

/** Measured notice geometry, in points. */
export const unknownSenderMetrics = {
  fontSize: 11, lineHeight: 13.3333, contentWidth: 370, topGap: 16,
  pillWidth: 91, pillHeight: 22.3333, pillGap: 10.3333, pillFontSize: 11, letterSpacing: 0.1,
  /**
   * Centring a 91 wide pill in the 370 wide content column puts its left edge on 155.5, half a
   * point off the device grid at 3x. Native rounds that painted edge down to the pixel below and
   * fills x 466–738 of the capture (155.33–246.33); Blink rounds the whole background box up to
   * 156 instead. Snapping happens before the transform, so two thirds of a point here lands the
   * composited capsule back on the capture's edges. It is a rasterising correction for the
   * measured 370 column, not a layout offset.
   */
  pillNudgeX: -0.6667,
} as const;

export type UnknownSenderNoticeProps = Omit<ComponentProps<"div">, "children" | "title"> & {
  /** The grey paragraph. Defaults to the exact string iOS shows. */
  message?: ReactNode;
  /** Omit to hide the button. */
  action?: string;
  onAction?: () => void;
  /** Space above the paragraph, from the previous bubble's body bottom. */
  topGap?: number;
};

export function UnknownSenderNotice({
  message = "If you did not expect this message from an unknown sender, it may be spam.",
  action = "Report Spam", onAction, topGap = unknownSenderMetrics.topGap, className, style, ...props
}: UnknownSenderNoticeProps) {
  const m = unknownSenderMetrics;
  return (
    <div data-slot="unknown-sender-notice" role="note"
      className={cn("flex w-full select-none flex-col items-center", noticeVars, className)}
      style={{ fontFamily: font, paddingTop: topGap, ...style }} {...props}>
      <p data-slot="notice-text" className="m-0 text-center"
        style={{ maxWidth: m.contentWidth, fontSize: m.fontSize, lineHeight: `${m.lineHeight}px`, letterSpacing: m.letterSpacing, color: "var(--ios-nt-secondary)" }}>
        {message}
      </p>
      {action && (
        <button type="button" data-slot="notice-action" onClick={onAction}
          className="relative flex items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]"
          style={{
            marginTop: m.pillGap, width: m.pillWidth, height: m.pillHeight, borderRadius: m.pillHeight / 2,
            color: "var(--ios-nt-link)",
            fontSize: m.pillFontSize, lineHeight: `${m.pillHeight}px`, fontWeight: 600, letterSpacing: 0,
          }}>
          {/* The fill carries `pillNudgeX`; the label must not, since its own ink already lands on the capture. */}
          <span aria-hidden="true" data-slot="notice-action-fill" className="absolute inset-0"
            style={{ borderRadius: m.pillHeight / 2, background: "var(--ios-nt-pill)", transform: `translateX(${m.pillNudgeX}px)` }} />
          {/* Chrome's baseline sits two thirds of a point below native's in this line box. */}
          <span className="relative" style={{ transform: "translateY(-0.6667px)" }}>{action}</span>
        </button>
      )}
    </div>
  );
}

/** Status typography per platform, matching `bubbleMetrics` so the label lands where "Delivered" would. */
const statusStyle: Record<Platform, { fontSize: number; lineHeight: number; letterSpacing: number; gap: number; inset: number; badge: number; badgeGap: number }> = {
  ios: { fontSize: 11, lineHeight: 13, letterSpacing: -0.25, gap: 4.65, inset: 19.3, badge: 18, badgeGap: 8 },
  macos: { fontSize: 10, lineHeight: 12, letterSpacing: -0.45, gap: 4, inset: 16.5, badge: 17, badgeGap: 9.5 },
};

export type FailedSendBadgeProps = Omit<ComponentProps<"button">, "children"> & {
  size?: number;
  platform?: Platform;
  label?: string;
};

/** The red (!) ring that sits beside a message that failed to send. */
export function FailedSendBadge({ size, platform: platformProp, label = "Message not delivered. Try again.", className, style, ...props }: FailedSendBadgeProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const d = size ?? statusStyle[platform].badge;
  return (
    <button type="button" data-slot="failed-send-badge" aria-label={label} title={label}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full align-middle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#eb534e]", className)}
      style={{ width: d, height: d, ...style }} {...props}>
      <svg aria-hidden="true" width={d} height={d} viewBox="0 0 17 17" fill="none" stroke="#eb534e" strokeWidth="1.15" strokeLinecap="round">
        <circle cx="8.5" cy="8.5" r="7.9" />
        <path d="M8.5 4.3v5.1" />
        <path d="M8.5 12.35v0.05" strokeWidth="1.5" />
      </svg>
    </button>
  );
}

/**
 * ChatKit's own names for the effects, used as the Replay control's accessible name:
 * `EFFECT_CONTROL_BUTTON_TITLE_*` for the four bubble effects and `FSM_CONTROL_BUTTON_TITLE_*` for
 * the screen ones, all of the form "Replay <Name>". The visible label is `REPLAY_BUTTON_TITLE`,
 * which is just "Replay" — the effect's name is in the accessible name only, because on screen the
 * message it sits under already is the effect.
 *
 * Invisible Ink has no entry: it has no motion to replay, it has a reveal, which is
 * `InvisibleInk`'s own tap.
 */
export const replayEffectNames: Record<string, string> = {
  slam: "Slam", loud: "Loud", gentle: "Gentle",
  echo: "Echo", spotlight: "Spotlight", balloons: "Balloons", confetti: "Confetti",
  love: "Love", lasers: "Lasers", fireworks: "Fireworks", celebration: "Celebration",
};

export type ReplayEffectProps = Omit<ComponentProps<"button">, "children" | "onClick"> & {
  /** The effect the message was sent with. Invisible Ink draws nothing: it is revealed, not replayed. */
  kind: string;
  platform?: Platform;
  label?: string;
  onReplay?: () => void;
};

/**
 * The control under a message sent with an effect. **UNMEASURED:** no capture in `references/` holds
 * one, so it takes the status line's slot — the platform's measured status typography, gap and
 * trailing inset, which is where "Delivered" and "Not Delivered" already sit — in the accent blue a
 * control gets rather than the secondary grey a label gets. What is measured is that the slot exists
 * and where it is; what is chosen is that Replay belongs in it.
 */
export function ReplayEffect({ kind, platform: platformProp, label = "Replay", onReplay, className, style, ...props }: ReplayEffectProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const s = statusStyle[platform];
  const name = replayEffectNames[kind];
  if (!name) return null;
  return (
    <button type="button" data-slot="replay-effect" data-effect={kind} aria-label={`${label} ${name}`}
      onClick={onReplay}
      className={cn("cursor-pointer select-none border-0 bg-transparent p-0 text-right focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]", className)}
      style={{
        fontFamily: font, fontSize: s.fontSize, lineHeight: `${s.lineHeight}px`, fontWeight: 600,
        letterSpacing: s.letterSpacing, marginTop: s.gap, paddingInlineEnd: s.inset,
        color: "var(--im-tapback-own, #0088ff)", ...style,
      }} {...props}>
      {label}
    </button>
  );
}

export type NotDeliveredProps = Omit<ComponentProps<"div">, "children"> & {
  label?: string;
  platform?: Platform;
  /** Trailing inset of the label's ink. Defaults to the platform's "Delivered" inset. */
  inset?: number;
};

/**
 * The red status line that replaces "Delivered". Drop it in the same slot: it uses the platform's
 * status typography so the ink lands on the measured baseline.
 */
export function NotDelivered({ label = "Not Delivered", platform: platformProp, inset, className, style, ...props }: NotDeliveredProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const s = statusStyle[platform];
  return (
    <div data-slot="not-delivered" className={cn("select-none text-right", className)}
      style={{
        fontFamily: font, fontSize: s.fontSize, lineHeight: `${s.lineHeight}px`, fontWeight: 600,
        letterSpacing: s.letterSpacing, marginTop: s.gap, paddingInlineEnd: inset ?? s.inset, color: "#eb534e", ...style,
      }} {...props}>
      {label}
    </div>
  );
}
