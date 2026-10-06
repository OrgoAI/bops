"use client";

import { useId, useLayoutEffect, useRef, type ComponentProps, type CSSProperties, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { usePlatform, type Platform } from "@/components/message-ui/platform";
import { emojiFontStack, fontStack } from "@/components/message-ui/tokens";

/**
 * Tapback balloon, measured from iOS 26 (`references/ios/captures/tapback-love-light.png`, 3x):
 * a Ø34 circle with two trailing circles (Ø10.4 at (−10.82, +15.20) and Ø5 at (−17.49, +23.46) from
 * the balloon's center) pointing away from the bubble. Own reactions are #0088ff (light and dark), the
 * heart is an 18.34×16.33 glossy pink shape centered 0.8 below the circle's center. Others' balloons are
 * #e9e9eb light / #262629 dark (`incoming-light.png`, `incoming-dark.png`). macOS (circle-fitted on
 * `references/macos/captures/tapback-love-light-2x.png` and `tapback-love-dark-2x.png`, both 2x, rmse
 * 0.01–0.03 pt): Ø27.98 centred (136.72, 57.45) pt, trail Ø8.04 at (−9.04, +12.42) and Ø4.00 at
 * (−14.22, +19.05), heart ink 14.64 × 12.96 centred 0.53 below the circle's centre. Both captures give
 * the same numbers to 0.01 pt.
 *
 * The macOS fill is one theme-independent blue, #5498f8, laid over the pane with a vertical opacity
 * ramp: solving the light/dark pair row by row gives a constant colour (85, 152, 248) and an alpha of
 * 0.912 at the top edge rising to 1.00 at ≈83% down (light row y=89 reads (100,161,249), dark
 * (80,141,229); by row y=139 both read (84,152,248)). The trailing circles are fully opaque.
 * The artwork is also knocked out of whatever it covers by a 0.5 pt rim in the pane colour: invisible
 * over the empty pane, it shows as a ring where the balloon laps the bubble (dark 2x, radial cut at
 * −50°: (84,151,247) → (55,88,133) → (84,152,248); light: (85,152,248) → (182,218,251) → (108,186,245)).
 */
export const tapbackLabels = { love: "Love", like: "Like", dislike: "Dislike", laugh: "Laugh", emphasize: "Emphasize", question: "Question" } as const;
export type TapbackType = keyof typeof tapbackLabels;
export const tapbackTypes = Object.keys(tapbackLabels) as TapbackType[];

/** Local color tokens (not in tokens.ts). Measured own-reaction blue; the rest are system values. */
export const tapbackColors = {
  own: "#0088ff",
  ownDark: "#0088ff",
  /** Highlight ring behind the chosen tapback inside the bar (Ø44.2; measured on both selected captures). */
  selectedRing: "#26aeff",
  selectedRingDark: "#0064d2",
} as const;

/**
 * The macOS own-reaction blue and the opacity ramp the main circle carries over it. Solved row by row
 * from the light/dark pair of `tapback-love-*-2x.png` at the balloon's own rows y 89–139 (2x): one
 * colour in both themes, alpha 0.907 at the top edge, 0.951 a quarter down, 0.982 at the centre and
 * opaque from ≈83% down. Reproducing it as alpha (not as two baked colours) keeps both themes right.
 */
export const macosBalloonFill = "#5498f8";
const macosBalloonSurface = "linear-gradient(to bottom, rgba(84,152,248,0.907) 0%, rgba(84,152,248,0.951) 25%, rgba(84,152,248,0.982) 50%, rgba(84,152,248,1) 100%)";
/** The macOS balloon is knocked out of what it covers by this much pane colour (measured 0.51 pt). */
export const macosBalloonRim = 0.5;

/**
 * CSS variables the tapback UI reads (with fallbacks to the light iOS values). Spread on a frame
 * next to `paletteVars`. Glass fills were solved from the captures: the pill over the dimmed white
 * list is #ededef and over the dimmed green bubble ≈#b4efc6 (brighter than the dimmed content, hence
 * the brightness term); over the dimmed black list it is #1f1e21.
 *
 * The dim is one material in both themes at alpha 0.21 over ≈(22, 21.5, 42), and it is measured, not
 * guessed: `longpress-ok-light.png` is `conv3-light.png` with one message pressed, so regressing one
 * capture on the other over the clean rows gives it directly - slope 0.7895/0.8067/0.7889, residual
 * rms 0.17/0.29/0.26 per channel. `conv2-dark.png` -> `longpress-ok-selected-dark.png` returns alpha
 * 0.217/0.210/0.213 over (22.5, 19.1, 42.3), i.e. the same dim. The (22,18,44) this used to carry
 * rendered white as (206,205,210) where every light capture reads (206,206,210).
 *
 * The two themes then carry different green channels (22 light, 21 dark) because no single 8-bit
 * value serves both in Chrome, which quantizes the 0.21 alpha to 54/255 = 0.211765 before
 * compositing. Green 21.5 lands half a level either side of a rounding boundary at both ends of the
 * range: over white it composites to 205.55, and the light captures read 206 (G 22 gives 205.66, G 21
 * gives 205.45); over black it composites to 4.55, and the dark captures read 4 (G 21 gives 4.45,
 * G 22 gives 4.66). R 22 and B 42 clear their boundaries at both ends and need no such split. Over
 * `longpress-ok-light.png` the light nudge takes the frame's interior from -0.9 to -0.1 mean signed
 * green and 1.30 to 1.15 levels of mean absolute error; over `longpress-dark.png` holding dark at 21
 * keeps it at 1.21 rather than 1.46. `messageActionsDim`'s fallback carries the dark value.
 *
 * `--im-menu-glass` was refitted against the captures rather than guessed. Because the tint, the
 * alpha and the brightness term all trade off against each other, only two things are actually
 * determined by a capture: the constant the material contributes, and how much of the backdrop
 * survives it. Both were solved by rendering the menu twice at a fixed alpha and filter, once with a
 * black tint and once with a white one, which makes the output linear in the tint, and then solving
 * for the tint that lands on the capture.
 *
 * The solve runs on the menu's lower 55% only. Above that the menu laps the message it was opened
 * on, and there NO tint at this alpha can reach the capture: at y 610 of `longpress-ok-light.png` the
 * glass reads (181,238,198) over a dimmed bubble the filter turns into ≈(84,238,128), so at alpha 0.8
 * the tint would have to be (-59,218,14). Native carries far more of the bubble's colour through than
 * a flat fill plus `wash` can, and that is a `context-menu.tsx` / `message-actions.tsx` question
 * (the `tint` gradient the menu already supports and the overlay never passes), not a material one.
 * Ours runs +18 R / +12 B over that band and matches to 1-3 levels everywhere below it.
 *
 * The light value was confirmed first, against the old 0.16 shadow: with `longpress-two-line`
 * reconstructing, ok / incoming / two-line solve to (240.0,243.6,243.7), (240.2,240.8,244.0) and
 * (241.2,244.4,244.7), i.e. rgba(241,243,244,0.8) holds and two-line, which used to sit seven levels
 * off, now agrees with the other two. The number in the table below is 4 levels lower than that only
 * because the shadow underneath it changed; see the next paragraph.
 *
 * Both values are then re-solved at the measured shadow, because `context-menu.tsx` paints
 * `menu-shadow` INSIDE the menu, under the glass, so the glass's own backdrop carries it and the
 * tint absorbs whatever it contributes. Taking the shadow from 0.16 to the measured 0.098 lightens
 * that backdrop and drops the solved tint by 4 levels; the slope is 64.5 tint levels per unit of
 * shadow alpha, so a `context-menu.tsx` that masked its own shape out of the shadow (which is what
 * native draws - a drop shadow is not visible under the menu) would want ≈(231,233,234) instead.
 * At 0.098 the three light captures solve to (236.2,239.9,239.9), (236.3,236.9,240.0) and
 * (237.2,240.5,240.7): rgba(237,239,240,0.8), residuals 1.75 / 1.84 / 1.52 levels.
 *
 * Dark is rgba(20,22,23,0.8), fitted the same way now that the dark scenes reconstruct:
 * `longpress-first` -> `longpress-dark.png` (19.4,22.2,22.7), `longpress-last` ->
 * `longpress-last-bubble-dark.png` (20.2,20.5,23.2) and `longpress-selected` ->
 * `longpress-ok-selected-dark.png` (20.4,21.8,23.9), i.e. three captures inside 1.7 levels of each
 * other. It takes the same band from 2.76/2.45/2.43 levels of mean absolute error to 1.61/1.31/1.36.
 * The rgba(20,25,25,0.8) it used to carry was 3 levels green-heavy.
 *
 * `--im-menu-shadow` is the menu's drop shadow, and 0.098 is measured, not the 0.16 the component
 * defaults to. `longpress-ok-light.png` divided by `conv3-light.png` and the dim gives the shadow's
 * alpha directly on every pixel around the menu; fitting a Gaussian to the ring below and beside it
 * returns alpha 0.0992, sigma 17.52 pt, offset 7.00 pt down (rms 0.0025 alpha), and
 * `longpress-incoming-light.png` over `incoming-light.png` returns 0.0971 / 17.18 / 7.00. It is a
 * pure black shadow: the three channels' alphas agree to 0.001. NOTE for `context-menu.tsx`: its
 * `blur(11px)` is a sigma of 11 and needs to be 17.4 for the falloff to match - the shadow reaches
 * 41 pt below the menu in the capture and 28 in ours. The alpha is right either way (fitting it at
 * the wrong sigma returns 0.1012), so this value stands on its own.
 *
 * The dark theme's shadow is UNVERIFIED: every dark capture puts the menu over a near-black ground,
 * where a black shadow at any alpha is invisible. It carries the light value rather than the
 * component's unmeasured 0.16.
 */
export function tapbackVars(theme: "light" | "dark", platform: Platform = "ios"): Record<string, string> {
  const ios: Record<string, string> = theme === "light" ? {
    "--im-dim": "rgba(22,22,42,0.21)", "--im-glass": "rgba(229,229,231,0.69)", "--im-glass-filter": "blur(9px) brightness(1.32) saturate(1.35)", "--im-glass-solid": "#ededef", "--im-glass-rim": "rgba(255,255,255,0.55)",
    "--im-glass-shadow": "0 6px 24px rgba(0,0,0,0.10)", "--im-picker-icon": "#aeaeb2", "--im-menu-glass": "rgba(237,239,240,0.8)", "--im-menu-glass-filter": "blur(9px) brightness(1.32) saturate(1.35)", "--im-menu-bg": "#edeff1", "--im-menu-text": "#000000", "--im-menu-shadow": "rgba(0,0,0,0.098)",
    "--im-menu-separator": "rgba(0,0,0,0.12)", "--im-menu-destructive": "#ff3b30", "--im-tapback-own": tapbackColors.own, "--im-tapback-ring": tapbackColors.selectedRing,
  } : {
    "--im-dim": "rgba(22,21,42,0.21)", "--im-glass": "rgba(38,37,39,0.8)", "--im-glass-filter": "blur(9px) saturate(1.6)", "--im-glass-solid": "#1f1e21", "--im-glass-rim": "rgba(255,255,255,0.10)",
    "--im-glass-shadow": "0 6px 24px rgba(0,0,0,0.5)", "--im-picker-icon": "#8e8e93", "--im-menu-glass": "rgba(20,22,23,0.8)", "--im-menu-glass-filter": "blur(9px) saturate(2)", "--im-menu-bg": "#121316", "--im-menu-text": "#ffffff", "--im-menu-shadow": "rgba(0,0,0,0.098)",
    "--im-menu-separator": "rgba(255,255,255,0.15)", "--im-menu-destructive": "#ff453a", "--im-tapback-own": tapbackColors.ownDark, "--im-tapback-theirs": "#3b3b3d", "--im-tapback-ring": tapbackColors.selectedRingDark,
  };
  if (platform === "ios") return ios;
  const macos = { "--im-tapback-own": macosBalloonFill, "--im-tapback-own-surface": macosBalloonSurface };
  return theme === "light"
    ? { ...ios, ...macos, "--im-menu-bg": "rgba(247,248,251,0.92)", "--im-menu-text": "#242526", "--im-menu-separator": "#dfe0e2", "--im-menu-border": "#b1b1b1", "--im-menu-rim": "rgba(255,255,255,0.7)" }
    : { ...ios, ...macos, "--im-menu-bg": "rgba(30,34,39,0.92)", "--im-menu-text": "#dcddde", "--im-menu-separator": "#3e4145", "--im-menu-border": "#050506", "--im-menu-rim": "rgba(255,255,255,0.28)", "--im-tapback-theirs": "#3b3b3d" };
}

export type BalloonGeometry = { main: number; medium: number; small: number; mediumOffset: [number, number]; smallOffset: [number, number]; glyph: number; /** The glyph sits this far below the circle's centre. */ glyphOffsetY?: number };

/**
 * Balloon geometry per platform. Offsets are the trailing circles' centers relative to the main
 * center, pointing left. iOS from `incoming-light.png` (Ø34.0, trail Ø10.4 at (−10.82, +15.20) and
 * Ø5.0 at (−17.49, +23.46), heart ink 18.34).
 *
 * macOS is circle-fitted on both `tapback-love-light-2x.png` and `tapback-love-dark-2x.png`, which
 * agree to 0.01 pt: main centre (273.44, 114.90) px Ø55.97 px, medium (255.37, 139.73) Ø16.07, small
 * (245.00, 153.00) Ø7.99. It is close to the iOS artwork at 28/34 but not exactly: that scaling would
 * put the trail at Ø8.57 and Ø4.12, 6% and 3% larger. The heart ink (rows y 103–129, columns x 259–288)
 * measures 14.64 × 12.96 with its centre 0.53 below the circle's, of which 0.07 comes from the glyph
 * box itself, so the box is nudged 0.46.
 *
 * **ChatKit agrees with both captures, once its rim is taken off.** Read out of the live framework on
 * 2026-09-10 with the Catalyst probe in `references/tapback-details.md` (`CKUIBehaviorPhone` and
 * `CKUIBehaviorMac`, one process, no scaling):
 * `-[CKUIBehavior messageAcknowledgmentTranscriptBalloonSize]` is **{36, 36} on iPhone and {29, 29} on
 * Mac**, against the Ø34 and Ø28 measured here. The difference is exactly the rim `aggregateStack`
 * below already documents from the artwork — `AcknowledgmentStackBackground-*` is the silhouette 1.0
 * (phone) / 0.5 (Mac) larger on every side — so 34 + 2×1 = 36 and 28 + 2×0.5 = 29. The framework sizes
 * the balloon *view*; `main` is the ink inside it. Two independent readings, no disagreement.
 *
 * `-[CKUIBehavior messageAcknowledgmentTranscriptGlyphInset]` is **4 on iPhone, 3 on Mac**, so the
 * glyph's image box is 36 − 8 = 28 and 29 − 6 = 23. `glyph` is the heart's *ink* inside that box
 * (18.34 of 28, 14.64 of 23), which is what a capture can see; the two are not the same number and
 * neither contradicts the other.
 */
export const balloonGeometry: Record<Platform, BalloonGeometry> = {
  ios: { main: 34, medium: 10.4, small: 5, mediumOffset: [-10.82, 15.2], smallOffset: [-17.49, 23.46], glyph: 18.34, glyphOffsetY: 0.8 },
  macos: { main: 28, medium: 8.04, small: 4, mediumOffset: [-9.04, 12.42], smallOffset: [-14.22, 19.05], glyph: 14.64, glyphOffsetY: 0.46 },
};

/**
 * Where a balloon sits relative to the bubble body it belongs to, measured on the settled captures.
 * `marginTop` is the extra space the list opens above the bubble, `top`/`side` place the main circle
 * against the body's top corner on the side away from the screen edge. Consumed by `message-bubble`.
 *
 * iOS: `conv3-light.png` → `tapback-love-light.png` is the same fixture with and without the balloon,
 * and the cluster gap grows from 10.313 to 38.313, i.e. exactly 28. `top`/`side` average the outgoing
 * capture (−27.47 / −14.02) and the mirrored incoming one (`incoming-light.png`, −27.31 / +13.68).
 * macOS (`tapback-love-dark-2x.png`, cross-checked light): body bottom 34.93 → next body top 65.51 is
 * a 30.58 gap where the cluster gap below it is 3.18, so the slot opens 27.40; the Ø28 circle's top
 * (86.92 px) sits 22.05 above the body top (131.01 px) and its leading edge (245.46 px) 11.79 outside
 * the body's leading edge (269.03 px).
 *
 * `message-bubble` carries its own copy of these numbers as `reactionOffsets` and is the one that
 * actually places a balloon — for a photo, a link card, an audio row and a bare emoji as well as for
 * a text bubble. Its macOS row used to read { 19.6, −19.1, −9.9 }, 7.8 / 3.0 / 1.9 pt off; it now
 * carries this pair, and `tests/unit/tapback-slot.test.ts` holds the three copies together.
 *
 * **ChatKit carries a position too, and it does NOT reproduce these captures.**
 * `-[CKUIBehavior messageAcknowledgmentTranscriptBalloonRelativePosition]` is {12.5, −15.5} on iPhone
 * and {9, −13} on Mac (same probe as `balloonGeometry`). Four readings of what that point could be
 * were tried against the iOS capture, whose Ø34 ink sits at (−13.85, −27.39) from the body's top
 * corner, i.e. ink centre (+3.15, −10.39) and 36-pt view centre the same:
 *
 * | reading of the point                          | ink left | ink top | capture |
 * |-----------------------------------------------|----------|---------|---------|
 * | view centre at corner + (−12.5, −15.5)        | −29.50   | −32.50  | −13.85 / −27.39 |
 * | view centre at corner + (+12.5, −15.5)        |  −4.50   | −32.50  | −13.85 / −27.39 |
 * | view top-left at corner + (−12.5, −15.5)      | −11.50   | −14.50  | −13.85 / −27.39 |
 * | 12.5 of the 36-wide view overlapping the body | −22.50   | —       | −13.85 |
 *
 * None lands. The capture is what this kit keeps (two captures, outgoing and incoming, agreeing to
 * 0.16 / 0.34 pt), and the framework number is recorded here rather than used. Whatever coordinate
 * space it is in, it is not "offset from the balloon's top corner in points", and nothing was found
 * that says which space it is.
 */
export const balloonSlot: Record<Platform, { marginTop: number; top: number; side: number }> = {
  ios: { marginTop: 28, top: -27.39, side: -13.85 },
  macos: { marginTop: 27.4, top: -22.05, side: -11.79 },
};

/**
 * More than one person reacting does not make a pill with a number on it - that was invented here.
 * ChatKit draws an aggregate balloon out of its own artwork: `-[CKUIBehavior
 * aggregateAcknowledgmentStackName2:]` and `...StackName3:` name `AcknowledgmentStack-2` and
 * `AcknowledgmentStack-3`, and `aggregateAcknowledgmentTranscriptBalloonSize` is {46, 40} on the
 * phone against {36, 36} for a single balloon, {35, 30} against {29, 29} on the Mac. Pulling those
 * renditions out of `ChatKit.framework/Resources/Assets.car` at both idioms and reading their alpha
 * shows what the extra width is: the frontmost balloon carries the glyph and one or two more sit
 * behind it, each shifted along the tail's direction, so only a crescent of each shows. Two
 * reactions draw one crescent, three or more draw two - there is no fourth asset and no number.
 *
 * The widest row of `AcknowledgmentStack-3` at 2x measures, in points: fill 1.00..34.00, gap to
 * 35.00, crescent to 37.00, gap to 38.00, crescent to 40.00. So the phone's artwork is a 33.0 ball
 * with a 1.0 gap and a 3.0 pitch, and the whole silhouette's ink runs 1.00..42.00 for -2 against
 * 1.00..45.00 for -3, which is the same 3.0 read a second way. The Mac's is a 25.0 ball with a 0.5
 * gap and a 2.5 pitch (ink 0.50..32.00 against 0.50..34.50). `AcknowledgmentStackBackground-*` is
 * the same silhouette 1.0 (phone) / 0.5 (Mac) larger on every side: the gaps are that rim showing
 * through between the balls, so one rim value draws both.
 *
 * Our balls are 34 and 28, measured off captures rather than off the artwork, so the pitch and gap
 * are scaled by 34/33 and 28/25 to keep the artwork's proportions against the ball we actually draw.
 */
export const aggregateStack: Record<Platform, { pitch: number; gap: number; max: number }> = {
  ios: { pitch: 3 * (34 / 33), gap: 1 * (34 / 33), max: 2 },
  macos: { pitch: 2.5 * (28 / 25), gap: 0.5 * (28 / 25), max: 2 },
};

/** The emoji-picker "thought bubble" beside a long-pressed message is the same shape at ~1.3x. */
export const pickerBalloonGeometry: BalloonGeometry = { main: 44, medium: 14.6, small: 8, mediumOffset: [-13.2, 20.3], smallOffset: [-22.2, 30.7], glyph: 24 };

/** Renders the trailing circles of a balloon; the parent is the main circle (position: relative). */
export function BalloonTrail({ geometry, side, color, ring }: { geometry: BalloonGeometry; side: "left" | "right"; color: string; /** The rim an aggregate stack needs, so the ball behind shows as a crescent beside this one too. */ ring?: string }) {
  const half = geometry.main / 2;
  const place = (d: number, [dx, dy]: [number, number]): CSSProperties => ({
    position: "absolute", width: d, height: d, borderRadius: "50%", background: color, top: half + dy - d / 2,
    [side === "left" ? "left" : "right"]: half + dx - d / 2, boxShadow: ring,
  });
  return (
    <>
      <span aria-hidden="true" data-slot="balloon-medium" style={place(geometry.medium, geometry.mediumOffset)} />
      <span aria-hidden="true" data-slot="balloon-small" style={place(geometry.small, geometry.smallOffset)} />
    </>
  );
}

const glossyText = (gradient: string): CSSProperties => ({ backgroundImage: gradient, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", WebkitTextFillColor: "transparent" });

/**
 * Heart ramps, sampled at matching heights on every capture. On a gray or white balloon Apple's heart
 * runs #ffc1d8 → #ff4796; on the blue own-reaction balloon (and on the blue selected disc in the bar)
 * the same artwork reads a constant 21/255 lighter in green and 20/255 in blue, so it keeps its
 * contrast. Positions are the radial offsets fitted to the Ø49.8 balloon in the details popover.
 */
const heartRamp = {
  plain: [["0", "#ffd9ea"], ["0.12", "#ffc1d8"], ["0.38", "#ff99ca"], ["0.51", "#ff81bd"], ["0.79", "#ff6cb0"], ["1", "#ff4796"]],
  onAccent: [["0", "#ffeefe"], ["0.12", "#ffd6ec"], ["0.38", "#ffaede"], ["0.51", "#ff96d1"], ["0.79", "#ff81c4"], ["1", "#ff5caa"]],
} as const;

/**
 * The six classic tapback glyphs and custom emoji, drawn to match Apple's artwork.
 * `size` is the glyph box: 25.33 in the iOS tapback bar, 18.34 in a Ø34 balloon.
 * `onAccent` picks the lighter artwork Apple uses on the blue balloon and the blue selected disc.
 */
export function TapbackGlyph({ type, emoji, size, onAccent = false, className, style }: { type?: TapbackType; emoji?: string; size: number; onAccent?: boolean; className?: string; style?: CSSProperties }) {
  const id = useId().replace(/:/g, "");
  const base: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1, userSelect: "none", ...style };
  if (emoji || !type) {
    return <span data-slot="tapback-glyph" data-glyph="emoji" className={className} style={{ ...base, fontSize: size, fontFamily: emojiFontStack, width: size, height: size }}>{emoji}</span>;
  }
  if (type === "love") {
    // Outline traced from `tapback-love-light.png` at 3x: ink 18.34 × 16.33 (ratio 0.8906), the two
    // lobes are r 4.75 circles centred (4.75, 4.91) and (13.25, 4.91) meeting in a notch at (9, 2.79),
    // and each flank is one cubic to the tip (rmse 0.03 against 15 sampled rows).
    const w = size, h = size * 0.8906;
    return (
      <svg data-slot="tapback-glyph" data-glyph="love" className={className} style={base} width={w} height={h} viewBox="0 0 18 16.03" aria-hidden="true">
        <defs>
          <radialGradient id={`${id}-h`} cx="0.5" cy="0.18" r="0.8">
            {(onAccent ? heartRamp.onAccent : heartRamp.plain).map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}
          </radialGradient>
        </defs>
        <path d="M9,16.03 C7.6,15.9 0,10.51 0,4.91 A4.75,4.75 0 0 1 9,2.79 A4.75,4.75 0 0 1 18,4.91 C18,10.51 10.4,15.9 9,16.03 Z" fill={`url(#${id}-h)`} />
      </svg>
    );
  }
  if (type === "like" || type === "dislike") {
    // The 👎 face sits 1.84 higher than native in a 25.33 slot; 👍 lands right. Push it back down.
    const drop = type === "dislike" ? size * 0.145 : 0;
    return <span data-slot="tapback-glyph" data-glyph={type} className={className} style={{ ...base, marginTop: (typeof base.marginTop === "number" ? base.marginTop : 0) + drop, fontSize: size * 0.987, fontFamily: emojiFontStack, width: size, height: size }}>{type === "like" ? "👍" : "👎"}</span>;
  }
  if (type === "laugh") {
    return (
      <span data-slot="tapback-glyph" data-glyph="laugh" className={className} style={{ ...base, flexDirection: "column", width: size, height: size, fontFamily: fontStack, fontWeight: 800, fontSize: size * 0.68, lineHeight: `${size * 0.5}px`, letterSpacing: -size * 0.02, ...glossyText("linear-gradient(#5fc9ff, #0aa6ff 55%, #0090f5)") }}>
        <span style={{ WebkitTextStroke: `${size * 0.02}px rgba(255,255,255,0.6)` }}>HA</span><span style={{ WebkitTextStroke: `${size * 0.02}px rgba(255,255,255,0.6)` }}>HA</span>
      </span>
    );
  }
  if (type === "emphasize") {
    const w = size * 0.71, h = size * 1.053;
    return (
      <svg data-slot="tapback-glyph" data-glyph="emphasize" className={className} style={base} width={w} height={h} viewBox="0 0 18 26.67" aria-hidden="true">
        <defs><linearGradient id={`${id}-e`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ff8c6e" /><stop offset="0.6" stopColor="#ff4f3f" /><stop offset="1" stopColor="#ff2a34" /></linearGradient></defs>
        {[0, 10].map(x => (
          <g key={x} transform={`translate(${x} 0)`}>
            <path d="M0.2,3.6 A3.8,3.8 0 0 1 7.8,3.6 L6.3,16.3 A2.3,2.3 0 0 1 1.7,16.3 Z" fill={`url(#${id}-e)`} />
            <circle cx="4" cy="23.1" r="3.5" fill={`url(#${id}-e)`} />
            <ellipse cx="3" cy="3.8" rx="1.3" ry="2" fill="#fff" opacity="0.45" />
          </g>
        ))}
      </svg>
    );
  }
  if (type === "question") {
    const w = size * 0.566, h = size * 0.987;
    return (
      <svg data-slot="tapback-glyph" data-glyph="question" className={className} style={base} width={w} height={h} viewBox="0 0 14.33 25" aria-hidden="true">
        <defs><linearGradient id={`${id}-q`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#c4a8ff" /><stop offset="0.6" stopColor="#9b7cf5" /><stop offset="1" stopColor="#7a5ee0" /></linearGradient></defs>
        <path d="M2.4,7.4 A4.9,4.9 0 1 1 8.1,12.1 C7.3,12.6 7.2,13.4 7.2,15.4" fill="none" stroke={`url(#${id}-q)`} strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="7.2" cy="22.4" r="2.5" fill={`url(#${id}-q)`} />
        <path d="M4.4,5.4 A3.2,3.2 0 0 1 7.6,3.6" fill="none" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
      </svg>
    );
  }
  return null;
}

export type TapbackProps = Omit<ComponentProps<"button">, "children" | "type"> & {
  reaction?: TapbackType;
  /** A custom emoji reaction instead of one of the six classics. */
  emoji?: string;
  /** Blue balloon (your own reaction) or the gray one for other people's. */
  own?: boolean;
  /** Which side of the bubble the balloon sits on; the trail points that way. Outgoing bubbles use "left". */
  side?: "left" | "right";
  selected?: boolean;
  count?: number;
  platform?: Platform;
  /** Extra content, e.g. a screen-reader description. */
  children?: ReactNode;
  /**
   * Pop the balloon in the way applying a Tapback does natively: it scales up past its size and
   * settles, the trailing circles riding the same scale. Off by default, because reactions that were
   * already on a message when the conversation opened do not animate; turn it on for one the person
   * just applied.
   */
  animateIn?: boolean;
  /** Scrub the entrance (0..1) instead of playing it. */
  appearProgress?: number;
};

/**
 * Timed on `references/macos/captures/tapback-apply-frames-100-123.png`, 24 consecutive 60 fps frames
 * (f100 = 1667 ms, 16.67 ms apart). The menu is still whole at f101 and has gone at f112, a 183 ms
 * dissolve (95%→5% in 134 ms). The balloon then appears at f118 = 1967 ms, 100 ms after the menu is
 * gone, in the same frame the list starts opening the slot. Its fill diameter over the settled Ø28
 * measures 0.19 (f118), 0.28 (f119), ≈0.52 (f120), ≈0.65 (f121), ≈0.75 (f122) and ≥0.80 (f123), so it
 * needs ≈110 ms to reach full size counting from the last empty frame. The small trailing circle
 * measures 0.49 / 0.64 / 0.71 / 0.81 across f120–f123, i.e. it rides the balloon's own scale with no
 * delay of its own — hence `trailDelay: 0` and no separate animation for the trail.
 *
 * The strip ends at f123 = 2050 ms with the balloon still growing, so the overshoot past 1 and the
 * settle after it are NOT in the capture: `duration` and the peak below are unverified.
 */
export const tapbackAppear = { duration: 420, growth: 110, trailDelay: 0 } as const;

export function Tapback({ reaction = "love", emoji, own = true, side = "left", selected = false, count, platform: platformProp, className, onClick, style, children, animateIn = false, appearProgress, ...props }: TapbackProps) {
  const contextPlatform = usePlatform();
  const host = useRef<HTMLSpanElement & HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !animateIn) return;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (reduced) return;
    // The trailing circles are children, so the one scale below carries them: the capture shows them
    // at the balloon's own scale in every frame, with no delay to animate separately.
    const grow = tapbackAppear.growth / tapbackAppear.duration;
    const balloon = element.animate(
      [
        { transform: "scale(0)", opacity: 0 },
        { offset: grow * 0.08, transform: "scale(0.12)", opacity: 1 },
        { offset: grow, transform: "scale(1)" },
        { offset: grow * 1.26, transform: "scale(1.14)" },
        { offset: 0.62, transform: "scale(0.94)" },
        { offset: 0.84, transform: "scale(1.03)" },
        { transform: "scale(1)" },
      ],
      { duration: tapbackAppear.duration, easing: "linear", fill: "both" },
    );
    if (appearProgress === undefined) balloon.play();
    else { balloon.pause(); balloon.currentTime = Math.max(0, Math.min(1, appearProgress)) * tapbackAppear.duration; }
    return () => balloon.cancel();
  }, [animateIn, appearProgress]);
  const platform = platformProp ?? contextPlatform;
  const g = balloonGeometry[platform];
  const fill = own ? "var(--im-tapback-own, #0088ff)" : "var(--im-tapback-theirs, #e9e9eb)";
  // macOS paints the main circle with the measured opacity ramp and knocks the artwork out of
  // whatever it laps with a 0.5 pt pane-coloured rim; the trailing circles stay flat and rimless.
  const surface = platform === "macos" && own ? `var(--im-tapback-own-surface, ${fill})` : fill;
  const rim = platform === "macos" ? `0 0 0 ${macosBalloonRim}px var(--im-bg, #fff)` : null;
  const ring = selected ? `0 0 0 ${platform === "ios" ? 2 : 1.5}px var(--im-bg, #fff), 0 0 0 ${platform === "ios" ? 4 : 3}px var(--im-tapback-ring, ${tapbackColors.selectedRing})` : null;
  // Reads on its own: "Love tapback, 2, from you" rather than a bare glyph name and a bracket.
  const label = `${emoji ?? tapbackLabels[reaction]} tapback${count !== undefined && count > 1 ? `, ${count}` : ""}${own ? ", from you" : ""}`;
  // See `aggregateStack`: extra reactions are crescents of the same balloon behind this one, capped
  // at two because ChatKit's artwork stops at `AcknowledgmentStack-3`.
  const a = aggregateStack[platform];
  const behind = Math.min(Math.max((count ?? 1) - 1, 0), a.max);
  // One rim, not two: the Mac already knocks a 0.51 pt pane rim out of what the ball laps, and the
  // stack's gap is 0.56, so the wider of the pair is the only one that shows.
  const gapRing = `0 0 0 ${Math.max(a.gap, platform === "macos" ? macosBalloonRim : 0)}px var(--im-bg, #fff)`;
  const rootStyle: CSSProperties = {
    position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box",
    width: g.main, minWidth: g.main, height: g.main, borderRadius: g.main / 2,
    // Stacked, the front ball is a layer of its own so the ones behind it can paint first; the root
    // would otherwise paint its background before any child and cover them.
    background: behind ? undefined : surface,
    gap: g.main * 0.12, fontFamily: fontStack,
    color: own ? "#fff" : "var(--im-incoming-text, #000)",
    // The selected ring uses the same token as the picker, so dark gets #0064d2 rather than #26aeff.
    boxShadow: behind ? ring ?? undefined : [rim, ring].filter(Boolean).join(", ") || undefined,
    ...style,
  };
  const ball = (index: number) => (
    <span key={index} aria-hidden="true" data-slot={index ? "balloon-behind" : "balloon-front"} style={{
      position: "absolute", width: g.main, height: g.main, borderRadius: "50%", background: surface, top: 0,
      [side === "left" ? "left" : "right"]: -index * a.pitch,
      boxShadow: gapRing,
    }}>
      <BalloonTrail geometry={g} side={side} color={fill} ring={gapRing} />
    </span>
  );
  const content = (
    <>
      {behind > 0 && Array.from({ length: behind }, (_, i) => ball(behind - i)).concat(ball(0))}
      {/* Positioned, because the stacked balls are and CSS paints every positioned descendant after
          the in-flow content however the DOM is ordered - without this the front ball covers the glyph. */}
      <TapbackGlyph type={emoji ? undefined : reaction} emoji={emoji} size={g.glyph} onAccent={own} style={{ position: "relative", marginTop: emoji ? 0 : 2 * (g.glyphOffsetY ?? 0) }} />
      {behind === 0 && <BalloonTrail geometry={g} side={side} color={fill} />}
      {children}
    </>
  );
  const shared = { "data-slot": "tapback", "data-reaction": emoji ? "emoji" : reaction, "data-own": own, "data-side": side, "data-platform": platform } as const;
  if (!onClick) return <span ref={host as RefObject<HTMLSpanElement>} role="img" aria-label={label} className={cn("select-none", className)} style={{ ...rootStyle, transformOrigin: side === "left" ? "85% 85%" : "15% 85%" }} {...shared}>{content}</span>;
  return (
    <button ref={host as RefObject<HTMLButtonElement>} type="button" aria-label={label} aria-pressed={selected} className={cn("cursor-pointer select-none border-0 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50", className)} style={{ ...rootStyle, transformOrigin: side === "left" ? "85% 85%" : "15% 85%" }} onClick={onClick} {...shared} {...props}>
      {content}
    </button>
  );
}
