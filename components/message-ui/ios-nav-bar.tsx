"use client";

import { useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * iOS 26 conversation nav bar (Liquid Glass), measured from `references/ios/captures/conv3-light.png`,
 * `conv2-dark.png` and `grouped-light.png` (all three agree). The bar sits directly under the 54pt
 * status bar and is 94pt tall: back button Ø44 centered (38, 84); avatar Ø60 at x 171–231, y 62–122
 * (center 201, 92) with initials 28pt semibold (ink 32.33 × 19.67 cap); name pill x 107.33–294.67
 * (187.33 wide) y 117.00–149.33 (32.33 tall, capsule radius 16.17, continuous corners) with 17pt bold
 * text (native ink width matches Chrome's 700, not 600) whose ink runs 121.33–272.33, then a
 * 4.67 × 12.67 chevron with a 2.6pt round stroke, ink 279.00–283.67.
 *
 * The **avatar paints over the pill**: its circle runs to y 122, 5pt below the pill's top edge, and
 * the pill's glass is behind it. What shows on the glass under the avatar is the avatar's own soft
 * shadow (offset 2, blur 4, 12%), measured at both x 180 (#ededed just below the circle) and x 201.
 *
 * Glass surfaces are 90% white with a backdrop blur and a soft drop shadow (capsules 0 6 36 spread 4
 * at 6.5%, circles 0 5 20 spread 6 at 5.5%, clipped at the midpoint of gaps between neighbors so they
 * do not add up, as on the device) in light; in dark #191919 under a 1pt specular rim that ramps
 * inward, measured over black on the back button's integer box as 12.6% → 9.6% → 6.1% white across
 * its three device rows. Shadows are painted on a layer beneath every surface so neighbors never
 * shade each other.
 *
 * Those captures pin the *composite*, not the fill. Both put a flat page behind every glass surface
 * here, so the light fill is pinned to white at any alpha and the dark fill only to the product
 * alpha × colour (0.9 × 28 = 25.2 = #191919). Halving both alphas while holding those products
 * (rgba(255,255,255,0.45) and rgba(56,56,56,0.45)) leaves the dark diff bit-identical at 0.31% and
 * the light one at 380 → 386 mismatched px of 361,800. So 90% is a choice, not a measurement, and it
 * is the number that decides how much of a bubble scrolled under the bar shows through. Unverified.
 *
 * The bar's own background is transparent and content scrolls under it, which `dateheader-mid-light.png`
 * and `dateheader-mid-dark.png` show is not what the device does: an incoming bubble crossing the bar is
 * pulled toward the page background across the bar's whole width, outside every glass surface. Down
 * x 95, the dark incoming bubble #262629 (38,38,41) reads (9,9,9) at y 105, (23,23,25) at y 140 and
 * (32,32,35) at y 160 where that bubble ends; the next one down, at x 30, is still (36,36,39) at y 175
 * and reaches (38,38,41) only at y 195, 47 below the bar. Light #e9e9eb (233,233,235) reads
 * (246,246,246) at y 105 and settles by y 150. The two ramps do not agree as one blend toward the page
 * colour, and they still do not once each is solved on its own, but each on its own is a clean
 * straight line: that is `ios-scroll-edge`, which the app now draws between the transcript and this
 * bar. The wash is not this component's - the bar is furniture over it, not the thing that paints it.
 *
 * Both controls respond to a finger - they dim, and the round one shrinks. Neither number is in the
 * captures; see `iosNavPress` for where they come from and what is borrowed.
 *
 * Two sub-pixel offsets are transforms because Chrome quantizes paint, not layout: text baselines and
 * inline-SVG paint offsets snap to whole CSS px, so the name and the chevron each carry a 1/3-px
 * translate that the padding cannot express.
 */
export type IosNavBarProps = Omit<ComponentProps<"header">, "children"> & {
  name: string;
  initials?: string;
  /** Replace the initials avatar (e.g. an <img>). */
  avatar?: ReactNode;
  onBack?: () => void;
  onDetails?: () => void;
};

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

const vars =
  "[--ios-nav-label:#1a1919] [--ios-nav-chevron:#bdbdbd] [--ios-nav-glass:rgba(255,255,255,0.9)] [--ios-nav-rim:none] [--ios-nav-shadow:0_6px_36px_4px_rgba(0,0,0,0.065)] [--ios-nav-shadow-round:0_5px_20px_6px_rgba(0,0,0,0.055)] [--ios-nav-avatar-shadow:rgba(0,0,0,0.12)] " +
  "[--ios-nav-avatar-top:#a9c2e1] [--ios-nav-avatar-bottom:#747fb9] " +
  "dark:[--ios-nav-label:#f4f3f4] dark:[--ios-nav-chevron:#5d5d5d] dark:[--ios-nav-glass:rgba(28,28,28,0.9)] dark:[--ios-nav-rim:inset_0_0_0_0.3333px_rgba(255,255,255,0.0385),inset_0_0_0_0.6667px_rgba(255,255,255,0.032),inset_0_0_0_1px_rgba(255,255,255,0.061)] dark:[--ios-nav-shadow:none] dark:[--ios-nav-shadow-round:none] dark:[--ios-nav-avatar-shadow:rgba(0,0,0,0.3)] " +
  "dark:[--ios-nav-avatar-top:#575368] dark:[--ios-nav-avatar-bottom:#302649]";

/** Apple's continuous corner (superellipse n≈2.2, measured on the pill). Browsers without corner-shape fall back to round. */
const capsule = { cornerShape: "superellipse(1.14)" } as CSSProperties;

/**
 * What a finger does to these controls.
 *
 * **Borrowed, not measured.** No capture in this repo holds a pressed control, so the two numbers
 * come from ChatKit, and they are the only two it has: grepping the framework's whole selector table
 * for `touchAlpha|touchScale|pressedAlpha|pressedScale|highlightAlpha|highlightScale|dimAlpha|
 * touchDownAlpha|touchDownScale` returns `replyButtonTouchAlpha` = 0.4 and `replyButtonTouchScale`
 * = 0.85 and nothing else. Read at both idioms with the swizzle in place, `CKUIBehaviorPhone`
 * (idiom 0) and `CKUIBehaviorMac` (idiom 5) agree on both.
 *
 * They belong to a different button, but to the nearest one ChatKit records: the reply button is
 * itself a blurred glass pill (`replyButtonBackgroundBlurRadius` 5, `replyButtonBorderWidth` 0.5,
 * `replyButtonEdgeInsets` {8, 14, 8, 14}), and ChatKit applies both to the whole view on
 * `_buttonTouchDown` and takes them off on `_buttonTouchUpInside`, which is what the glass circle
 * here does. iOS 26 renders the pressed state of a `glassButtonConfiguration` button in UIKit, not in
 * ChatKit, so there is no closer number to find.
 *
 * The **scale is not applied to the name pill**: 0.85 on a 187.33-wide capsule pulls each end 14 pt
 * inward, which reads as a different control rather than a pressed one. Recorded here, drawn only on
 * the round back button.
 *
 * `release` is **unmeasured** - nothing in this repo records a control in motion. Press-down is
 * instant, which is what a direct-manipulation highlight is; only the release eases back.
 */
export const iosNavPress = { alpha: 0.4, scale: 0.85, release: 100 };

/**
 * Press state that a finger, a mouse and the keyboard all reach.
 *
 * Pointer events rather than `:active`: Chrome holds `:active` back on a touch until the gesture has
 * resolved into a tap rather than a scroll, so a finger that is still down is not reliably styled and
 * a driven `Input.dispatchTouchEvent` hold cannot be proved. The pointer is captured so the release
 * always lands back here, and while it is held the press follows the pointer out of the button's own
 * box, which is what iOS does when a finger slides off a control.
 *
 * A finger that slides off does not come back, and that is Chromium rather than this hook: driving a
 * real touch 60 px off the button logs `pointerdown -> pointermove(outside) -> touchmove ->
 * pointercancel -> lostpointercapture`, i.e. gesture arbitration takes the pointer away the moment
 * the finger pans, and the touchmove back onto the control delivers no pointer event at all. A mouse
 * keeps its pointer, so dragging off a held button drops the press and dragging back on takes it up
 * again.
 *
 * Nothing here moves focus, deliberately: both engines match `:focus-visible` on a programmatic focus
 * taken while a pointer is still down, so a press opened by a finger would draw a ring iOS never
 * draws (`tapback-bar.tsx` and `audio-recorder.tsx` carry the two fixes for the places that do have
 * to move focus). The ring these buttons keep is the keyboard one, and it is reached by tabbing.
 */
function usePress() {
  const [pressed, setPressed] = useState(false);
  const held = useRef(false);
  const release = () => { held.current = false; setPressed(false); };
  return {
    pressed,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        held.current = true;
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the pointer ended before this handler ran */ }
        setPressed(true);
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        if (!held.current) return;
        const box = event.currentTarget.getBoundingClientRect();
        setPressed(event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom);
      },
      onPointerUp: release,
      onPointerCancel: release,
      onLostPointerCapture: release,
      onKeyDown(event: KeyboardEvent<HTMLElement>) { if (event.key === " " || event.key === "Enter") setPressed(true); },
      onKeyUp: release,
      onBlur: release,
    },
  };
}

/** Instant down, eased back up; `data-pressed` turns the transition off so the dim lands on the frame the finger does. */
const pressTransition = "transition-[opacity,transform] ease-out data-pressed:transition-none motion-reduce:transition-none";

/**
 * Shadow layer (beneath every surface of the bar), then the blur, then the translucent surface. The
 * parent must be `relative` and its content `relative`.
 *
 * `clip` stops the shadow at the midpoint of the 12pt gap toward a neighboring glass element, so the
 * two shadows read as one (they never add up on the device).
 *
 * The blur rides its own span: `backdrop-filter` promotes an element to a composited layer whose
 * bounds Chrome snaps to whole CSS px, which would drag the pill's edges from x 107.33/294.67 out to
 * 107/295. Keeping the fill and the rim on an unfiltered span lets the surface paint on the exact
 * fractional box.
 */
function GlassLayers({ round = false, clip }: { round?: boolean; clip?: "left" | "right" }) {
  return (
    <>
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 rounded-[inherit] [corner-shape:inherit]" style={{ boxShadow: round ? "var(--ios-nav-shadow-round)" : "var(--ios-nav-shadow)", clipPath: clip ? `inset(-60px ${clip === "right" ? "-6px" : "-60px"} -60px ${clip === "left" ? "-6px" : "-60px"})` : undefined }} />
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] [corner-shape:inherit]" style={{ backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }} />
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] [corner-shape:inherit]" style={{ background: "var(--ios-nav-glass)", boxShadow: "var(--ios-nav-rim)" }} />
    </>
  );
}

export function initialsOf(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0] ?? "").join("").toUpperCase();
}

export function IosNavBar({ name, initials, avatar, onBack, onDetails, className, style, ...props }: IosNavBarProps) {
  const letters = initials ?? initialsOf(name);
  const back = usePress();
  const title = usePress();
  return (
    <header data-slot="ios-nav-bar" className={cn("relative isolate h-[94px] w-full select-none", vars, className)} style={{ fontFamily: font, ...style }} {...props}>
      <button type="button" data-slot="back" aria-label="Back" onClick={onBack} data-pressed={back.pressed || undefined} {...back.handlers}
        className={cn("absolute flex items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-blue-500", pressTransition)}
        style={{ left: 16, top: 8, width: 44, height: 44, transitionDuration: `${iosNavPress.release}ms`, opacity: back.pressed ? iosNavPress.alpha : undefined, transform: back.pressed ? `scale(${iosNavPress.scale})` : undefined }}>
        <GlassLayers round />
        <svg aria-hidden="true" className="relative" width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="var(--ios-nav-label)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M24.8 13.87 16.2 22.17 24.8 30.47" />
        </svg>
      </button>
      {/* Padding and gap are solved, not chosen: they place the 17pt text run and the chevron on the
          measured ink positions while the pill's own box comes out 187.33 wide, centered on x 201. */}
      <button type="button" data-slot="title" aria-label={`${name}, details`} onClick={onDetails} data-pressed={title.pressed || undefined} {...title.handlers}
        className={cn("absolute flex items-center whitespace-nowrap rounded-full focus-visible:outline-2 focus-visible:outline-blue-500", pressTransition)}
        /* Alpha only. `iosNavPress.scale` on a capsule this wide moves each end 14 pt, which is a different control rather than a pressed one. */
        style={{ left: "50%", top: 63, height: 32.3333, transform: "translate(-50%, 0)", padding: "0.3333px 10.7188px 0 12.9531px", gap: 6.1875, transitionDuration: `${iosNavPress.release}ms`, opacity: title.pressed ? iosNavPress.alpha : undefined, ...capsule }}>
        <GlassLayers />
        <span data-slot="name" className="relative" style={{ transform: "translateY(0.3333px)", fontSize: 17, lineHeight: 1, fontWeight: 700, letterSpacing: 0, color: "var(--ios-nav-label)" }}>{name}</span>
        <svg aria-hidden="true" className="relative" width="8.6667" height="16.6667" viewBox="-2 -2 8.6667 16.6667" style={{ margin: -2, transform: "translateX(-0.3333px)" }} fill="none" stroke="var(--ios-nav-chevron)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1.3 1.3 3.37 6.3333 1.3 11.37" />
        </svg>
      </button>
      {/* A supplied avatar brings its own artwork — an <img>, or the group photo's Snowglobe stack
          over its own material plate — so the monogram gradient is dropped rather than left to show
          through anything translucent. The Ø60 slot, its centre and its shadow are unchanged either
          way, which is what the details screen's entrance morphs out of. */}
      <div aria-hidden="true" data-slot="avatar" className="absolute flex items-center justify-center overflow-hidden rounded-full text-white"
        style={{ left: "calc(50% - 30px)", top: 8, width: 60, height: 60, fontSize: 28, lineHeight: 1, fontWeight: 600, background: avatar ? undefined : "linear-gradient(var(--ios-nav-avatar-top), var(--ios-nav-avatar-bottom))", boxShadow: "0 2px 4px var(--ios-nav-avatar-shadow)" }}>
        {avatar ?? letters}
      </div>
    </header>
  );
}

/**
 * The conversation list's large title ("Messages"): 34pt bold at x 16, cap height centered on
 * y 140 of the screen (baseline 152). Occupies the 114pt between the status bar and the first row.
 */
export function IosLargeTitle({ children, className, style, ...props }: ComponentProps<"h1">) {
  return (
    <h1 data-slot="ios-large-title" className={cn("m-0 select-none [--ios-title:#000000] dark:[--ios-title:#ffffff]", className)}
      style={{ height: 114, paddingTop: 68, paddingLeft: 16, fontFamily: font, fontSize: 34, lineHeight: 1, fontWeight: 700, letterSpacing: 0, color: "var(--ios-title)", boxSizing: "border-box", ...style }} {...props}>
      {children}
    </h1>
  );
}
