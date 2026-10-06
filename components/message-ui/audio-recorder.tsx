"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { usePlatform, type Platform } from "@/components/message-ui/platform";
import { fontStack } from "@/components/message-ui/tokens";

/**
 * Recording a voice message: the composer's field becomes a row carrying a live waveform, a running
 * timer and a stop button; stopping swaps the stop for a play control, a duration pill with a `+`,
 * and a send pill.
 *
 * ## Where these numbers come from
 *
 * **No capture in `references/` holds this screen on either platform**, so every geometric number
 * below was read out of ChatKit — the framework both Messages apps run on — by a Mac Catalyst probe
 * whose full source is committed in `references/audio-recorder.md` and whose readings are tabulated
 * in `references/SPEC.md` ("Audio recorder"). The probe dlopens
 * `/System/iOSSupport/System/Library/PrivateFrameworks/ChatKit.framework/ChatKit`, swizzles
 * `-[UIDevice userInterfaceIdiom]` so `+[CKUIBehavior sharedBehaviors]` vends the Phone or the Mac
 * behaviour, stubs `+[IMService iMessageService]` (which the view's initialiser force-unwraps), then
 * **builds the real view**: `-[CKAudioMessageRecordingView initWithFrame:service:]`, feeds it known
 * intensities through `-addToWaveformWithIntensity:`, walks `-setState:` 0 to 3 and reads every
 * subview's frame, colour, radius, font and symbol image back. The frames below are the frames
 * Messages lays out.
 *
 * ChatKit's `-setState:` has four states; three of them are this component's:
 * 1 `recording`, 2 `stopped`, 3 `playing` (0 is the empty pose before recording starts).
 *
 * ### The row
 *
 * `-[CKAudioMessageRecordingView sizeThatFits:]` returns **52** tall on Phone and **49** on Mac.
 * Every child is centred in it, and — this reproduces all twelve measured child frames exactly —
 * **each child's leading or trailing inset equals its own vertical inset**, `(rowHeight - size) / 2`:
 * the 34/31 circles sit 9 in, the 30 x 22 send pill 15 in on Phone and 13.5 on Mac. Every gap
 * between neighbours is `audioRecordingViewDurationSpacing` **12**, except the waveform's leading
 * inset while recording, which is `audioRecordingViewButtonSpacing` **16** (there is no play button
 * to sit beside). Those two rules close on 294 and on 530 in all three states:
 *
 * | | leading | waveform | trailing chain |
 * |---|---|---|---|
 * | iOS recording | 16 | 181.5 | 12 + timer 29.5 + 12 + stop 34 + 9 |
 * | iOS stopped | 9 + play 34 + 12 | 109 | 12 + append 61 + 12 + send 30 + 15 |
 * | iOS playing | 9 + play 34 + 12 | 140.5 | 12 + timer 29.5 + 12 + send 30 + 15 |
 * | macOS recording | 16 | 415 | 12 + timer 35 + 12 + stop 31 + 9 |
 * | macOS stopped | 9 + play 31 + 12 | 348 | 12 + append 62.5 + 12 + send 30 + 13.5 |
 * | macOS playing | 9 + play 31 + 12 | 375.5 | 12 + timer 35 + 12 + send 30 + 13.5 |
 *
 * The waveform view is **0.75 of the row** — 39 in the 52 (which is `audioWaveformViewHeight`) and
 * 36.75 in the 49 — and is vertically centred, top 6.5 / 6.125.
 *
 * ### The waveform
 *
 * Bars are `waveformPowerLevelWidth` **2** wide with a radius of 1, `audioWaveformGapWidth` **2**
 * apart, so the pitch is 4; they are vertically centred and the strip is anchored to the box's
 * trailing edge, which leaves `width - 2 - (count - 1) * 4` empty at the leading edge (3 of hole in
 * a 109 box: measured, not a bug).
 *
 * **`height = level² × waveformViewHeight`, floored at `minimumWaveformHeight` 4.** Feeding the view
 * a ramp and reading the segments back: 0.3333 → 4.3333, 0.4 → 6.24, 0.4444 → 7.7037, 0.5 → 9.75,
 * 0.6 → 14.04, 0.6667 → 17.3334, 0.75 → 21.9375, 0.8 → 24.96, 0.9 → 31.59, 1 → 39 — every one of
 * them exactly `level² × 39`, and everything below 0.3203 clamped to 4. It scales to the **view**
 * height 39, not to `audioWaveformHeight` 35; a full-scale bar fills the box edge to edge.
 *
 * While recording, the newest bars ramp in: a bar `k` segments back from the leading edge is scaled
 * by **`min(1, sqrt(k / 4))`**, measured to five decimals at k = 0, 1, 2, 3, 4 (0, 0.5, 0.70711,
 * 0.86603, 1), with the k = 0 bar additionally at opacity 0. Bars ahead of the take are drawn at the
 * minimum height and half opacity, which is the track the wave is written onto.
 *
 * Once stopped, the take is resampled up to the bars that fit by **nearest neighbour**, bar `j`
 * taking level `floor(j × n / count)` — 5 levels in a 27-bar box measured as runs of 6, 5, 6, 5, 5.
 * The played part is **`max(1, floor(fraction × count))`** bars, checked at nine positions.
 *
 * ### Colours, resolved with `-resolvedColorWithTraitCollection:` in both styles
 *
 * - recording bars and timer ink `#FF383C` light / `#FF4245` dark, at full opacity, over a track of
 *   the same colour at 0.5;
 * - stopped and playing bars `rgba(0, 0, 0, 0.498)` / `rgba(255, 255, 255, 0.549)`, the part not yet
 *   played at 0.5 of that;
 * - play button fill `rgba(118, 118, 128, 0.12)` light and **0.24 dark** (the framework's own
 *   `UIBackgroundConfiguration`, read per trait), glyph `rgba(0, 0, 0, 0.847)` / `rgba(255, 255, 255, 0.847)`;
 * - stop button fill `rgba(255, 56, 60, 0.19)` in **both** styles, glyph the red above;
 * - the stopped duration pill `rgba(116, 116, 128, 0.08)` in both styles with 84.7% label ink; while
 *   recording and while playing the same pill has **no fill at all**;
 * - send `#0088ff` with a white arrow;
 * - the cancel button's `xmark` at 84.7% label ink over glass.
 *
 * ### Glyphs
 *
 * Each is the framework's own symbol image, rasterised at 8x and measured for its ink box and its
 * coverage, and the outlines below are fitted to both:
 *
 * | control | symbol | ink | coverage |
 * |---|---|---|---|
 * | stop | `stop.fill` 17 regular | 14 x 14 | 180.3853 |
 * | play | `play.fill` 17 regular | 12.5 x 14 | 101.8686 |
 * | pause | `pause.fill` 17 regular | 10.5 x 14 | 110.7490 |
 * | append | `plus` 17 regular | 14 x 14 | 37.4529 |
 * | send | `arrow.up` 17 **bold** | 13.5 x 16 | 68.9608 |
 * | cancel | `xmark` **16 medium** | 13 x 13 | 55.3471 |
 *
 * The send arrow's stem measures **2.4098** of stroke, which is the same weight `conv3-light.png`
 * gives the composer's own send pill (2.41 measured there) — but it is not the same drawing: the
 * composer's is a 38 x 28 pill and this is a 30 x 22 one, so the arrow is smaller here.
 *
 * The `xmark` is the one place the two fits disagree: its rows integrate to 4.9588 of ink, i.e.
 * 1.7532 of stroke at 45 degrees, while its total coverage wants 1.68. The 1.68 is drawn, because
 * total coverage is the more robust measure and is what this repo fits elsewhere.
 *
 * ## What is *not* from the framework
 *
 * - **Where the surface sits in the composer.** ChatKit's own
 *   `entryViewLeftInsetForRecordedAudioCancelButton` is 8.5 on both idioms, which is neither the
 *   iOS composer's measured 28 nor the macOS `+`'s measured 9, so its frame of reference could not
 *   be established and it is not used. Instead the cancel circle is centred on the **measured**
 *   centre of the `+` it replaces (iOS x 48, `SPEC.md`; macOS pane x 24) and the row takes the
 *   **measured** field box (iOS x 80–374, macOS pane x 49–579). Both rest their bottom edge on the
 *   composer's measured baseline (iOS y 846, macOS pane y 629), because every other element of both
 *   composers is bottom-aligned there. The row is taller than the field it replaces, so it grows
 *   upward. Derived from measurements, but not itself measured.
 * - **The row's corner radius.** UNMEASURED: `-[CKAudioMessageRecordingView cornerRadius]` is 0
 *   until the entry view sets it, and nothing in the framework stores what it sets. Drawn as a
 *   capsule (half the row's height), because both composer fields are capsules at one line.
 * - **The row's fill, rim and shadow.** Copied from the two composer files, which measured them, so
 *   that this stays a registry item with no dependency on either.
 * - **The entrance and the exit.** UNMEASURED. 260 / 200 ms on the iOS effects screen's measured
 *   `cubic-bezier(0.32, 0.72, 0, 1)`; a reuse, not a measurement of this surface.
 * - **The spring's frequency.** `stateChangeAnimationDuration` 0.6 and `stateChangeSpringDamping`
 *   0.86 are the view's own Swift ivars, read at their offsets; the frequency UIKit derives from
 *   that pair is not stored anywhere, so `springEasing` samples the spring whose envelope has
 *   decayed to 0.1% at 0.6 s. A fit.
 * - **The slide between segments.** ChatKit lays every bar on a 4 pt grid, so its model steps 4 pt
 *   twelve times a second; whether its display link interpolates between those frames cannot be read
 *   from a view that never runs. This slides the strip by `4 × frac(t / segment)`, which is the
 *   smallest continuous interpolation of the measured layout and is exactly ChatKit's frame at every
 *   whole segment.
 *
 * Every animation is seekable rather than merely playable: the slide is one Web Animations timeline
 * whose offset is linear in time, the state change takes `transition={{ from, progress }}` the way
 * `MacComposer` takes `grow`, and `progress` seeks the entrance and the exit to a frame rather than
 * jumping them to the end. `prefers-reduced-motion` builds no timeline at all and poses the row.
 */
export const audioRecorderMetrics = {
  /** ChatKit's, read per idiom. Points equal CSS px. */
  ios: {
    /** `-[CKAudioMessageRecordingView sizeThatFits:]`, Phone idiom, with a take in it. */
    rowHeight: 52,
    /** UNMEASURED: the entry view sets the row's radius and does not store it. A capsule. */
    rowRadius: 26,
    /** The play and stop circles. */
    button: 34,
    /** `CKGlassSendButton`. */
    send: { width: 30, height: 22, radius: 11 },
    /** `ChatKit.AudioMessageRecordingAppendButton` while recording and while playing. */
    timer: { width: 29.5, height: 16, radius: 8, fontSize: 13 },
    /**
     * The same button once stopped, where the whole pill is the control that appends to the take.
     * `glyph` is the framework's own image box for the `plus`; `ink` is what the symbol's 14 x 14 of
     * ink becomes once scaled into it.
     */
    append: { width: 61, height: 26, radius: 13, labelLeft: 21.5, glyph: { left: 7, top: 8, width: 11.5, height: 10.5, inkWidth: 8.944, inkHeight: 9.188 } },
    /** `CKGlassCancelAudioRecordingButton` `-sizeThatFits:`, radius 20.5, i.e. a circle. */
    cancel: 41,
    /**
     * Not ChatKit: the measured iOS composer (`SPEC.md`, `ios-composer.tsx`). The field's box, the
     * `+`'s centre and the composer's bottom margin on a 402-wide screen.
     */
    composer: { fieldLeft: 80, fieldWidth: 294, leadingCentre: 48, bottom: 28 },
  },
  macos: {
    rowHeight: 49,
    /** UNMEASURED, as above. */
    rowRadius: 24.5,
    button: 31,
    send: { width: 30, height: 22, radius: 11 },
    timer: { width: 35, height: 19, radius: 9.5, fontSize: 16 },
    append: { width: 62.5, height: 27, radius: 13.5, labelLeft: 20, glyph: { left: 5.5, top: 8.5, width: 11.5, height: 10.5, inkWidth: 8.944, inkHeight: 9.188 } },
    cancel: 35,
    /** Not ChatKit: the measured macOS composer (`SPEC.md`, `macos-composer.tsx`), pane coordinates. */
    composer: { fieldLeft: 49, fieldWidth: 530, leadingCentre: 24, bottom: 11 },
  },
} as const;

/** `CKUIBehavior`'s waveform constants, shared by both idioms. */
export const audioRecorderWaveform = {
  /** `waveformPowerLevelWidth` / `audioWaveformGapWidth`, so the pitch is 4. */
  barWidth: 2,
  barGap: 2,
  /** `minimumWaveformHeight`. */
  minBarHeight: 4,
  /** `audioWaveformViewHeight` / row height: 39 of 52 and 36.75 of 49 both come out at 0.75. */
  heightRatio: 0.75,
  /** `audioRecordingViewButtonSpacing`: the waveform's leading inset when no play button precedes it. */
  leadingInset: 16,
  /** `audioRecordingViewDurationSpacing`: every other gap in the row. */
  gap: 12,
  /** The newest bars ramp in over this many segments, measured as `min(1, sqrt(k / 4))`. */
  rampSegments: 4,
} as const;

/** Timings. All but the last three are ChatKit's. */
export const audioRecorderMotion = {
  /** `audioRecordingViewTimeBetweenWaveformSegments`: one bar every 83.33 ms. */
  segment: 1000 / 12,
  /** `minAudioRecordingDuration` / `maxAudioRecordingDuration`, in seconds. */
  minDuration: 0.25,
  maxDuration: 60,
  /** `AudioMessageRecordingView.stateChangeAnimationDuration` / `.stateChangeSpringDamping`. */
  stateChange: 600,
  stateChangeDamping: 0.86,
  /** UNMEASURED: reused from the measured iOS effects screen. Nothing measures this row appearing. */
  enter: 260,
  exit: 200,
  ease: "cubic-bezier(0.32, 0.72, 0, 1)",
} as const;

/** `audioRecordingViewMinimumDBLevel` / `MaximumDBLevel`, the window a microphone's power maps onto. */
export const audioRecorderPower = { minimumDb: -60, maximumDb: -10 } as const;

/**
 * ChatKit's own dB window as a 0..1 level, so a caller feeding real microphone power has the
 * conversion the framework uses rather than inventing one.
 */
export function audioLevelForPower(decibels: number): number {
  const { minimumDb, maximumDb } = audioRecorderPower;
  return clamp01((decibels - minimumDb) / (maximumDb - minimumDb));
}

export type AudioRecorderState = "recording" | "stopped" | "playing";

/** What comes off the row when you send it, and what `MessageAudio` needs to draw the balloon. */
export type AudioTake = { levels: number[]; duration: number };

/**
 * The recorder's levels squared are its bar heights (`level² × 39`); `MessageAudio` scales its
 * `peaks` linearly, so squaring here is what makes the balloon draw the same wave as the row it
 * came from.
 */
export function audioTakeToPeaks(levels: number[]): number[] {
  return levels.map(level => clamp01(level) * clamp01(level));
}

export type AudioRecorderProps = Omit<ComponentProps<"div">, "onChange" | "children"> & {
  platform?: Platform;
  /** Which pose the row is in. */
  state?: AudioRecorderState;
  /**
   * Levels 0..1, oldest first, one per 83.33 ms segment. Leave it out for a deterministic stand-in:
   * this never touches a microphone, and a screenshot has to land on the same bars every run.
   */
  levels?: number[];
  /** Length of the take in seconds. Defaults to `levels.length / 12`. */
  duration?: number;
  /** Seconds into the take, controlled. */
  position?: number;
  /**
   * Seeks the clock to this fraction of `duration` instead of running it, which is what the harness
   * does. It also stops the internal clock, so a checkpoint is a pure function of its props.
   */
  progress?: number;
  /** Seek the state change instead of playing it, the way `MacComposer` takes `grow`. */
  transition?: { from: AudioRecorderState; progress: number };
  /** False plays the exit and then calls `onExited`. */
  open?: boolean;
  onExited?: () => void;
  /** The `x`, and also what a take shorter than `minAudioRecordingDuration` reports instead of stopping. */
  onCancel?: () => void;
  onStop?: (take: AudioTake) => void;
  onSend?: (take: AudioTake) => void;
  /** The `+` inside the duration pill, which appends to the take. */
  onAppend?: () => void;
  onPlayChange?: (playing: boolean) => void;
  onSeek?: (seconds: number) => void;
  /** Width of the row. Defaults to the platform's measured composer field. */
  width?: number;
  /** Takes focus when it opens. Off by default so a seeked frame never moves the caret. */
  autoFocus?: boolean;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** m:ss. `floor` is a stopwatch, which is what the running timer is. */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * m:ss for a finished take. `message-audio.tsx` rounds the length it prints on the balloon, so the
 * pill has to round too or a 4.6 s take reads "0:04" here and "0:05" in the bubble it becomes.
 */
function clockRounded(seconds: number): string {
  return clock(Math.round(Math.max(0, seconds)));
}

/**
 * A deterministic stand-in take. Integer seeding and none of the transcendental functions:
 * ECMAScript does not require `Math.sin` to be correctly rounded, so a server and a browser can
 * disagree in the last ULP, and React reports that as a hydration mismatch. `Math.imul` is exact and
 * `+ - * /` are IEEE 754 exact, so this produces bit-identical levels in every engine.
 */
export function audioRecorderFallbackTake(count: number): number[] {
  let seed = 0x9e3779b9;
  let value = 0.55;
  const levels: number[] = [];
  for (let i = 0; i < count; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    value += (seed / 4294967296 - 0.5) * 0.55;
    // Reflect rather than clamp, so a long take does not flatten against either end.
    if (value < 0.34) value = 0.68 - value;
    if (value > 1) value = 2 - value;
    levels.push(value);
  }
  return levels;
}

/**
 * A damped spring as a `linear()` easing, so the state change is one seekable timeline. The damping
 * ratio is the framework's 0.86; the frequency is not stored anywhere, so this picks the one whose
 * envelope has decayed to 0.1% at the framework's 600 ms. A fit, not a reading.
 */
function springEasing(damping: number, steps = 24): string {
  const omega = -Math.log(0.001) / damping;
  const damped = omega * Math.sqrt(Math.max(0.0001, 1 - damping * damping));
  const points = Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const value = 1 - Math.exp(-damping * omega * t) * (Math.cos(damped * t) + ((damping * omega) / damped) * Math.sin(damped * t));
    return `${value.toFixed(4)} ${(t * 100).toFixed(2)}%`;
  });
  return `linear(${points.join(", ")})`;
}

/**
 * Web Animations rejects an easing it cannot parse, and `linear()` needs a 2023 engine, so a browser
 * without it falls back to the measured decelerating curve rather than losing the animation.
 */
function animateWithSpring(element: Element, frames: Keyframe[], duration: number, easing: string): Animation {
  try {
    return element.animate(frames, { duration, easing });
  } catch {
    return element.animate(frames, { duration, easing: audioRecorderMotion.ease });
  }
}

const reducedMotionQuery = () => (typeof window === "undefined" ? null : window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null);
function subscribeReducedMotion(onChange: () => void) {
  const query = reducedMotionQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}
/** True when the viewer asked for less motion; false while server rendering. Its own copy, as in `macos-composer.tsx`. */
function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, () => reducedMotionQuery()?.matches ?? false, () => false);
}

/* ------------------------------------------------------------------ glyphs */
/* Every outline below is fitted to the ink box and the coverage of the framework's own symbol image,
   rasterised at 8x. The width and height attributes are the ink box, and each `<svg>` is `shrink-0`
   so a flex parent cannot squash it out of proportion. */

/** `xmark` 16 medium: ink 13 x 13, coverage 55.3471, which a 1.68 stroke on a 13 box reproduces. */
function XmarkGlyph() {
  return (
    <svg aria-hidden="true" className="block shrink-0" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.68" strokeLinecap="round">
      <path d="M0.84 0.84 12.16 12.16M12.16 0.84 0.84 12.16" />
    </svg>
  );
}

/** `stop.fill` 17 regular: ink 14 x 14, coverage 180.3853, i.e. a 13.52 square with a 1.69 corner. */
function StopGlyph() {
  return (
    <svg aria-hidden="true" className="block shrink-0" width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <rect x="0.24" y="0.24" width="13.52" height="13.52" rx="1.69" />
    </svg>
  );
}

/** `play.fill` 17 regular: ink 12.5 x 14, coverage 101.8686, i.e. a triangle inset by a 1.93 round join. */
function PlayGlyph() {
  return (
    <svg aria-hidden="true" className="block shrink-0" width="12.5" height="14" viewBox="0 0 12.5 14" fill="currentColor" stroke="currentColor" strokeWidth="1.93" strokeLinejoin="round">
      <path d="M0.965 0.965 11.535 7 0.965 13.035Z" />
    </svg>
  );
}

/** `pause.fill` 17 regular: ink 10.5 x 14, coverage 110.7490, i.e. two 4.1 bars 2.3 apart, corner 1.5. */
function PauseGlyph() {
  return (
    <svg aria-hidden="true" className="block shrink-0" width="10.5" height="14" viewBox="0 0 10.5 14" fill="currentColor">
      <rect x="0" y="0" width="4.1" height="14" rx="1.5" />
      <rect x="6.4" y="0" width="4.1" height="14" rx="1.5" />
    </svg>
  );
}

/**
 * `plus` 17 regular: ink 14 x 14, coverage 37.4529, which a 1.4442 stroke across a 14 box
 * reproduces. The duration pill draws it into the framework's own 11.5 x 10.5 image box, so it is
 * scaled there rather than redrawn.
 */
function PlusGlyph({ width = 14, height = 14 }: { width?: number; height?: number }) {
  return (
    <svg aria-hidden="true" className="block shrink-0" width={width} height={height} viewBox="0 0 14 14" preserveAspectRatio="none" fill="none" stroke="currentColor" strokeWidth="1.4442" strokeLinecap="round">
      <path d="M0.7221 7H13.2779M7 0.7221V13.2779" />
    </svg>
  );
}

/**
 * `arrow.up` 17 **bold**: ink 13.5 x 16, coverage 68.9608, stem stroke measured at 2.4098 and arms
 * at 45 degrees. Not the same drawing as the composer's send pill, which is a bigger arrow in a
 * bigger pill; they agree only on the stroke weight.
 */
function ArrowUpGlyph() {
  return (
    <svg aria-hidden="true" className="block shrink-0" width="13.5" height="16" viewBox="0 0 13.5 16" fill="none" stroke="currentColor" strokeWidth="2.4098" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.205 6.75 6.75 1.205 12.295 6.75M6.75 1.205V14.795" />
    </svg>
  );
}

/* ------------------------------------------------------------------ theme */
/* One variable per painted thing, defined in both styles for both platforms. `--ar-shadow` carries
   the rim and the drop shadow together: `none` is not a legal entry in a comma-separated shadow
   list, so splitting them drops the whole declaration wherever one half is absent. */

const iosVars =
  // Glass, rim and shadow copied from the measured `ios-composer.tsx`; the rest is ChatKit's.
  "[--ar-glass:rgba(255,255,255,0.9)] [--ar-shadow:0_6px_36px_4px_rgba(0,0,0,0.065)] [--ar-round-shadow:0_5px_20px_6px_rgba(0,0,0,0.055)] " +
  "[--ar-red:#ff383c] [--ar-label:rgba(0,0,0,0.847)] [--ar-wave:rgba(0,0,0,0.498)] [--ar-play-fill:rgba(118,118,128,0.12)] [--ar-pill-fill:rgba(116,116,128,0.08)] " +
  "dark:[--ar-glass:rgba(28,28,28,0.9)] dark:[--ar-shadow:inset_0_0_0_1px_rgba(255,255,255,0.09)] dark:[--ar-round-shadow:inset_0_0_0_1px_rgba(255,255,255,0.09)] " +
  "dark:[--ar-red:#ff4245] dark:[--ar-label:rgba(255,255,255,0.847)] dark:[--ar-wave:rgba(255,255,255,0.549)] dark:[--ar-play-fill:rgba(118,118,128,0.24)] dark:[--ar-pill-fill:rgba(116,116,128,0.08)]";

const macVars =
  // Field fill, rim and shadow copied from the measured `macos-composer.tsx`; the rest is ChatKit's.
  "[--ar-glass:#ffffff] [--ar-shadow:0_5px_25px_rgba(0,0,0,0.07)] [--ar-round-shadow:0_5px_25px_rgba(0,0,0,0.07)] " +
  "[--ar-red:#ff383c] [--ar-label:rgba(0,0,0,0.847)] [--ar-wave:rgba(0,0,0,0.498)] [--ar-play-fill:rgba(118,118,128,0.12)] [--ar-pill-fill:rgba(116,116,128,0.08)] " +
  "dark:[--ar-glass:#232323] dark:[--ar-shadow:inset_0.774px_0.774px_0_0_#424242,inset_-0.774px_-0.774px_0_0_#424242,0_5px_25px_rgba(0,0,0,0.05)] " +
  "dark:[--ar-round-shadow:inset_0.774px_0.774px_0_0_#424242,inset_-0.774px_-0.774px_0_0_#424242,0_5px_25px_rgba(0,0,0,0.05)] " +
  "dark:[--ar-red:#ff4245] dark:[--ar-label:rgba(255,255,255,0.847)] dark:[--ar-wave:rgba(255,255,255,0.549)] dark:[--ar-play-fill:rgba(118,118,128,0.24)] dark:[--ar-pill-fill:rgba(116,116,128,0.08)]";

type Geometry = {
  waveLeft: number;
  waveRight: number;
  timerRight: number;
  timerWidth: number;
  timerHeight: number;
  timerRadius: number;
  stop: number;
  send: number;
  play: number;
};

/**
 * A clock that runs on `requestAnimationFrame` while `active`, reporting seconds. `quantum` rounds
 * what it reports down to a multiple of that many seconds, so the recording row re-renders at
 * ChatKit's own twelve segments a second instead of at the display's refresh rate; the slide between
 * those frames is a Web Animation, not a re-render.
 */
function useRunningClock(active: boolean, quantum: number, cap: number): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      // Not synchronous in the effect body: a frame later, so the lint rule and React both allow it.
      const reset = requestAnimationFrame(() => setSeconds(0));
      return () => cancelAnimationFrame(reset);
    }
    const started = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const elapsed = Math.min(cap, (now - started) / 1000);
      // At the cap, report the cap itself rather than the segment below it, so a caller watching for
      // `maxAudioRecordingDuration` actually sees it.
      const value = elapsed >= cap || quantum <= 0 ? elapsed : Math.floor(elapsed / quantum) * quantum;
      setSeconds(previous => (previous === value ? previous : value));
      if (elapsed < cap) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [active, quantum, cap]);
  return seconds;
}

export function AudioRecorder({
  platform: platformProp,
  state = "recording",
  levels,
  duration: durationProp,
  position: positionProp,
  progress,
  transition,
  open = true,
  onExited,
  onCancel,
  onStop,
  onSend,
  onAppend,
  onPlayChange,
  onSeek,
  width,
  autoFocus = false,
  className,
  style,
  ...props
}: AudioRecorderProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const ios = platform === "ios";
  const m = audioRecorderMetrics[platform];
  const w = audioRecorderWaveform;
  const motion = audioRecorderMotion;
  const reduced = usePrefersReducedMotion();

  const rowWidth = width ?? m.composer.fieldWidth;
  const take = useMemo(() => (levels?.length ? levels : audioRecorderFallbackTake(60)), [levels]);
  const duration = durationProp ?? take.length / 12;
  const recording = state === "recording";
  const playing = state === "playing";

  const root = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const waveBox = useRef<HTMLDivElement>(null);
  const timerBox = useRef<HTMLDivElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const laidOut = useRef<AudioRecorderState | null>(null);
  const exited = useRef(false);
  /** Callbacks live in a ref so an inline arrow cannot restart the timeline it just reported on. */
  const latest = useRef({ onExited, onStop, onCancel });
  useEffect(() => {
    latest.current = { onExited, onStop, onCancel };
  });

  /**
   * The clock, for a caller that passes neither a position nor a seek. While recording it advances a
   * segment at a time, which is the cadence ChatKit adds bars at; while playing it advances every
   * frame, so the playhead is smooth. Recording is capped at `maxAudioRecordingDuration`.
   */
  const live = progress === undefined && positionProp === undefined;
  const running = live && open && (recording || playing);
  const ticking = useRunningClock(running, recording ? motion.segment / 1000 : 0, recording ? motion.maxDuration : duration);

  const position = Math.max(0, Math.min(recording ? motion.maxDuration : duration,
    positionProp ?? (progress !== undefined ? clamp01(progress) * duration : ticking)));

  /** `maxAudioRecordingDuration`: ChatKit stops the take itself at 60 s. */
  const cappedRef = useRef(false);
  useEffect(() => {
    if (!running || !recording) { cappedRef.current = false; return; }
    if (position < motion.maxDuration || cappedRef.current) return;
    cappedRef.current = true;
    latest.current.onStop?.({ levels: take.slice(0, Math.round(motion.maxDuration * 12)), duration: motion.maxDuration });
  }, [running, recording, position, motion.maxDuration, take]);

  const geometry = useMemo(() => {
    const inset = (size: number) => (m.rowHeight - size) / 2;
    const build = (which: AudioRecorderState): Geometry => {
      const isRecording = which === "recording";
      const trailing = isRecording ? inset(m.button) + m.button : inset(m.send.height) + m.send.width;
      const timerWidth = which === "stopped" ? m.append.width : m.timer.width;
      return {
        waveLeft: isRecording ? w.leadingInset : inset(m.button) + m.button + w.gap,
        waveRight: trailing + w.gap + timerWidth + w.gap,
        timerRight: trailing + w.gap,
        timerWidth,
        timerHeight: which === "stopped" ? m.append.height : m.timer.height,
        timerRadius: which === "stopped" ? m.append.radius : m.timer.radius,
        stop: isRecording ? 1 : 0,
        send: isRecording ? 0 : 1,
        play: isRecording ? 0 : 1,
      };
    };
    return { recording: build("recording"), stopped: build("stopped"), playing: build("playing") };
  }, [m, w]);

  const pose = geometry[state];
  const waveWidth = Math.max(0, rowWidth - pose.waveLeft - pose.waveRight);
  const waveHeight = m.rowHeight * w.heightRatio;
  const pitch = w.barWidth + w.barGap;
  /** ChatKit fills the box with bars on a 4 pt grid anchored to its trailing edge. */
  const barCount = Math.max(1, Math.floor((waveWidth - w.barWidth) / pitch) + 1);

  /**
   * The bars. While recording they are the take itself, newest at the trailing edge, the newest four
   * scaled by `min(1, sqrt(k / 4))` and the slots ahead of the take drawn as the half-opacity track.
   * Once stopped the take is resampled up to the bars that fit by nearest neighbour, and the played
   * part is `max(1, floor(fraction × count))` of them.
   */
  // A hair of slack, so a clock that lands on 5.999999 segments still counts six of them.
  const segments = Math.max(0, (position * 1000) / motion.segment);
  const newestBar = Math.floor(segments + 1e-6);
  const phase = Math.min(1, Math.max(0, segments - newestBar));
  const fraction = duration > 0 ? clamp01(position / duration) : 0;
  const playedCount = Math.max(1, Math.floor(fraction * barCount));
  const bars = useMemo(() => {
    if (!recording) {
      return Array.from({ length: barCount }, (_, index) => {
        const level = take[Math.floor((index * take.length) / barCount)] ?? 0;
        return { level, scale: 1, opacity: index < playedCount ? 1 : 0.5 };
      });
    }
    return Array.from({ length: barCount }, (_, slot) => {
      const index = newestBar - (barCount - 1 - slot);
      const written = index >= 0 && index < take.length;
      const back = Math.max(0, segments - index);
      return {
        level: written ? take[index] : 0,
        scale: written ? Math.min(1, Math.sqrt(back / w.rampSegments)) : 1,
        // The bar being written is at 0 and the track ahead of the take at 0.5: both measured.
        opacity: written ? Math.min(1, back) : 0.5,
      };
    });
  }, [recording, barCount, take, playedCount, segments, newestBar, w.rampSegments]);

  /**
   * The slide. ChatKit lays every bar on the 4 pt grid and steps it once a segment; this runs one
   * linear Web Animation of a single segment on repeat, so between two of its frames the strip
   * slides instead of jumping, and at every whole segment it is exactly ChatKit's frame. Its
   * dependencies deliberately exclude the position: the animation carries the time, and restarting
   * it twelve times a second is what killed this animation before. A seeked or reduced-motion row
   * builds no timeline and wears the same offset as an inline transform instead, so a scrubbed
   * checkpoint is a pure function of its props.
   */
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element || !recording || reduced || !live) return;
    const animation = element.animate(
      [{ transform: "translateX(0px)" }, { transform: `translateX(${pitch}px)` }],
      { duration: motion.segment, easing: "linear", iterations: Infinity },
    );
    return () => animation.cancel();
  }, [recording, reduced, live, pitch, motion.segment]);

  /**
   * The state change. A transient override of the layout the render already put in place (no
   * `fill`), so the end of it is the settled row rather than a copy of it, and `transition` seeks it
   * instead of playing it. Which direction it runs is read from the props during render.
   */
  const transitionFrom = transition?.from;
  const transitionProgress = transition?.progress;
  useLayoutEffect(() => {
    const from = transitionFrom ?? laidOut.current;
    laidOut.current = state;
    if (from === null || from === undefined || from === state || reduced) return;
    const a = geometry[from];
    const b = geometry[state];
    const easing = springEasing(motion.stateChangeDamping);
    const animations: Animation[] = [];
    const move = (element: Element | null, frames: Keyframe[]) => {
      if (element) animations.push(animateWithSpring(element, frames, motion.stateChange, easing));
    };
    move(waveBox.current, [{ left: `${a.waveLeft}px`, right: `${a.waveRight}px` }, { left: `${b.waveLeft}px`, right: `${b.waveRight}px` }]);
    move(timerBox.current, [
      { right: `${a.timerRight}px`, width: `${a.timerWidth}px`, height: `${a.timerHeight}px`, borderRadius: `${a.timerRadius}px` },
      { right: `${b.timerRight}px`, width: `${b.timerWidth}px`, height: `${b.timerHeight}px`, borderRadius: `${b.timerRadius}px` },
    ]);
    move(stopButton.current, [{ opacity: a.stop }, { opacity: b.stop }]);
    move(sendButton.current, [{ opacity: a.send }, { opacity: b.send }]);
    move(playButton.current, [{ opacity: a.play }, { opacity: b.play }]);
    if (transitionProgress !== undefined) {
      const at = clamp01(transitionProgress) * motion.stateChange;
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = at;
      }
    }
    return () => { for (const animation of animations) animation.cancel(); };
  }, [state, transitionFrom, transitionProgress, geometry, reduced, motion.stateChange, motion.stateChangeDamping]);

  /**
   * Entrance and exit, one timeline run forwards or backwards. `open` is read during render, so the
   * closing pose gets its committed frames before `onExited` lets the caller unmount the row.
   * `progress` seeks the timeline rather than jumping it to its end, so a harness can checkpoint the
   * row mid-dismissal.
   */
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    if (open) exited.current = false;
    const closing = !open;
    const finish = () => {
      if (exited.current) return;
      exited.current = true;
      latest.current.onExited?.();
    };
    // Scrubbing is inspection, not a dismissal: a seeked exit poses the row and reports nothing.
    const reports = closing && progress === undefined;
    if (reduced) {
      element.style.opacity = closing ? "0" : "";
      if (!reports) return;
      const frame = requestAnimationFrame(finish);
      return () => cancelAnimationFrame(frame);
    }
    const away = { opacity: 0, transform: "scale(0.97)" };
    const settled = { opacity: 1, transform: "scale(1)" };
    const duration = closing ? motion.exit : motion.enter;
    const animation = element.animate(closing ? [settled, away] : [away, settled], {
      duration,
      easing: closing ? "ease-out" : motion.ease,
      fill: "both",
    });
    if (progress !== undefined) {
      animation.pause();
      animation.currentTime = clamp01(progress) * duration;
      return () => animation.cancel();
    }
    if (!closing) return () => animation.cancel();
    animation.addEventListener("finish", finish);
    return () => animation.removeEventListener("finish", finish);
  }, [open, progress, reduced, motion.enter, motion.exit, motion.ease]);

  useEffect(() => {
    if (!autoFocus || !open || progress !== undefined) return;
    // `focusVisible: false` because this focus is programmatic and the gesture that opened the
    // recorder is usually still in flight: both Chrome and WebKit only suppress the ring on a
    // programmatic focus once the pointer interaction has *resolved*, and a held touch has not, so
    // without it the primary control gets a ring iOS never draws. A menu can put the focus on its
    // container instead and let the first arrow key light a row (see `tapback-bar.tsx`); the
    // recorder has one control that matters, and a screen reader should land on it.
    // The option is typed here rather than passed as a literal: `focusVisible` ships in browsers but
    // is not in TypeScript's DOM lib as of 5.9, and in this repo it only type-checks because
    // @radix-ui/react-slider augments FocusOptions globally. A consumer installs these components
    // without radix, so a bare literal fails `tsc` there. Declaring it locally keeps both honest.
    const focus: FocusOptions & { focusVisible?: boolean } = { preventScroll: true, focusVisible: false };
    (recording ? stopButton.current : playButton.current)?.focus(focus);
  }, [autoFocus, open, progress, recording]);

  const seek = (clientX: number) => {
    const element = waveBox.current;
    if (!element || !onSeek || recording) return;
    const rect = element.getBoundingClientRect();
    onSeek(clamp01((clientX - rect.left) / rect.width) * duration);
  };

  /** One segment of scrub, which is the finest step the waveform can show. */
  const seekStep = motion.segment / 1000;
  const takeNow = (): AudioTake => ({
    levels: recording ? take.slice(0, Math.max(1, Math.round(position * 12))) : take,
    duration: recording ? position : duration,
  });

  const timeText = recording ? clock(position) : playing ? clock(position) : clockRounded(duration);
  const circle = "absolute flex items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]";
  const buttonInset = (m.rowHeight - m.button) / 2;
  const sendInset = (m.rowHeight - m.send.height) / 2;

  const row = (
    <div
      data-slot="recording-row"
      className="relative select-none"
      style={{
        width: rowWidth,
        height: m.rowHeight,
        // UNMEASURED: nothing stores the radius the entry view gives the row. Drawn as a capsule.
        borderRadius: m.rowRadius,
        background: "var(--ar-glass)",
        boxShadow: "var(--ar-shadow)",
        backdropFilter: ios ? "blur(24px)" : undefined,
        WebkitBackdropFilter: ios ? "blur(24px)" : undefined,
      }}
    >
      <button
        ref={playButton}
        type="button"
        data-slot="play"
        aria-label={playing ? "Pause audio message" : "Play audio message"}
        aria-pressed={playing}
        aria-hidden={recording}
        tabIndex={recording ? -1 : undefined}
        onClick={() => onPlayChange?.(!playing)}
        className={circle}
        style={{
          left: buttonInset, top: buttonInset, width: m.button, height: m.button,
          background: "var(--ar-play-fill)", color: "var(--ar-label)", opacity: pose.play,
          pointerEvents: recording ? "none" : undefined,
        }}
      >
        {playing ? <PauseGlyph /> : <PlayGlyph />}
      </button>

      <div
        ref={waveBox}
        data-slot="waveform"
        role={recording ? undefined : "slider"}
        aria-hidden={recording || undefined}
        tabIndex={recording ? undefined : 0}
        aria-label={recording ? undefined : "Playback position"}
        aria-valuemin={recording ? undefined : 0}
        aria-valuemax={recording ? undefined : duration}
        aria-valuenow={recording ? undefined : position}
        aria-valuetext={recording ? undefined : clock(position)}
        onPointerDown={event => { if (!recording && onSeek) { event.currentTarget.setPointerCapture(event.pointerId); seek(event.clientX); } }}
        onPointerMove={event => { if (event.buttons === 1) seek(event.clientX); }}
        onKeyDown={event => {
          if (recording || !onSeek) return;
          const step = event.shiftKey ? 1 : seekStep;
          if (event.key === "ArrowRight") { event.preventDefault(); onSeek(Math.min(duration, position + step)); }
          if (event.key === "ArrowLeft") { event.preventDefault(); onSeek(Math.max(0, position - step)); }
          if (event.key === "Home") { event.preventDefault(); onSeek(0); }
          if (event.key === "End") { event.preventDefault(); onSeek(duration); }
        }}
        className="absolute overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]"
        style={{ left: pose.waveLeft, right: pose.waveRight, top: (m.rowHeight - waveHeight) / 2, height: waveHeight }}
      >
        {/* Anchored to the box's trailing edge, which is where ChatKit puts the newest bar and what
            leaves the measured few points of hole at the leading edge. */}
        <div
          ref={strip}
          data-slot="waveform-bars"
          className="absolute flex items-center"
          style={{ right: 0, top: 0, height: waveHeight, gap: w.barGap, transform: recording ? `translateX(${phase * pitch}px)` : undefined }}
        >
          {bars.map((bar, index) => (
            <span
              key={index}
              aria-hidden="true"
              style={{
                width: w.barWidth,
                height: Math.max(w.minBarHeight, bar.level * bar.level * waveHeight * bar.scale),
                borderRadius: w.barWidth / 2,
                background: recording ? "var(--ar-red)" : "var(--ar-wave)",
                opacity: bar.opacity,
              }}
            />
          ))}
        </div>
      </div>

      <div
        ref={timerBox}
        data-slot="timer"
        className="absolute"
        style={{
          right: pose.timerRight, top: (m.rowHeight - pose.timerHeight) / 2, width: pose.timerWidth, height: pose.timerHeight,
          borderRadius: pose.timerRadius,
          // Measured: the pill carries a fill only once the take is stopped.
          background: state === "stopped" ? "var(--ar-pill-fill)" : "transparent",
          fontFamily: fontStack, fontSize: m.timer.fontSize,
          color: recording ? "var(--ar-red)" : "var(--ar-label)",
          fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
        }}
      >
        {state === "stopped" ? (
          // ChatKit's `AudioMessageRecordingAppendButton` holds one button that fills the pill, so
          // the whole pill appends to the take, not just the `plus`.
          <button
            type="button"
            data-slot="append"
            aria-label={`Record more, ${timeText}`}
            onClick={onAppend}
            className="absolute inset-0 rounded-[inherit] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]"
            style={{ color: "inherit", font: "inherit", fontVariantNumeric: "tabular-nums" }}
          >
            {/* The framework's own image box for the `plus`, and the ink the 14 x 14 symbol becomes
                once scaled into it. */}
            <span aria-hidden="true" className="absolute flex items-center justify-center"
              style={{ left: m.append.glyph.left, top: m.append.glyph.top, width: m.append.glyph.width, height: m.append.glyph.height }}>
              <PlusGlyph width={m.append.glyph.inkWidth} height={m.append.glyph.inkHeight} />
            </span>
            <span aria-hidden="true" className="absolute flex items-center justify-center"
              style={{ left: m.append.labelLeft, top: 0, bottom: 0, width: m.timer.width }}>
              {timeText}
            </span>
          </button>
        ) : (
          // No accessible name of its own: a name on a live region replaces the value it reads out.
          <span role="timer" className="absolute inset-0 flex items-center justify-center">{timeText}</span>
        )}
      </div>

      <button
        ref={stopButton}
        type="button"
        data-slot="stop"
        aria-label="Stop recording"
        aria-hidden={!recording}
        tabIndex={recording ? undefined : -1}
        onClick={() => {
          // `minAudioRecordingDuration`: a take shorter than a quarter second is a cancel, not a stop.
          if (position < motion.minDuration) onCancel?.();
          else onStop?.(takeNow());
        }}
        className={circle}
        style={{
          right: buttonInset, top: buttonInset, width: m.button, height: m.button,
          background: "color-mix(in srgb, var(--ar-red) 19%, transparent)", color: "var(--ar-red)",
          opacity: pose.stop, pointerEvents: recording ? undefined : "none",
        }}
      >
        <StopGlyph />
      </button>

      <button
        ref={sendButton}
        type="button"
        data-slot="send"
        aria-label="Send audio message"
        aria-hidden={recording}
        tabIndex={recording ? -1 : undefined}
        onClick={() => onSend?.(takeNow())}
        className="absolute flex items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]"
        style={{
          right: sendInset, top: sendInset, width: m.send.width, height: m.send.height,
          borderRadius: m.send.radius, background: "#0088ff", color: "#ffffff",
          opacity: pose.send, pointerEvents: recording ? "none" : undefined,
        }}
      >
        <ArrowUpGlyph />
      </button>
    </div>
  );

  const cancel = (
    <button
      type="button"
      data-slot="cancel"
      aria-label="Cancel audio message"
      onClick={onCancel}
      className="absolute flex items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]"
      style={{
        // Centred on the measured centre of the `+` it replaces, bottom edge on the composer's
        // measured baseline. See the note above: ChatKit's own 8.5 could not be placed.
        left: m.composer.leadingCentre - m.cancel / 2,
        bottom: m.composer.bottom,
        width: m.cancel, height: m.cancel,
        background: "var(--ar-glass)", boxShadow: "var(--ar-round-shadow)", color: "var(--ar-label)",
        backdropFilter: ios ? "blur(24px)" : undefined, WebkitBackdropFilter: ios ? "blur(24px)" : undefined,
      }}
    >
      <XmarkGlyph />
    </button>
  );

  return (
    <div
      ref={root}
      data-slot="audio-recorder"
      data-state={state}
      data-platform={platform}
      className={cn("absolute inset-x-0 bottom-0 isolate select-none", ios ? iosVars : macVars, className)}
      style={{ height: m.composer.bottom + m.rowHeight, fontFamily: fontStack, ...style } as CSSProperties}
      {...props}
    >
      {cancel}
      <div className="absolute" style={{ left: m.composer.fieldLeft, bottom: m.composer.bottom }}>{row}</div>
    </div>
  );
}
