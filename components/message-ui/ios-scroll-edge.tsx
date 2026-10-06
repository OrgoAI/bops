"use client";

import type { ComponentProps, CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * What iOS 26 does to a message that scrolls up under the conversation's floating nav bar.
 *
 * The bar itself has no background — a back button, an avatar and a name pill float over the
 * transcript and nothing else is painted — so a bubble passing behind them used to arrive at full
 * contrast and collide with the glyphs. `ios-nav-bar.tsx` has recorded that as wrong since it was
 * written; this is the missing half.
 *
 * ## The ramp
 *
 * `dateheader-mid-light.png` and `dateheader-mid-dark.png` both catch an incoming bubble crossing the
 * bar, and both are flat enough inside it to solve for the wash directly. Take the columns clear of
 * the bar's own furniture — x 68 to 103, between the Ø44 back button (x 16–60) and the name pill
 * (x 107–295) — keep only the device rows whose pixels agree to within 2/255 so no glyph or bubble
 * edge is in the sample, and read each row against the bubble's own colour and the page's:
 *
 *     t(y) = (row - bubble) / (page - bubble)
 *
 * The bubble colours are the captures' own, taken from a second bubble further down the same frame
 * where nothing touches it: #262629 (38,38,41) dark, #e9e9eb (233,233,235) light. Over the 110 dark
 * and 91 light clean rows between y 105 and 161, `t` is a straight line in `y` — rmse 0.015 and
 * 0.012, and fitting a quadratic instead moves neither (the y² term is 4e-5 and 2e-5) — so this is a
 * linear wash toward the page colour and not an ease.
 *
 * | | slope | t = 1 | t = 0 | span |
 * | --- | --- | --- | --- | --- |
 * | light | −0.01025 | y 62.85 | y 160.39 | 97.53 |
 * | dark | −0.01212 | y 89.17 | y 171.71 | 82.54 |
 *
 * **The two themes do not agree, and that is measured, not a mistake.** Dark washes over a shorter
 * span and lets go 11 pt lower down. Nothing in either capture explains why; both were solved the
 * same way against colours confirmed elsewhere in the same frame. What *is* only extrapolation is
 * where each ramp reaches full strength: the sample can only start at y 105, where the bubble does,
 * so `t = 1` at y 62.85 and 89.17 is the fitted line continued upward, not something either capture
 * shows. The measured range is t 0.55→0.02 (light) and 0.77→0.14 (dark).
 *
 * ## Why a wash and not a blur
 *
 * iOS 26's scroll-edge effect is a progressive blur as well as a wash, and this draws only the wash.
 * The captures cannot separate them here: a blur pulling the page colour in from above a bubble
 * produces the same ramp on a flat interior that a wash does, and there is no text inside the ramp in
 * either frame to tell them apart — the only sharp glyphs up there are the bar's own name pill, which
 * is painted above the effect. `macos-header.tsx` stacks four backdrop-filter layers for the Mac's
 * version of this because that capture *does* show the blur; until an iOS capture does, the honest
 * thing here is the part that was measured.
 */
export const iosScrollEdge = {
  /** Page-colour wash, `t = 1` at `full` and `t = 0` at `zero`, in screen points from the top. */
  light: { full: 62.85, zero: 160.39 },
  dark: { full: 89.17, zero: 171.71 },
} as const;

/**
 * The two ramps as tokens, so the element can switch with the `.dark` class the way every other
 * component in the kit does instead of needing the theme handed to it. The box is always as tall as
 * the lower of the two zero points; past its own `--ios-se-zero` the gradient is transparent, so the
 * extra 11 pt in light costs nothing.
 */
export const iosScrollEdgeVars =
  // Spelled out rather than interpolated from `iosScrollEdge`: Tailwind scans source text, and a
  // class built out of a template literal is not there to be found. The unit test holds the two in
  // step instead.
  "[--ios-se-full:62.85px] [--ios-se-zero:160.39px] dark:[--ios-se-full:89.17px] dark:[--ios-se-zero:171.71px]";

export type IosScrollEdgeProps = Omit<ComponentProps<"div">, "children"> & {
  /** Pins one ramp instead of following the `.dark` class. The two are measured separately and differ. */
  theme?: "light" | "dark";
};

/**
 * The wash, as one element. It has to sit above the transcript and below the bar's glass, and it is
 * `pointer-events-none` so a bubble under it is still pressable.
 *
 * The gradient is `--im-bg` at full alpha down to `full`, then linearly to transparent at `zero`.
 * Two stops are enough because the fit says the ramp is a straight line; anything above `full` is the
 * status bar's own ground, where the page is opaque anyway.
 */
export function IosScrollEdge({ theme, className, style, ...props }: IosScrollEdgeProps) {
  const pinned = theme ? iosScrollEdge[theme] : null;
  return (
    <div aria-hidden="true" data-slot="scroll-edge"
      className={cn("pointer-events-none absolute inset-x-0 top-0", !pinned && iosScrollEdgeVars, className)}
      style={{
        height: Math.max(iosScrollEdge.light.zero, iosScrollEdge.dark.zero),
        background: pinned
          ? `linear-gradient(var(--im-bg) ${pinned.full}px, transparent ${pinned.zero}px)`
          : "linear-gradient(var(--im-bg) var(--ios-se-full), transparent var(--ios-se-zero))",
        ...style,
      } as CSSProperties}
      {...props} />
  );
}
