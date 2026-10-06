"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * iOS 26 `+` menu and the embedded Photos picker, measured from
 * `references/ios/captures/plus-menu-open-light.png` and `photo-picker-light.png` (402×874 @3x).
 *
 * Sheet: x 8.67–331.33, y 371–831.67 (322.67 × 460.67), continuous corner ≈24. It is glass over the
 * conversation, which stays sharp outside the sheet: the screen is not dimmed, but the sheet does
 * cast a soft shadow (see `--ios-pm-shadow-alpha`). Rows are 66.5 apart, the first centred at y 425.83;
 * the Ø39 app icon is centred at x 63.17 and the label starts at x 108 (ink cap height 17.5, i.e.
 * ≈25pt). "Check In" is clipped by the sheet's bottom edge, which is how the capture shows it.
 *
 * Glass, refitted. The radius does matter, which an earlier note here denied: sweeping it and
 * measuring the horizontal-derivative std behind the sheet over x 210–320, y 400–690 gives 4.17 at
 * 10px, 4.20 at 14, 4.51 at 20, 5.13 at 30 and 5.91 at the 45 this used to carry, against the
 * capture's **4.26**. Detail *rises* past about 14px, so a bigger radius was making it worse, not
 * better - Chromium's wide-radius backdrop blur puts back more than it takes out.
 *
 * Radius and tint were then solved together: for each radius, render the sheet once with a black
 * tint and once with a white one - the result is linear in the tint - and least-squares the tint
 * that lands on the capture over every glass pixel in the sheet's right third, clear of the labels.
 * The best neutral answer is blur 20, alpha 0.72, tint 248, at rms 7.24 against the shipped
 * 45/0.62/255's 8.55.
 *
 * Letting the tint go per-channel reaches rms 4.9, but it comes out green (236, 252, 240), and the
 * only plus-menu capture there is sits over a thread of green bubbles. That is this scene's backdrop
 * leaking into the fit, so the neutral answer ships. A second capture of the sheet over a blue or
 * grey thread would settle whether the material really is tinted.
 *
 * Photos grid: three 129.67 square tiles per row with 1.33 gaps, x 5.33–396.67, first row top 485,
 * radius 12, with a 35 × 5 sheet grabber over the middle of the first row. Tiles here are solid
 * placeholders — the registry never ships photographs — so a raw diff of the grid against
 * `photo-picker-light.png` is comparing gradients with landscapes and says nothing about fidelity.
 *
 * ## Opening it
 *
 * Nothing in `references/` records this sheet in motion, so **no timing below is measured**. Both
 * ends are: at `progress` 0 the sheet *is* the composer's `+`, a Ø40 glass circle centred (48, 826)
 * with the composer's own 0.9 fill and 24 blur (all measured in `ios-composer.tsx`), and at 1 it is
 * the sheet measured above. In between the box grows between those two rectangles — a layout
 * interpolation, not a scale, so the rows never squash — its corner runs 20 → 24, its glass ramps to
 * the sheet's fill and 45 blur, its shadow fades up from nothing, and the rows fade and lift into
 * their settled places in a stagger. The composer's `+` fades out under the growing sheet.
 *
 * Durations are borrowed from the kit's measured neighbours, which is the whole of their authority.
 * The entrance is nine tenths of the way in about 200 ms and settled by 350, in the family of the
 * long-press menu's measured 380 ms open (`nativeMotion.longPressOpen` in `harness/scenarios.ts`);
 * the dismissal is back inside the `+` in about 200 ms, against that menu's measured 220 ms exit
 * (`messageActionsTiming.exit`). The row stagger copies the shape of the same menu's glyph stagger
 * (17 ms apart there) but its own numbers are a fit, not a measurement.
 *
 * Nothing behind the sheet dims. That is measured, and it is why there is no scrim to fade in:
 * `plus-menu-open-light.png` shows the conversation outside the sheet at full contrast, sharp to the
 * sheet's edge. The only backdrop that ramps is the sheet's own.
 *
 * Every animated value is a pure function of `progress`, so a seeked checkpoint renders the same
 * frame on every run. Leaving `progress` unset hands the sheet its own spring instead, which is the
 * live path and the only one that touches a clock; `prefers-reduced-motion` skips it to the end pose.
 */

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

/**
 * `box-shadow` takes a comma separated list and `none` is only legal on its own, so `<shadow>, none`
 * throws the whole declaration away. Both slots therefore always hold a real shadow and the unused
 * one is fully transparent. Every class below is written out in full: Tailwind only compiles class
 * names it can read literally in the source.
 *
 * The light shadow is fitted to `plus-menu-open-light.png`: beside the sheet the white page darkens
 * by 11/255, above it by 9/255, and it is back to #ffffff about 30 past either edge. Dark shows the
 * bright rim the other glass surfaces use instead of a shadow.
 *
 * The fill is a channel triple plus an alpha, and the shadow keeps only its alpha, because both are
 * interpolated while the sheet opens: the fill runs from the composer's glass to this one, the shadow
 * from nothing to this one. A theme still owns the colour; only the alpha is animated, in a `calc()`
 * the theme's own value feeds. The dark rim is the same one the composer's `+` already draws, so it
 * needs no ramp of its own.
 */
const vars =
  "[--ios-pm-label:#000000] [--ios-pm-glass:248_248_248] [--ios-pm-alpha:0.72] [--ios-pm-shadow-alpha:0.066] [--ios-pm-rim:0_0_0_0_rgba(0,0,0,0)] " +
  "dark:[--ios-pm-label:#f4f3f4] dark:[--ios-pm-glass:28_28_28] dark:[--ios-pm-alpha:0.72] dark:[--ios-pm-shadow-alpha:0] dark:[--ios-pm-rim:inset_0_0_0_1px_rgba(255,255,255,0.09)]";

/**
 * Where the sheet grows from, and how the parts of the entrance are spaced inside it.
 *
 * `button`, `buttonAlpha` and `buttonBlur` are measured (`ios-composer.tsx`); everything else is a
 * fit. The stagger is in units of the entrance's own progress rather than milliseconds so that a
 * seeked frame and a played frame are the same function of one scalar: at the entrance's rate the
 * 0.045 step between rows is roughly 25 ms, in the family of the long-press menu's measured 17.
 */
export const plusMenuMotion = {
  button: { centerX: 48, centerY: 826, size: 40 },
  buttonAlpha: 0.9,
  buttonBlur: 24,
  /** Nominal: Chromium renders every blur radius alike on this element (see the file comment). */
  sheetBlur: 20,
  sheetSaturate: 1.9,
  /** The sheet's glass takes over from the button's under it, before the box has grown enough to see. */
  glassFade: 0.12,
  /** A row fades and lifts through a rowSpan-long window, rowStagger apart, the bottom row first. */
  rowStart: 0.16,
  rowStagger: 0.045,
  rowSpan: 0.34,
  rowLift: 10,
  /** The `+` glyph is gone by the time the sheet has grown past the button it came out of. */
  attachFade: 0.3,
} as const;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
/** Straight lerp, except that a finished sub-animation returns `b` itself and not `a + (b - a)`. */
const lerp = (a: number, b: number, u: number) => (u >= 1 ? b : a + (b - a) * u);
/** Quadratic ease-out, the shape the kit's short fades use. */
const easeOut = (u: number) => 1 - (1 - u) * (1 - u);

/** Apple's continuous corner. Browsers without `corner-shape` fall back to a plain round corner. */
const continuous = { cornerShape: "superellipse(1.14)" } as CSSProperties;

export type PlusMenuIcon =
  | "camera" | "photos" | "stickers" | "cash" | "audio" | "images" | "checkin"
  | "location" | "polls" | "genmoji" | "playground" | "music" | "sendlater" | "store";

export type PlusMenuItem = {
  id: string;
  label: string;
  icon: PlusMenuIcon;
  /** Overrides the row's Ø39 artwork box. See `defaultPlusMenuItems` for the one row that needs it. */
  iconSize?: number;
  iconCenterX?: number;
  onSelect?: () => void;
};

/**
 * The menu does not stop at "Check In" — the capture only reaches there because the sheet cuts the
 * seventh row off, and now that the list scrolls the rows below it have somewhere to go.
 *
 * What belongs there is not a guess. ChatKit ships one artwork per send-menu row, and the full set
 * in `Assets.car` is app-store, audio, camera, check-in, digital-touch, generative-playground,
 * genmoji, hashtag-images, location, memoji, music, pay, photos, polls, send-later, stickers and
 * tap-to-radar; `ChatKit.loctable` carries the matching `SEND_MENU_ITEM_TITLE_*` strings, which is
 * where these labels come from, spelling and all — "Apple Cash" really does carry a non-breaking
 * space in the framework. Seven of that set are already above. Memoji and Digital Touch are left out
 * because their artwork is a face and a pair of hands that a redraw would only caricature, and
 * tap-to-radar is Apple's internal bug reporter.
 *
 * **UNMEASURED: the order.** `plus-menu-open-light.png` pins the first seven rows and nothing below,
 * so the order here is only the one the framework's own asset names sort into. The row *geometry* is
 * the measured 66.5 pitch either way.
 */
export const plusMenuRest: PlusMenuItem[] = [
  { id: "location", label: "Location", icon: "location" },
  { id: "polls", label: "Polls", icon: "polls" },
  { id: "genmoji", label: "Genmoji", icon: "genmoji" },
  { id: "playground", label: "Playground", icon: "playground" },
  { id: "music", label: "Music", icon: "music" },
  { id: "sendlater", label: "Send Later", icon: "sendlater" },
  { id: "store", label: "Store", icon: "store" },
];

/**
 * Apple Cash is the one row whose artwork is not the shared Ø39 disc: in
 * `plus-menu-open-light.png` its black disc measures 35.0 across (x 49.33–84.33 on the row's
 * centre line, y 607.67–642.67), so it is both smaller and 3.67 further right than the Audio and
 * #images discs, which both land on the documented 43.67–82.67.
 */
export const defaultPlusMenuItems: PlusMenuItem[] = [
  { id: "camera", label: "Camera", icon: "camera" },
  { id: "photos", label: "Photos", icon: "photos" },
  { id: "stickers", label: "Stickers", icon: "stickers" },
  { id: "cash", label: "Apple Cash", icon: "cash", iconSize: 35, iconCenterX: 66.8333 },
  { id: "audio", label: "Audio", icon: "audio" },
  { id: "images", label: "#images", icon: "images" },
  { id: "checkin", label: "Check In", icon: "checkin" },
  ...plusMenuRest,
];


/**
 * Sheet geometry, in points, read off the capture.
 *
 * `labelMaxWidth` is iOS shrink-to-fit. Six of the seven labels measure the same in the capture as
 * they do here at 24pt; "Apple Cash", the only one wider than 107.9, is drawn at 0.904 of that size
 * (its ink runs 108.0–214.33 rather than the 117.67 the full size needs, and its cap height is
 * 16.0 against 17.67 on "Camera"). Anything at or under the column keeps the full 24.
 */
export const plusMenuMetrics = {
  left: 8.6667, top: 371, width: 322.6667, height: 460.6667, radius: 24,
  rowPitch: 66.5, firstRowCenter: 425.8333, iconSize: 39, iconCenterX: 63.1667, labelX: 108, labelSize: 24,
  labelMaxWidth: 107.9,
  /**
   * **UNMEASURED.** `plus-menu-open-light.png` has no row under a finger in it, exactly as
   * `context-menu`'s own note says of the long-press menu. Rather than invent a second shape, these
   * are that menu's iOS numbers scaled to this sheet's row: the inset by the width ratio
   * (5 x 322.67/250), the vertical inset and the corner by the height ratio (1 and 10 x 66.5/42).
   * The colour is the same `--im-menu-highlight` token, so the two menus cannot drift apart.
   */
  highlightInset: 6.4533, highlightInsetY: 1.5833, highlightRadius: 15.8333,
} as const;

/**
 * Photos-picker geometry, in points, read off `photo-picker-light.png`: three 129.67 tiles per row
 * with 1.33 gaps (x 5.33–396.67, first row top 485, radius 12) under a sheet grabber whose bar
 * measures 35.0 × 5.0 with its top 4.87 below the grid and its centre on x 201.
 *
 * The grabber's colour cannot be measured: it sits on a photograph, and beside it that photograph
 * reads (197,190,223) while under it it reads (137,133,167) — a drop of 60/57/56, which no single
 * translucent fill reproduces on all three channels. 30% black (and 30% white in dark) is the
 * system value that lands closest, and it is a fit, not a measurement.
 */
export const photoPickerMetrics = {
  tileSize: 129.6667, gap: 1.3333, radius: 12,
  grabberWidth: 35, grabberHeight: 5, grabberTop: 4.8333,
} as const;

/**
 * Spring toward `target`, and the only clock in this file. It starts at 0 when it is enabled, so a
 * sheet mounted open plays its entrance instead of appearing settled.
 *
 * Opening is ζ 0.86, ω 15 rad/s: measured off the running component, 0.90 at 200 ms and settled by
 * 350. Closing is stiffer, ζ 1, ω 24, which is back inside the `+` in about 200 ms. Both were chosen
 * to land in the family of the long-press menu's measured 380 ms open and 220 ms exit, and that is
 * the whole of their provenance: no capture in this repo records this sheet moving.
 *
 * `onSettled` fires when the spring reaches the target, which is what lets a caller unmount the sheet
 * after it has folded back into the `+`. A spring that starts already on its target never ran, so it
 * never reports. `prefers-reduced-motion` jumps to the target and reports on the next frame.
 */
export function usePlusMenuSpring(target: number, enabled: boolean, onSettled?: () => void) {
  const [value, setValue] = useState(enabled ? 0 : target);
  const state = useRef({ value: enabled ? 0 : target, velocity: 0, raf: 0, last: 0 });
  const settled = useRef(onSettled);
  useEffect(() => { settled.current = onSettled; });
  useEffect(() => {
    if (!enabled) return;
    const s = state.current;
    const rest = Math.abs(target - s.value) < 0.0005 && Math.abs(s.velocity) < 0.005;
    const finish = () => { s.value = target; s.velocity = 0; s.raf = 0; setValue(target); settled.current?.(); };
    if (rest) { s.value = target; s.velocity = 0; return; }
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      s.raf = requestAnimationFrame(finish);
      return () => { cancelAnimationFrame(s.raf); s.raf = 0; };
    }
    // Chosen once, from the direction this run travels: a dismissal that interrupts an entrance takes
    // the stiffer spring from wherever the entrance had got to, so it never has to rewind slowly.
    const closing = target < s.value;
    const omega = closing ? 24 : 15;
    const zeta = closing ? 1 : 0.86;
    s.last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.032, (now - s.last) / 1000);
      s.last = now;
      s.velocity += (omega * omega * (target - s.value) - 2 * zeta * omega * s.velocity) * dt;
      s.value += s.velocity * dt;
      if (Math.abs(target - s.value) < 0.0005 && Math.abs(s.velocity) < 0.005) { finish(); return; }
      setValue(s.value);
      s.raf = requestAnimationFrame(step);
    };
    s.raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(s.raf); s.raf = 0; };
  }, [target, enabled]);
  return enabled ? value : target;
}

/**
 * The seven app glyphs, traced from the capture: a silver camera lens, the Photos flower, a peeling
 * sticker, the Apple Cash disc, an audio waveform, the #images magnifier, and the Check In tick.
 * They are approximations of Apple's artwork, drawn at the measured Ø39 and colour-sampled from the
 * frame, not copies of the shipped icons.
 */
function AppIcon({ icon, size = plusMenuMetrics.iconSize }: { icon: PlusMenuIcon; size?: number }) {
  // Gradient ids are per instance: two mounted menus would otherwise share one id and one `defs`.
  const id = useId();
  const s = size;
  const common = { width: s, height: s, viewBox: "0 0 39 39" } as const;
  // The seven the capture holds are below; the rest of ChatKit's send-menu artwork lives in
  // `AppIconRest` so this function does not run to a thousand lines.
  if (icon === "location" || icon === "sendlater" || icon === "polls" || icon === "store"
    || icon === "music" || icon === "playground" || icon === "genmoji") {
    return <AppIconRest icon={icon} id={id} common={common} />;
  }
  if (icon === "camera") {
    return (
      <svg aria-hidden="true" {...common}>
        <defs>
          <linearGradient id={`${id}-cam`} x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stopColor="#eeeeee" /><stop offset="0.5" stopColor="#b6b6b6" /><stop offset="1" stopColor="#8f8f8f" /></linearGradient>
          <radialGradient id={`${id}-lens`} cx="0.38" cy="0.32" r="0.75"><stop offset="0" stopColor="#4a6fa8" /><stop offset="0.45" stopColor="#141b2c" /><stop offset="1" stopColor="#05070d" /></radialGradient>
        </defs>
        <circle cx="19.5" cy="19.5" r="19.5" fill={`url(#${id}-cam)`} />
        <circle cx="19.5" cy="19.5" r="13.4" fill="#333333" />
        <circle cx="19.5" cy="19.5" r="8.6" fill={`url(#${id}-lens)`} />
        <ellipse cx="17.6" cy="16.6" rx="2.2" ry="3.4" fill="#e8f1ff" transform="rotate(-38 17.6 16.6)" />
        <ellipse cx="21.3" cy="22.6" rx="1.2" ry="2.4" fill="#7fc0ff" opacity="0.75" transform="rotate(-38 21.3 22.6)" />
      </svg>
    );
  }
  if (icon === "photos") {
    const petals = ["#f7c942", "#f4842f", "#ef4b57", "#d3479f", "#8c5ad4", "#3f8ae0", "#43b8c6", "#77c34a"];
    return (
      <svg aria-hidden="true" {...common}>
        <circle cx="19.5" cy="19.5" r="19.5" fill="#fdfdfd" />
        <g style={{ mixBlendMode: "multiply" }} opacity="0.82">
          {petals.map((c, i) => (
            <ellipse key={c} cx="19.5" cy="12.4" rx="5.0" ry="7.4" fill={c} transform={`rotate(${i * 45} 19.5 19.5)`} />
          ))}
        </g>
      </svg>
    );
  }
  if (icon === "stickers") {
    return (
      <svg aria-hidden="true" {...common}>
        <defs>
          <linearGradient id={`${id}-stk`} x1="0.1" y1="1" x2="0.9" y2="0"><stop offset="0" stopColor="#5b93ef" /><stop offset="1" stopColor="#c3b4f6" /></linearGradient>
          <linearGradient id={`${id}-curl`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#efeaff" /><stop offset="1" stopColor="#b9aef1" /></linearGradient>
        </defs>
        {/* body: a disc whose top-right corner has peeled away */}
        <path d="M19.5 0A19.5 19.5 0 1 0 39 19.5c0-1.5-.2-3-.5-4.4-7 6.6-14 4.5-17.6.8S16.6 6 24.4.8A19.4 19.4 0 0 0 19.5 0Z" fill={`url(#${id}-stk)`} />
        <path d="M24.4.8C16.6 6 17.3 12.2 20.9 15.9s10.6 5.8 17.6-.8A19.6 19.6 0 0 0 24.4.8Z" fill={`url(#${id}-curl)`} />
      </svg>
    );
  }
  if (icon === "cash") {
    return (
      <svg aria-hidden="true" {...common}>
        <defs><linearGradient id={`${id}-cash`} x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="0.55" stopColor="#dcdcdc" /><stop offset="1" stopColor="#f4f4f4" /></linearGradient></defs>
        <circle cx="19.5" cy="19.5" r="19.5" fill="#1a1a1a" />
        <text x="19.5" y="30.4" textAnchor="middle" fill={`url(#${id}-cash)`} style={{ fontFamily: font, fontSize: 30, fontWeight: 600 }}>$</text>
      </svg>
    );
  }
  if (icon === "audio") {
    const bars = [5.2, 9.4, 13.4, 17.6, 13.4, 9.4, 5.2];
    return (
      <svg aria-hidden="true" {...common}>
        <defs><linearGradient id={`${id}-aud`} x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stopColor="#ff9a63" /><stop offset="1" stopColor="#f4593c" /></linearGradient></defs>
        <circle cx="19.5" cy="19.5" r="19.5" fill={`url(#${id}-aud)`} />
        {bars.map((h, i) => (
          <rect key={i} x={19.5 + (i - 3) * 3.6 - 1.05} y={19.5 - h / 2} width="2.1" height={h} rx="1.05" fill="#ffffff" />
        ))}
      </svg>
    );
  }
  if (icon === "images") {
    return (
      <svg aria-hidden="true" {...common}>
        <defs><linearGradient id={`${id}-img`} x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stopColor="#ff5f86" /><stop offset="1" stopColor="#ec1f52" /></linearGradient></defs>
        <circle cx="19.5" cy="19.5" r="19.5" fill={`url(#${id}-img)`} />
        <g fill="none" stroke="#ffffff" strokeWidth="1.5">
          <circle cx="17.6" cy="17.4" r="7.6" />
          <path d="M10 17.4h15.2M17.6 9.8c3.2 4.6 3.2 10.6 0 15.2M17.6 9.8c-3.2 4.6-3.2 10.6 0 15.2" strokeWidth="1.15" />
          <path d="M23.2 23 29.4 29.2" strokeWidth="2.6" strokeLinecap="round" />
        </g>
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" {...common}>
      <circle cx="19.5" cy="19.5" r="19.5" fill="#ffd42e" />
      <path d="M12.2 20.4 17.3 25.5 28.2 12.4" fill="none" stroke="#3a2a06" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The rest of the send menu, redrawn from ChatKit's own artwork rather than from a capture — see
 * `plusMenuRest` for why they are here at all. Every rendition is `send-menu-<name>-glass` in
 * `ChatKit.framework/Resources/Assets.car`, pulled at the phone idiom, and each is a Ø39 disc inside
 * a 54 box (ink 7.5–46.5 both ways), which is the same 39 `plusMenuMetrics.iconSize` already carries.
 *
 * Colours and radii are read off those PNGs at 2x, averaging 36 angles per radius so a glyph cannot
 * bias a ring:
 *
 * - **Location**: green field, flat #5ce58c from r 10.5 out, running #30e7a6 at the top of r 18 to
 *   #82df6c at the bottom. A near-white ring (#e9faef) fills r 6.0–9.6 and a #2490fc dot fills r 6.
 * - **Send Later**: no disc at all. A #2ec0fe clock face fills r 11.5 with its hands cut out of it
 *   (the radial average climbs 0.14 → 1.0 alpha from r 1 to r 8, which is the hands' angular share
 *   shrinking), and a dashed ring of the same blue sits at r 16.5–19.5.
 * - **Polls**: amber, flat #ffb72a, #ffae01 to #ffbb4f down the same r 18.
 * - **Store**: blue, flat #1d8df4, #22b3f8 to #1662ee.
 * - **Music**: #ff4d6f to #fe002a.
 * - **Playground**: #313131 to #0f0f0f.
 * - **Genmoji**: no flat field — #f77449 at the top of r 18, #f862c0 at the right, #27b5fb at the
 *   bottom and #eabe8a at the left, i.e. a hue sweep, so it is drawn as one.
 *
 * The glyphs themselves are redrawn, not traced: these are Apple's app icons and the kit ships its
 * own hand-drawn stand-ins for the seven that were already here for the same reason.
 */
function AppIconRest({ icon, id, common }: { icon: PlusMenuIcon; id: string; common: { width: number; height: number; viewBox: string } }) {
  if (icon === "location") {
    return (
      <svg aria-hidden="true" {...common}>
        <defs><linearGradient id={`${id}-loc`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#30e7a6" /><stop offset="1" stopColor="#82df6c" /></linearGradient></defs>
        <circle cx="19.5" cy="19.5" r="19.5" fill={`url(#${id}-loc)`} />
        <circle cx="19.5" cy="19.5" r="9.6" fill="#e9faef" />
        <circle cx="19.5" cy="19.5" r="6" fill="#2490fc" />
      </svg>
    );
  }
  if (icon === "sendlater") {
    return (
      <svg aria-hidden="true" {...common}>
        {/* The ring's 22 dashes are a count, not a measurement: the radial average only says the ring
            is dashed and where it sits. */}
        <circle cx="19.5" cy="19.5" r="18" fill="none" stroke="#2ec0fe" strokeWidth="3" strokeDasharray="2.6 2.6" strokeLinecap="round" />
        <circle cx="19.5" cy="19.5" r="11.5" fill="#2ec0fe" />
        <path d="M19.5 11.6V19.5H26" fill="none" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === "polls") {
    return (
      <svg aria-hidden="true" {...common}>
        <defs><linearGradient id={`${id}-poll`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffae01" /><stop offset="1" stopColor="#ffbb4f" /></linearGradient></defs>
        <circle cx="19.5" cy="19.5" r="19.5" fill={`url(#${id}-poll)`} />
        <g fill="#ffffff">
          <rect x="9.4" y="11.6" width="20.2" height="4.2" rx="2.1" />
          <rect x="9.4" y="17.4" width="14.6" height="4.2" rx="2.1" />
          <rect x="9.4" y="23.2" width="9.4" height="4.2" rx="2.1" />
        </g>
      </svg>
    );
  }
  if (icon === "store") {
    return (
      <svg aria-hidden="true" {...common}>
        <defs><linearGradient id={`${id}-st`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#22b3f8" /><stop offset="1" stopColor="#1662ee" /></linearGradient></defs>
        <circle cx="19.5" cy="19.5" r="19.5" fill={`url(#${id}-st)`} />
        {/* The App Store's "A": two legs, the crossbar, and the short stroke that overshoots left. */}
        <g fill="none" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13.1 27.6 21.4 13.2" />
          <path d="M25.9 27.6 17.6 13.2" />
          <path d="M10.4 22.7H26.6" />
          <path d="M15.6 27.6H10.9" />
        </g>
      </svg>
    );
  }
  if (icon === "music") {
    return (
      <svg aria-hidden="true" {...common}>
        <defs><linearGradient id={`${id}-mu`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ff4d6f" /><stop offset="1" stopColor="#fe002a" /></linearGradient></defs>
        <circle cx="19.5" cy="19.5" r="19.5" fill={`url(#${id}-mu)`} />
        <g fill="#ffffff">
          <path d="M16.4 12.9 27.4 10.5v3.6l-11 2.4z" />
          <rect x="15" y="13.6" width="1.9" height="11.6" rx="0.95" />
          <rect x="25.9" y="11.2" width="1.9" height="11" rx="0.95" />
          <ellipse cx="13" cy="25.6" rx="4" ry="3.2" />
          <ellipse cx="23.9" cy="22.6" rx="4" ry="3.2" />
        </g>
      </svg>
    );
  }
  if (icon === "playground") {
    return (
      <svg aria-hidden="true" {...common}>
        <defs>
          <linearGradient id={`${id}-pg`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#313131" /><stop offset="1" stopColor="#0f0f0f" /></linearGradient>
          <linearGradient id={`${id}-orb`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff6f4d" /><stop offset="0.35" stopColor="#f45fd0" />
            <stop offset="0.7" stopColor="#6f7bff" /><stop offset="1" stopColor="#3ec6ff" />
          </linearGradient>
        </defs>
        <circle cx="19.5" cy="19.5" r="19.5" fill={`url(#${id}-pg)`} />
        <g fill="none" stroke={`url(#${id}-orb)`} strokeWidth="1.9">
          <ellipse cx="19.5" cy="19.5" rx="10.4" ry="4.6" />
          <ellipse cx="19.5" cy="19.5" rx="10.4" ry="4.6" transform="rotate(60 19.5 19.5)" />
          <ellipse cx="19.5" cy="19.5" rx="10.4" ry="4.6" transform="rotate(120 19.5 19.5)" />
        </g>
        <circle cx="19.5" cy="19.5" r="3.1" fill={`url(#${id}-orb)`} />
      </svg>
    );
  }
  // genmoji
  return (
    <svg aria-hidden="true" {...common}>
      <defs>
        <linearGradient id={`${id}-gm`} x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0" stopColor="#f77449" /><stop offset="0.5" stopColor="#f862c0" /><stop offset="1" stopColor="#27b5fb" />
        </linearGradient>
        <linearGradient id={`${id}-gm2`} x1="0" y1="0.5" x2="1" y2="0.5">
          <stop offset="0" stopColor="#eabe8a" stopOpacity="0.85" /><stop offset="0.55" stopColor="#ffffff" stopOpacity="0" /><stop offset="1" stopColor="#f862c0" stopOpacity="0.85" />
        </linearGradient>
      </defs>
      <circle cx="19.5" cy="19.5" r="19.5" fill={`url(#${id}-gm)`} />
      <circle cx="19.5" cy="19.5" r="19.5" fill={`url(#${id}-gm2)`} />
      <g fill="none" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round">
        <circle cx="18.1" cy="19.9" r="9.3" />
        <path d="M13.9 22.6a5.6 5.6 0 0 0 8.4 0" />
      </g>
      <g fill="#ffffff">
        <circle cx="14.8" cy="17.2" r="1.5" />
        <circle cx="21.4" cy="17.2" r="1.5" />
      </g>
      <g stroke="#ffffff" strokeWidth="2" strokeLinecap="round">
        <path d="M29.2 8.6v5.2M26.6 11.2h5.2" />
      </g>
    </svg>
  );
}

/**
 * A row label, shrunk to fit `labelMaxWidth` the way iOS shrinks one. The font size is what changes,
 * not a transform: the line box keeps its 66.5 pitch, so a smaller face grows its own half-leading
 * by exactly as much as its ascent loses and the cap stays centred on the row (checked against both
 * "Camera" at 24 and "Apple Cash" at 21.7 in `plus-menu-open-light.png`).
 */
function RowLabel({ label }: { label: string }) {
  const m = plusMenuMetrics;
  const ref = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState<number>(m.labelSize);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      // The used width, not `getBoundingClientRect`: a row carries a lift and a fade while the sheet
      // opens, and a rect would report the label mid-animation and re-fit it on every frame. Advance
      // widths scale with the size and the tracking is zero, so one measurement at whatever size is
      // currently applied recovers the natural width, and re-running is idempotent.
      const style = getComputedStyle(el);
      const applied = Number.parseFloat(style.fontSize) || m.labelSize;
      const natural = (Number.parseFloat(style.width) * m.labelSize) / applied;
      if (!Number.isFinite(natural) || natural <= 0) return;
      setFontSize(natural > m.labelMaxWidth ? (m.labelSize * m.labelMaxWidth) / natural : m.labelSize);
    };
    fit();
    document.fonts?.ready.then(fit).catch(() => {});
  }, [label, m.labelMaxWidth, m.labelSize]);
  return (
    <span ref={ref} data-slot="label" className="absolute whitespace-nowrap"
      style={{ left: m.labelX - m.left, top: 0, lineHeight: `${m.rowPitch}px`, fontSize, letterSpacing: 0, transform: "translateY(-0.6667px)", color: "var(--ios-pm-label)" }}>
      {label}
    </span>
  );
}

export type IosPlusMenuProps = Omit<ComponentProps<"div">, "children"> & {
  items?: PlusMenuItem[];
  /**
   * 0 = the sheet is still the composer's `+`, 1 = settled. Leave unset to play `open` on a spring;
   * pass it to seek the entrance instead, which is what the harness does.
   */
  progress?: number;
  open?: boolean;
  /**
   * Fires once a dismissal has folded the sheet back into the `+`, so the caller can unmount it. The
   * caller keeps the sheet mounted until then, exactly as `ios-messages-app.tsx` keeps the effects
   * screen mounted after its own prop has cleared.
   */
  onExited?: () => void;
  /**
   * The composer row. Rendered under the sheet with its `+` faded out, as the capture shows. A menu
   * handed to `IosMessagesApp` as an `overlay` leaves this unset: that shell draws its own composer,
   * and the `+` in it fades all the same.
   */
  composer?: ReactNode;
  /** Called by Escape, by the close control over the `+`, and by a tap anywhere outside the sheet. */
  onDismiss?: () => void;
};

export function IosPlusMenu({ items = defaultPlusMenuItems, progress, open = true, onExited, composer, onDismiss, className, style, ...props }: IosPlusMenuProps) {
  const m = plusMenuMetrics;
  const mo = plusMenuMotion;
  const id = useId();

  // The sheet outlives the `open` prop so the dismissal has frames to run in, and `closing` is
  // derived during render rather than in an effect: an effect leaves one committed frame with the
  // sheet already gone and the exit never runs. Same rule as `ios-messages-app.tsx`.
  const [seenOpen, setSeenOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  if (seenOpen !== open) {
    setSeenOpen(open);
    setClosing(!open);
  }

  const exited = useRef(onExited);
  useEffect(() => { exited.current = onExited; });
  // Read by the spring when it settles, which happens a frame after this render has committed.
  const openNow = useRef(open);
  useEffect(() => { openNow.current = open; }, [open]);
  const onSettled = useCallback(() => {
    // A spring that settles on 1 has just opened; only the one that lands back on the `+` reports.
    if (openNow.current) return;
    exited.current?.();
  }, []);

  const spring = usePlusMenuSpring(open ? 1 : 0, progress === undefined, onSettled);
  const t = progress === undefined ? spring : clamp01(progress);
  const sheet = useRef<HTMLDivElement>(null);
  // One tab stop for the sheet; the arrow keys walk the rows, as a menu does.
  const [focusIndex, setFocusIndex] = useState(0);
  const [pressed, setPressed] = useState<string | null>(null);

  // A seeked dismissal has no spring to report it: the caller owns the clock, so it is over when the
  // sheet reads 0 and is back inside the `+`. Reported once, and from a ref rather than state, so
  // finishing an exit never schedules a render of its own.
  const reported = useRef(false);
  useEffect(() => {
    if (progress === undefined || !closing || t > 0) { reported.current = false; return; }
    if (reported.current) return;
    reported.current = true;
    exited.current?.();
  }, [progress, closing, t]);

  // Escape closes it, so the sheet never depends on a tap outside to get out of the way.
  useEffect(() => {
    if (!open || !onDismiss) return;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onDismiss(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  /**
   * The sheet takes the focus when it opens, not its first row.
   *
   * Two things are wrong with leaving it where it was. The row that opened this menu is the
   * composer's `+`, and the keyboard sits on it behind an open menu: measured with a held touch,
   * the focus was on `body` and every arrow key did nothing, so the menu was unreachable without
   * Tab. And a row focused programmatically while the finger that opened the menu is still down
   * matches `:focus-visible` in Chrome and WebKit alike - the gesture has not resolved, so the
   * modality is still the keyboard default - and paints a ring on a menu opened by touch. The
   * container takes no ring because it carries `outline-none`, `onKeyDown` below is on this element
   * so every key still arrives, and the first arrow moves to a row, where a ring is right because
   * by then the person really is on the keyboard. See `tapback-bar.tsx` and `macos-plus-menu.tsx`.
   *
   * Latched, and gated on `t`: the sheet is `visibility: hidden` until the spring leaves 0, and
   * focusing a hidden element is a no-op. A scrubbed entrance never focuses at all - the harness
   * seeks frames, it does not open menus.
   */
  const focused = useRef(false);
  useEffect(() => {
    if (!open) { focused.current = false; return; }
    if (progress !== undefined || focused.current || t <= 0) return;
    focused.current = true;
    sheet.current?.focus({ preventScroll: true });
  }, [open, progress, t]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = Array.from(sheet.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (!rows.length) return;
    event.preventDefault();
    // -1 while the focus is still on the sheet itself, which is where it starts: Down has to reach
    // the first row and Up the last. Wrapping arithmetic on `focusIndex` reaches neither - it would
    // step off row 0 to row 1 and skip the row the eye starts on.
    const from = rows.indexOf(document.activeElement as HTMLButtonElement);
    const last = rows.length - 1;
    const next = event.key === "Home" ? 0
      : event.key === "End" ? last
      : from < 0 ? (event.key === "ArrowDown" ? 0 : last)
      : event.key === "ArrowDown" ? (from + 1) % rows.length
      : (from - 1 + rows.length) % rows.length;
    setFocusIndex(next);
    rows[next]?.focus();
  }

  // The box the sheet grows out of: the composer's Ø40 `+`, in the same screen points the sheet uses.
  const from = mo.button;
  const fromLeft = from.centerX - from.size / 2;
  const fromTop = from.centerY - from.size / 2;
  const box = {
    left: lerp(fromLeft, m.left, t),
    top: lerp(fromTop, m.top, t),
    width: lerp(from.size, m.width, t),
    height: lerp(from.size, m.height, t),
    radius: lerp(from.size / 2, m.radius, t),
  };
  // The sheet's fill takes over from the `+`'s while the two shapes still coincide, so the handover
  // between the two measured glasses is never visible as a change of colour. The blur and the shadow
  // ramp over the whole entrance instead: both reach past the box and both are what makes it read as
  // a sheet rather than a white card.
  const glass = easeOut(clamp01(t / mo.glassFade));
  const attach = easeOut(clamp01(t / mo.attachFade));
  const filter = `blur(${lerp(mo.buttonBlur, mo.sheetBlur, t).toFixed(2)}px) saturate(${lerp(1, mo.sheetSaturate, t).toFixed(2)})`;
  // Where the first row's box starts inside the sheet, so the scroller can begin there and the rows
  // inside it can be laid out from zero.
  const rowsTop = m.firstRowCenter - m.rowPitch / 2 - m.top;
  // Hover does not exist on a phone and `:focus-visible` stays off for a pointer, so a finger on a
  // row would light nothing at all. `:active` is not the answer either: it depends on the engine's
  // own gesture arbitration and does not fire for a dispatched touch, which makes it untestable
  // here. So the press is state, the way `ios-conversation-list` holds its row highlight, and the
  // pointer events that end it include `pointercancel` - the one a scroll of this list sends.
  const highlightStyle = `[data-slot="item"] > [data-slot="item-highlight"]{opacity:0;transition:opacity 60ms linear}
[data-slot="item"]:hover > [data-slot="item-highlight"],[data-slot="item"]:focus-visible > [data-slot="item-highlight"],[data-slot="item"][data-pressed="true"] > [data-slot="item-highlight"]{opacity:1}`;
  const alive = t > 0 || open;

  return (
    <div data-slot="ios-plus-menu" data-plus-menu={id} data-progress={t.toFixed(3)}
      data-state={open ? "open" : t > 0 ? "closing" : "closed"}
      className={cn("absolute inset-0 z-20 select-none", vars, className)}
      style={{ fontFamily: font, pointerEvents: "none", ...style }} {...props}>
      {/* The `+` fades out under the sheet growing over it. Two rules, not one selector list: the
          composer is inside this menu when a caller passes it to `composer`, and a sibling under the
          app frame when the menu is handed to `IosMessagesApp` as an overlay. An unsupported `:has()`
          would take a whole selector list down with it, so the reachable case stands on its own. */}
      <style>{`[data-plus-menu="${id}"] [data-slot="attach"]{opacity:${(1 - attach).toFixed(3)};transform:scale(${(1 - 0.35 * attach).toFixed(3)})}
[data-slot="ios-messages-app"]:has([data-plus-menu="${id}"]) [data-slot="attach"]{opacity:${(1 - attach).toFixed(3)};transform:scale(${(1 - 0.35 * attach).toFixed(3)})}`}</style>
      {composer !== undefined && <div data-slot="composer-slot" className="pointer-events-auto absolute bottom-0 left-0 w-full">{composer}</div>}
      {/* A scrim, not a control: it is invisible, it fills the screen, and both Escape and the close
          control below do the same job, so it stays out of the tab order and the accessibility tree. */}
      {alive && <div aria-hidden="true" data-slot="dismiss" onClick={onDismiss} className="pointer-events-auto absolute inset-0 cursor-default" />}
      {/* The control that opened the sheet closes it again. It paints nothing: the `+` it stands on is
          the composer's own, faded out above, and the capture shows no other control while the sheet
          is open. The sheet covers its top once it has grown, which is why it is drawn under it. */}
      {alive && onDismiss && (
        <button type="button" data-slot="close" aria-label="Close attachments" onClick={onDismiss}
          className="pointer-events-auto absolute cursor-default bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]"
          style={{ left: fromLeft, top: fromTop, width: from.size, height: from.size, borderRadius: from.size / 2 }} />
      )}
      {/* `tabIndex={-1}` so the sheet can hold the focus without joining the tab order, and
          `outline-none` because it is a focus holder rather than a control: it must paint nothing
          even on the frame where `:focus-visible` matches it. */}
      <div ref={sheet} data-slot="sheet" role="menu" aria-label="Attachments" tabIndex={-1} onKeyDown={onKeyDown} className="absolute overflow-hidden outline-none"
        style={{
          left: box.left, top: box.top, width: box.width, height: box.height, borderRadius: box.radius, ...continuous,
          background: `rgb(var(--ios-pm-glass) / calc(${(1 - glass).toFixed(4)} * ${mo.buttonAlpha} + ${glass.toFixed(4)} * var(--ios-pm-alpha)))`,
          boxShadow: `0 5px 30px 6px rgb(0 0 0 / calc(var(--ios-pm-shadow-alpha) * ${t.toFixed(4)})), var(--ios-pm-rim)`,
          backdropFilter: filter,
          WebkitBackdropFilter: filter,
          opacity: glass,
          // A closed sheet is not just invisible: hidden takes its seven rows out of the tab order
          // and out of the accessibility tree, which `opacity: 0` on its own would not.
          visibility: t > 0 ? undefined : "hidden",
          pointerEvents: t > 0.5 ? "auto" : "none",
        }}>
        {/* The rows are laid out against the settled sheet and held there while the box grows around
            them, so they fade in where they belong instead of sliding out of the `+` with the box. */}
        <div data-slot="sheet-content" className="absolute"
          style={{ left: m.left - box.left, top: m.top - box.top, width: m.width, height: m.height }}>
          {/* The capture cuts "Check In" off at the sheet's bottom edge, which is a list saying it has
              more below - so it scrolls, and only once the box has finished growing: mid-entrance the
              sheet is smaller than this region and a scroller inside it would let the rows escape the
              corner. The scroll indicator is hidden because a menu does not carry one. */}
          <style>{highlightStyle}</style>
          <div data-slot="rows" onScroll={() => setPressed(null)} className="absolute left-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            style={{ top: rowsTop, width: m.width, height: m.height - rowsTop, overflowY: t >= 1 ? "auto" : "hidden", overscrollBehavior: "contain" }}>
          <div style={{ position: "relative", height: items.length * m.rowPitch }}>
          {items.map((item, index) => {
            const iconSize = item.iconSize ?? m.iconSize;
            const iconCenterX = item.iconCenterX ?? m.iconCenterX;
            // Staggered away from the `+`, so the row the growing box uncovers first is also the
            // first to arrive. Which end iOS starts from is not recorded anywhere here; this is the
            // order the geometry argues for, not a measurement.
            const row = easeOut(clamp01((t - mo.rowStart - (items.length - 1 - index) * mo.rowStagger) / mo.rowSpan));
            return (
              <button key={item.id} type="button" role="menuitem" data-slot="item" data-item={item.id} onClick={item.onSelect}
                data-pressed={pressed === item.id ? "true" : undefined}
                onPointerDown={() => setPressed(item.id)} onPointerUp={() => setPressed(null)}
                onPointerCancel={() => setPressed(null)} onPointerLeave={() => setPressed(null)}
                tabIndex={index === focusIndex ? 0 : -1} onFocus={() => setFocusIndex(index)}
                className="absolute left-0 flex w-full items-center text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0088ff]"
                style={{
                  top: index * m.rowPitch, height: m.rowPitch,
                  // A settled row carries neither, so the sheet at rest renders exactly as it did
                  // before there was an entrance at all.
                  opacity: row >= 1 ? undefined : row,
                  transform: row >= 1 ? undefined : `translateY(${((1 - row) * mo.rowLift).toFixed(2)}px)`,
                }}>
                {/* Inset and rounded, never a full-bleed line, and a child rather than the button's
                    own background so it can sit inside the row. See `highlightInset`. */}
                <span aria-hidden="true" data-slot="item-highlight" className="pointer-events-none absolute"
                  style={{ left: m.highlightInset, right: m.highlightInset, top: m.highlightInsetY, bottom: m.highlightInsetY,
                    borderRadius: m.highlightRadius, background: "var(--im-menu-highlight, rgba(0,0,0,0.05))" }} />
                <span aria-hidden="true" className="absolute flex items-center justify-center"
                  style={{ left: iconCenterX - m.left - iconSize / 2, top: (m.rowPitch - iconSize) / 2, width: iconSize, height: iconSize }}>
                  <AppIcon icon={item.icon} size={iconSize} />
                </span>
                <RowLabel label={item.label} />
              </button>
            );
          })}
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export type PhotoPickerGridProps = Omit<ComponentProps<"div">, "children"> & {
  /** Solid placeholder fills, one per tile. Never ship photographs in the registry. */
  tiles?: string[];
  columns?: number;
  tileSize?: number;
  gap?: number;
  /** The sheet's drag bar, drawn over the first row of tiles as the capture shows it. */
  grabber?: boolean;
  onSelect?: (index: number) => void;
};

/** Measured placeholders that sit in the same tonal range as the capture's landscape thumbnails. */
export const photoPickerPlaceholders = [
  "linear-gradient(160deg, #c8175f 0%, #e8408a 45%, #7a8f2e 100%)",
  "linear-gradient(180deg, #8fa2ad 0%, #4e6b5a 55%, #26361f 100%)",
  "linear-gradient(200deg, #8d9aa1 0%, #55605c 50%, #2a3128 100%)",
  "linear-gradient(170deg, #9fb0b8 0%, #5c7a5f 45%, #2c3a24 100%)",
  "linear-gradient(190deg, #b7c9cf 0%, #7f9a63 55%, #b52f57 100%)",
  "linear-gradient(150deg, #7fa04a 0%, #3f5c25 60%, #d9c02f 100%)",
];

export function PhotoPickerGrid({
  tiles = photoPickerPlaceholders, columns = 3, tileSize = photoPickerMetrics.tileSize, gap = photoPickerMetrics.gap,
  grabber = true, onSelect, className, style, ...props
}: PhotoPickerGridProps) {
  const g = photoPickerMetrics;
  return (
    // A group of buttons, not a listbox: choosing a photo inserts it, it does not leave one option
    // marked selected, and a listbox would owe the keyboard a roving selection it never has.
    <div data-slot="photo-picker-grid" role="group" aria-label="Recent photos"
      className={cn("relative grid select-none", className)}
      style={{ gridTemplateColumns: `repeat(${columns}, ${tileSize}px)`, gap, fontFamily: font, ...style }} {...props}>
      {tiles.map((fill, index) => (
        <button key={index} type="button" aria-label={`Photo ${index + 1}`} data-slot="tile"
          onClick={() => onSelect?.(index)}
          className="focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0088ff]"
          style={{ width: tileSize, height: tileSize, borderRadius: g.radius, background: fill, ...continuous }} />
      ))}
      {grabber && (
        <span aria-hidden="true" data-slot="grabber" className="pointer-events-none absolute left-1/2 [background:rgba(0,0,0,0.3)] dark:[background:rgba(255,255,255,0.3)]"
          style={{ top: g.grabberTop, width: g.grabberWidth, height: g.grabberHeight, marginLeft: -g.grabberWidth / 2, borderRadius: g.grabberHeight / 2 }} />
      )}
    </div>
  );
}
