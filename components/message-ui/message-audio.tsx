"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type SetStateAction } from "react";
import { cn } from "@/lib/utils";
import { usePlatform, type Platform } from "@/components/message-ui/platform";
import { bubbleMetrics, fontStack, type Direction } from "@/components/message-ui/tokens";
import { MessageBubble } from "@/components/message-ui/message-bubble";

/**
 * An audio message: a waveform, a play control, and the remaining time, inside a normal bubble.
 *
 * No native capture of an audio message exists in `references/`, but ChatKit describes the row and
 * this now uses what it says instead of the shape that was guessed here:
 *
 * | value | ChatKit | what was here |
 * |---|---|---|
 * | waveform height | `audioWaveformHeight` **35** | 28 (shared with the button) |
 * | bar gap | `audioWaveformGapWidth` **2** | 2.6 |
 * | play control | `audioProgressViewSize` **{29, 29}** | 28 |
 * | control to waveform | `audioBalloonHorizontalSpacing` **10** | 10, right by luck |
 * | waveform to time | `audioBalloonWaveformTimeSpace` **6** | 10 |
 * | vertical inset | `audioBalloonVerticalSpacing` **7** | the text bubble's 10 |
 *
 * Read at both idioms rather than assumed: `CKUIBehaviorMac` overrides exactly one of them,
 * `audioProgressViewSize` **{22, 22}**. Everything else above is the same on the Mac, including the
 * 35 waveform, which is why macOS no longer draws a 22 one.
 *
 * So the row is not one height: the waveform is 35 and the control is 29, and the balloon insets its
 * contents by 7 vertically rather than by the 10 a text bubble uses. `audioBalloonAlignmentInsets`
 * is {0,0,0,0}, which is what says the 7 is the whole vertical inset.
 *
 * Still not measured, because ChatKit is silent on them: the **bar width**, and therefore the bar
 * count, which is only how many fit. `audioRecordingViewTimeBetweenWaveformSegments` is 1/12 s, so a
 * recording lays down 12 bars a second - that fixes the count for a recording of known length but
 * not the width of one.
 *
 * What is not guessed:
 * - The bubble, its radius and its tail are the measured ones, because this renders inside
 *   `MessageBubble`.
 * - The duration label reuses a type size measured on its own platform: iOS 13pt (the "Send with
 *   effect" segmented-control label, the one measured step between the 11pt secondary label and the
 *   17pt body) and macOS 11pt (the attachment card's "Text Document / 275 bytes" line).
 * - The row's width is the sum of its parts, so the bubble hugs it the way a text bubble hugs its
 *   longest line. `maxWidth` is passed in px: the platform default is a percentage of the bubble's
 *   own shrink-to-fit box, which collapses for content that is not text.
 * - The bubble's line-hugging fit measures the laid-out line boxes, so the row has to be the widest
 *   of them. It is: one inline box holding everything, with no loose text beside it. The duration
 *   still contributes a second, narrower rect of its own, which the fit ignores.
 */
export type MessageAudioProps = Omit<ComponentProps<"div">, "children"> & {
  /** Bar heights, 0..1, oldest first. Pass real peaks, or leave it out for a deterministic stand-in. */
  peaks?: number[];
  /** Total length in seconds. */
  duration: number;
  direction?: Direction;
  tail?: boolean;
  /** Controlled playback position in seconds. */
  position?: number;
  playing?: boolean;
  onPlayChange?: (playing: boolean) => void;
  onSeek?: (seconds: number) => void;
  /** Widest the bubble may grow, in px. Defaults to the platform's maximum bubble width. */
  maxWidth?: number;
  platform?: Platform;
};

function fallbackPeaks(count: number): number[] {
  // Deterministic, so screenshots are stable and no Math.random leaks into a render.
  return Array.from({ length: count }, (_, i) => {
    const a = Math.sin(i * 0.7) * 0.5 + 0.5;
    const b = Math.sin(i * 1.9 + 1.1) * 0.5 + 0.5;
    return 0.18 + Math.min(1, a * 0.6 + b * 0.55) * 0.82;
  });
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function MessageAudio({ peaks, duration, direction = "outgoing", tail = false, position = 0, playing = false, onPlayChange, onSeek, maxWidth, platform: platformProp, className, style, ...props }: MessageAudioProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const ios = platform === "ios";
  // The bar count is still only how many fit, because ChatKit gives a gap and no bar width. At the
  // measured maximum bubble width: iOS 280.5 - 27.7 padding - 29 control - 16 of gaps - 28.13 for a
  // "0:17" label leaves 179.67, and 36 bars at 3 with 2 between them are 178 of it.
  const barCount = ios ? 36 : 28;
  const bars = useMemo(() => (peaks?.length ? peaks : fallbackPeaks(barCount)), [peaks, barCount]);
  // UNVERIFIED: no source gives a bar width.
  const barWidth = ios ? 3 : 2.5;
  /** `audioWaveformGapWidth`. */
  const barGap = ios ? 2 : 2;
  /** `audioWaveformHeight`: 35 on both idioms, taller than the control beside it. */
  const waveHeight = 35;
  /** `audioProgressViewSize`: the one value the Mac class overrides, {22, 22} against {29, 29}. */
  const controlSize = ios ? 29 : 22;
  /** `audioBalloonVerticalSpacing`: 7 on both, not the text bubble's 10 (iOS) or 7.03 (macOS). */
  const insetY = 7;
  /** `audioBalloonWaveformTimeSpace`: 6 on both. */
  const timeGap = 6;
  const played = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
  const track = useRef<HTMLSpanElement>(null);
  const outgoing = direction === "outgoing";
  const ink = outgoing ? "var(--im-outgoing-text, #ffffff)" : "var(--im-incoming-text)";

  const seek = (clientX: number) => {
    const element = track.current;
    if (!element || !onSeek) return;
    const rect = element.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration);
  };

  return (
    <MessageBubble data-slot="message-audio" direction={direction} tail={tail} platform={platform}
      maxWidth={maxWidth ?? bubbleMetrics[platform].maxWidth}
      className={cn(className)} style={{ fontFamily: fontStack, ...style }} {...props}>
      {/* One inline-flex box, so the bubble's text fit sees the whole row as the widest line and hugs
          it. The name is an aria-label rather than visually hidden text: text inside the bubble lays
          out its own line box, which the fit would then measure instead of this row. `max-width` is
          what keeps an inline box, which otherwise overflows rather than wrapping, inside the
          measured padding; a long duration then narrows the bars instead. */}
      <span role="group" aria-label={`Audio message, ${clock(duration)}`}
        className="inline-flex items-center align-middle"
        style={{ gap: ios ? 10 : 8, maxWidth: "100%", whiteSpace: "nowrap", marginBlock: ios ? insetY - bubbleMetrics[platform].paddingY : 0 }}>
        <button type="button" aria-label={playing ? "Pause audio message" : "Play audio message"} aria-pressed={playing}
          onClick={() => onPlayChange?.(!playing)}
          className="flex shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]"
          style={{ width: controlSize, height: controlSize, background: outgoing ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.08)", color: ink }}>
          {playing ? (
            <svg aria-hidden="true" width={ios ? 11 : 9} height={ios ? 12 : 10} viewBox="0 0 11 12"><rect x="0" y="0" width="4" height="12" rx="1.2" fill="currentColor" /><rect x="7" y="0" width="4" height="12" rx="1.2" fill="currentColor" /></svg>
          ) : (
            <svg aria-hidden="true" width={ios ? 11 : 9} height={ios ? 12 : 10} viewBox="0 0 11 12"><path d="M1 1.1c0-.8.9-1.3 1.6-.9l7 4.9c.6.4.6 1.4 0 1.8l-7 4.9c-.7.4-1.6-.1-1.6-.9z" fill="currentColor" /></svg>
          )}
        </button>
        <span ref={track} data-slot="waveform" role="slider" tabIndex={0}
          aria-label="Playback position" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(position)} aria-valuetext={clock(position)}
          onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); seek(event.clientX); }}
          onPointerMove={event => { if (event.buttons === 1) seek(event.clientX); }}
          onKeyDown={event => {
            if (!onSeek) return;
            if (event.key === "ArrowRight") { event.preventDefault(); onSeek(Math.min(duration, position + 1)); }
            if (event.key === "ArrowLeft") { event.preventDefault(); onSeek(Math.max(0, position - 1)); }
          }}
          className="inline-flex flex-1 cursor-default items-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]"
          style={{ height: waveHeight, gap: barGap }}>
          {bars.map((peak, index) => {
            const reached = index / bars.length <= played;
            return (
              <span key={index} aria-hidden="true" style={{
                width: barWidth, height: Math.max(3, peak * waveHeight), borderRadius: barWidth / 2,
                background: ink, opacity: reached ? 1 : outgoing ? 0.45 : 0.28,
              }} />
            );
          })}
        </span>
        {/* `audioBalloonWaveformTimeSpace`: the waveform and the time sit closer than the control and
            the waveform do, so this gap is its own, not the row's. */}
        <span aria-hidden="true" style={{ marginInlineStart: timeGap - (ios ? 10 : 8), fontSize: ios ? 13 : 11, color: ink, opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>
          {clock(playing || position > 0 ? duration - position : duration)}
        </span>
      </span>
    </MessageBubble>
  );
}

/** Drives `position` while `playing`, without pulling in an audio element. */
export function useAudioProgress(duration: number, playing: boolean) {
  const [position, setPosition] = useState(0);
  const positionRef = useRef(0);
  const [seekVersion, setSeekVersion] = useState(0);
  const seek = useCallback((value: SetStateAction<number>) => {
    const next = typeof value === "function" ? value(positionRef.current) : value;
    positionRef.current = Math.max(0, Math.min(duration, next));
    setPosition(positionRef.current);
    // Restart the clock from the seek position, including after reaching the end.
    setSeekVersion(version => version + 1);
  }, [duration]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let started: number | undefined;
    const base = positionRef.current;
    const step = (now: number) => {
      started ??= now;
      const next = Math.min(duration, base + (now - started) / 1000);
      positionRef.current = next;
      setPosition(next);
      if (next < duration) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, seekVersion]);
  return [position, seek] as const;
}
