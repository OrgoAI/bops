"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type UIEvent as ReactUIEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * iOS 26 conversation details screen, measured from `references/ios/captures/details-light.png`
 * and `details-dark.png` (402×874 @3x). Every number below is a point value read off those frames:
 *
 * - Back button Ø44 glass circle centred (38, 84); avatar Ø80 centred (201, 102).
 * - Avatar initials: ink 44.00 wide by 26.67 cap, x 178.67–222.33, y 89.00–115.33. Chrome needs
 *   37.5pt at weight 650 to land there; 34pt semibold is 4.33 too narrow and 2.33 too short.
 * - Name 26pt bold centred on x 201, ink y 152.33–177.67.
 * - Three Ø54 glass action circles centred y 222.67 at x 127 / 201 / 275 (74 pitch). Glyphs are
 *   22pt SF Symbols: available ones use the label colour, unavailable ones tertiary label (30%).
 * - Grouped cells span x 16–386, radius 26 with a continuous corner, 20 between groups: phone
 *   269.67–340.33 (70.67 tall), links 360.33–464.33 (two 52 rows, 1pt separator at 411.33 inset to
 *   x 32–370), Hide Alerts 484.33–536.33, Block Contact 556.33–608.33. Row text starts at x 32.
 * - Cell and button fills are translucent: 6% black in light, 12% white in dark (over pure white
 *   that measures #efeff0, over black #1c1c1f — both read off the captures).
 * - Switch: 63×28 track (radius 14) with a 37×24 knob (radius 12) inset 2, trailing edge at x 372.
 *   Re-measured 2026-09-08 on the Hide Alerts row of both captures: track x 309.00–372.00,
 *   y 496.333–524.333; knob x 311.00–348.00, y 498.333–522.333. Both captures show it **off**; no
 *   capture in this repo holds an on switch, so the on colour comes from the framework instead
 *   (`+[UIColor systemGreenColor]` resolved under each `UIUserInterfaceStyle` in a Mac Catalyst
 *   process with the idiom swizzled to phone: #34c759 light, #30d158 dark). `-[UISwitch
 *   intrinsicContentSize]` there is 61×28, which corroborates the measured 28 track height.
 *   The off track darkens the cell fill by 21% in light and lightens it by 28% in dark (sampled
 *   beside the knob against the bare cell on the same row).
 * - RECENT tag: 41×11.33 pill, radius 3.5, #c7c7cc in both themes, 8.5pt bold label (cap 6).
 *
 * The screen sits over the conversation, which is blurred (σ≈18) and washed out by a 49% white /
 * 59% black scrim; pass that conversation as `backdrop`.
 *
 * ## Under a finger
 *
 * Every pressable thing on this screen has a held state, and none of it is in a capture — a still of
 * a resting screen cannot hold one. Both values come from the framework instead, at the **phone**
 * idiom, and `iosDetailsPress` records which is which: a grouped-list row fills with
 * `-[CKUITheme detailsSelectedCellColor]` (#dcdcdc / #464646) and a round button or a photo tile
 * dims to `-[CKUIBehaviorPhone replyButtonTouchAlpha]` (0.4). The Hide Alerts row is the exception
 * and stays flat, as a `UITableViewCell` carrying a `UISwitch` does. See `usePressed` for why the
 * state is pointer-driven rather than `:active`, and `IosSwitch` for what "the switch does not
 * switch" actually was.
 *
 * The presentation is a separate matter, and its timings are UNMEASURED: no capture in this repo
 * records this screen in motion, so nothing below is a reading off a frame. See `iosDetailsMotion`.
 *
 * ## What the capture does not show
 *
 * `details-light.png` is one scroll position of a conversation with no shared content: the cell
 * stack ends at Block Contact and nothing follows it. Three groups are therefore built from the
 * measured *style* rather than from a frame, and are **UNMEASURED**: the shared photos grid, the
 * shared links list and the shared attachments list (`photos`, `sharedLinks`, `attachments`). They
 * sit between Hide Alerts and Block Contact, which is where they push the destructive row down, and
 * with all three absent the stack reproduces the capture point for point. What they reuse:
 *
 * - The cell geometry, the 20 between groups, the 52 row, the 70.67 two-line cell, the 16 row inset
 *   and the 1pt separator inset to x 32–370 are all measured on this screen.
 * - A two-line item row keeps the measured phone cell's three gaps (16.875 above, 1.5 between,
 *   14.29 below) with its 17pt and 13pt lines swapped, so it is 70.67 tall like the measured one.
 * - The grid is 3 across with a 4 gap, from `+[CKUIBehavior sharedBehaviors]` under the phone
 *   idiom: `attachmentBrowserGridInterItemSpacing` and `attachmentBrowserGridMinimumLineSpacing`
 *   are both 4. Inside the 370 cell at the measured 16 inset that makes a 110 tile. The tile radius
 *   12 is the measured Photos-picker tile radius (SPEC, `photo-picker-light.png`).
 * - The chevron on a row that navigates is the nav bar's measured chevron: 4.67 × 12.67 ink, 2.6
 *   round stroke, #bdbdbd / #5d5d5d (`ios-nav-bar.tsx`).
 *
 * ChatKit 26 actually files shared content under tabs, not under more cells on the info list
 * (`DetailsPhotosTab`, `DetailsLinksTab`, `DetailsAttachmentsTab`, `CKDetailsSegmentedControlCell`).
 * Nothing in `references/` shows that surface, so this file stays with the grouped cells.
 *
 * ## Scrolling
 *
 * Also UNMEASURED, and it cannot be measured from a still. The cells scroll; the header collapses
 * into the conversation's nav bar, which is the exact inverse of the pose the presentation grows
 * out of, so the two ends of the collapse are measured even though the travel between them is not.
 * See `iosDetailsCollapse`. It is seekable: `scroll` (in points) drives paused Web Animations, so
 * `document.getAnimations()` reaches every layer and a checkpoint renders the same twice.
 */

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

/** Light/dark values live in CSS variables so a `.dark` ancestor flips the whole screen. */
const vars =
  "[--ios-dt-label:#000000] [--ios-dt-secondary:#848488] [--ios-dt-blue:#0088ff] [--ios-dt-red:#ff383c] " +
  "[--ios-dt-fill:rgba(0,0,0,0.06)] [--ios-dt-separator:#dadadb] [--ios-dt-glyph:#000000] [--ios-dt-glyph-off:rgba(0,0,0,0.26)] [--ios-dt-glyph-blend:normal] [--ios-dt-av-top:#a9c2e1] [--ios-dt-av-bottom:#747fb9] " +
  "[--ios-dt-tag:#c7c7cc] [--ios-dt-tag-label:#ffffff] [--ios-dt-track:rgba(0,0,0,0.21)] [--ios-dt-knob:#ffffff] [--ios-dt-press:#dcdcdc] " +
  "[--ios-dt-chevron:#bdbdbd] [--ios-dt-av-shadow:rgba(0,0,0,0.12)] [--ios-dt-glass:rgba(255,255,255,0.9)] [--ios-dt-glass-rim:inset_0_0_0_0_rgba(0,0,0,0)] [--ios-dt-glass-shadow:0_6px_36px_4px_rgba(0,0,0,0.065)] " +
  "[--ios-dt-scrim:rgba(255,255,255,0.573)] [--ios-dt-saturate:1] [--ios-dt-page:#ffffff] " +
  "dark:[--ios-dt-label:#ffffff] dark:[--ios-dt-secondary:#98989f] dark:[--ios-dt-blue:#0091ff] dark:[--ios-dt-red:#ff4245] " +
  "dark:[--ios-dt-fill:rgba(235,235,245,0.12)] dark:[--ios-dt-separator:#3a3a3c] dark:[--ios-dt-glyph:#ffffff] dark:[--ios-dt-glyph-off:rgba(255,255,255,0.26)] dark:[--ios-dt-glyph-blend:plus-lighter] dark:[--ios-dt-av-top:#575368] dark:[--ios-dt-av-bottom:#302649] " +
  "dark:[--ios-dt-track:rgba(255,255,255,0.28)] dark:[--ios-dt-press:#464646] dark:[--ios-dt-chevron:#5d5d5d] dark:[--ios-dt-av-shadow:rgba(0,0,0,0.3)] " +
  "dark:[--ios-dt-glass:rgba(28,28,28,0.9)] dark:[--ios-dt-glass-rim:inset_0_0_0_0.3333px_rgba(255,255,255,0.0385),inset_0_0_0_0.6667px_rgba(255,255,255,0.032),inset_0_0_0_1px_rgba(255,255,255,0.061)] dark:[--ios-dt-glass-shadow:0_0_0_0_rgba(0,0,0,0)] " +
  "dark:[--ios-dt-scrim:rgba(0,0,0,0.587)] dark:[--ios-dt-saturate:1.05] dark:[--ios-dt-page:#000000]";

/** Apple's continuous corner. Browsers without `corner-shape` fall back to a plain round corner. */
const continuous = { cornerShape: "superellipse(1.14)" } as CSSProperties;

/**
 * The grouped-cell geometry, all of it measured off the captures (see the header). `top` is the
 * first cell's top; every later group starts `gap` below the one before it, which reproduces the
 * measured 269.67 / 360.33 / 484.33 / 556.33 stack exactly and lets an unmeasured group in without
 * moving anything above it.
 */
const cell = {
  left: 16,
  width: 370,
  radius: 26,
  gap: 20,
  top: 269.6667,
  /** Row text starts at x 32, i.e. 16 inside the cell. */
  inset: 16,
  /** One-line row (Hide Alerts, Block Contact, the blue link rows). */
  row: 52,
  /** Two-line cell (the phone row). */
  twoLine: 70.6667,
} as const;

/** The measured two-line cell's three gaps, with its 17pt and 13pt lines swapped. UNMEASURED. */
const twoLineRow = { title: 16.875, detail: 40.375 } as const;

/** 3 across, 4 apart (CKUIBehavior, phone idiom), inside the measured 16 inset: a 110 tile. */
const grid = { columns: 3, gap: 4, radius: 12 } as const;
const tile = (cell.width - cell.inset * 2 - grid.gap * (grid.columns - 1)) / grid.columns;

export type IosDetailsAction = {
  id: string;
  label: string;
  icon: "phone" | "video" | "mail";
  /** Unavailable actions keep the glass circle but drop the glyph to tertiary label (measured). */
  disabled?: boolean;
  onPress?: () => void;
};

/** One tile of the shared photos grid. Pass `node` for a next/image, `src` for a plain one. */
export type IosDetailsPhoto = { id: string; src?: string; alt?: string; node?: ReactNode; onPress?: () => void };
/** One row of the shared links or shared attachments list. */
export type IosDetailsItem = { id: string; title: string; detail?: string; onPress?: () => void };
/** A shared-content group: a header row that navigates, then its items. */
export type IosDetailsSection<T> = { title?: string; count?: number | string; items: T[]; onOpen?: () => void };

export type IosDetailsProps = Omit<ComponentProps<"div">, "children" | "onChange"> & {
  name: string;
  initials?: string;
  /** Replaces the initials avatar (an <img>, say). */
  avatar?: ReactNode;
  /** First cell: a small label ("phone") over its value, with an optional tag ("RECENT"). */
  phoneLabel?: string;
  phone?: string;
  tag?: string;
  actions?: IosDetailsAction[];
  /** Blue link rows in the second cell. */
  links?: Array<{ id: string; label: string; onPress?: () => void }>;
  /** Controlled Hide Alerts. Omit it and the switch keeps its own state; see `IosSwitch`. */
  hideAlerts?: boolean;
  defaultHideAlerts?: boolean;
  onHideAlertsChange?: (next: boolean) => void;
  hideAlertsLabel?: string;
  /** Shared content, below the capture's fold and UNMEASURED. Each one is a grouped cell. */
  photos?: IosDetailsSection<IosDetailsPhoto>;
  sharedLinks?: IosDetailsSection<IosDetailsItem>;
  attachments?: IosDetailsSection<IosDetailsItem>;
  /**
   * The destructive row's two states. It is a toggle in Messages, not a one-way trip: the row reads
   * `BLOCK_CONTACT` ("Block Contact") and, once the contact is blocked, `UNBLOCK_CONTACT` ("Unblock
   * Contact") — both ChatKit's own strings. Omit `blocked` and the row keeps its own state, the way
   * `IosSwitch` does, so the row answers a press with nothing wired.
   *
   * **NOT BUILT: the confirmation.** iOS puts an action sheet in front of this whose message is
   * `BLOCK_SENDER_TITLE` ("You will not receive phone calls, messages, or FaceTime from people on
   * the block list.") over a destructive `BLOCK_CONTACT` and a Cancel. No capture in `references/`
   * holds it, and its geometry would be invented, so the row toggles and reports instead.
   */
  blocked?: boolean;
  defaultBlocked?: boolean;
  blockLabel?: string;
  unblockLabel?: string;
  onBlock?: (blocked: boolean) => void;
  onBack?: () => void;
  /** The conversation behind the screen; rendered blurred and washed out. */
  backdrop?: ReactNode;
  /**
   * Seek the presentation to this fraction instead of playing it, which is what the harness does:
   * while `open`, 0 is dismissed and 1 is settled; while it is closing, 0 is settled and 1 is gone.
   * Leave it unset for the real thing.
   */
  progress?: number;
  /**
   * Seek the scroll position, in points, instead of letting the surface scroll: the header collapse
   * follows it exactly the way it follows a finger. Leave it unset for the real thing.
   */
  scroll?: number;
  /** False plays the dismissal; `onExited` fires when it is over, and the consumer unmounts then. */
  open?: boolean;
  onExited?: () => void;
};

/**
 * The presentation's timings. UNMEASURED, and they cannot be measured from anything in this repo:
 * no capture records this screen in motion. They sit in the family of the ones that were measured:
 *
 * - The rise takes 320 ms on `cubic-bezier(0.32, 0.72, 0, 1)`, the curve the measured effects screen
 *   (`ios-effects-picker.tsx`, 260 ms), this file's own Hide Alerts switch (220 ms) and the app
 *   shell's screen transitions (`iosScreenTransition`, 400 ms present) all already use.
 * - The scrim and the shared chrome fade over 220 ms, a little ahead of the rise, the way the
 *   long-press overlay's measured dim (150 of its 600 ms) leads its menu.
 * - The way out is 260 ms on the long-press menu's exit curve, between that menu's own 220 ms exit
 *   and the shell's 280 ms dismiss.
 *
 * What IS measured is the pose at each end. The settled pose is `details-light.png`, unchanged: the
 * timeline is cancelled once it lands, so the screen at rest carries no transform at all. The start
 * pose is the conversation's own nav bar, so the screen grows out of the control that opened it:
 * `ios-nav-bar.tsx` puts the avatar Ø60 centred (201, 92) and the name pill's 17pt text centred on
 * y 133.5 (status bar 54 + pill top 63, 32.33 tall, its span nudged 0.33 down); this screen puts the
 * avatar Ø80 centred (201, 102) and the 28pt name centred on y 162.65. So the avatar grows 60 → 80
 * (scale 0.75) across 10 pt of centre, which is the same thing as growing downward from a top edge
 * both screens put on y 62; the name grows 17 → 28 (scale 0.6071) across 29.15; and the back button
 * does not move at all, being Ø44 at (16, 62) on both. The avatar's 37.5pt initials land on 28.1pt
 * at that scale, a third of a point off the nav bar's own 28.
 *
 * The one number here that touches the capture is `backdropScale`. A sheet pushes what it covers
 * back; under σ18 of blur and a 57% scrim the capture cannot tell whether it did. Diffed against
 * `details-light.png` over 0 60 402 560 the settled screen misses 1713 px of 2,026,080 unscaled and
 * 1642 px at 0.96 (both 0.08%; dark is 3136 / 3068, both 0.15%), so the frame does not decide it and
 * this is a presentation choice, not a measurement. The blur is divided by the scale so that what
 * lands on screen is still σ18.
 *
 * Re-measured 2026-09-09 on the same two frames and the same region: **1639 light, 3624 dark**. The
 * light number is better than the one above and the dark one is worse, and neither move is from the
 * press work in this file — reverting the row clip alone, and then the action circles' paint order
 * alone, each left the dark frame at exactly 3624. Whatever moved it is outside these three files.
 */
/** The control points behind `iosDetailsMotion.ease`; the drag inverts the curve through them. */
const sheetCurve = [0.32, 0.72, 0, 1] as const;

export const iosDetailsMotion = {
  /** The whole entrance, and the sheet's own rise inside it. */
  enter: 360,
  sheet: 320,
  /** The scrim, and the chrome both screens share. */
  dim: 220,
  exit: 260,
  ease: `cubic-bezier(${sheetCurve.join(", ")})`,
  exitEase: "cubic-bezier(0.4, 0, 1, 1)",
  /** The conversation behind: its blur, and how far the sheet pushes it back. */
  blur: 18,
  backdropScale: 0.96,
  /** The three glass buttons, then the grouped cells, settle after the header in a short stagger. */
  actionStart: 60, actionStagger: 22, actionRise: 14, actionDuration: 200,
  cellStart: 80, cellStagger: 24, cellRise: 22, cellDuration: 200,
  /** The stagger stops at the measured stack's four cells, so a longer stack still lands by `enter`. */
  cellStaggerMax: 3,
  /** A drag past this far, or released faster than this (px/ms), dismisses. */
  dragCommit: 120, dragVelocity: 0.6,
} as const;

/** Where the header comes from: the nav bar's own avatar and name pill, both measured (see above). */
export const iosDetailsMorph = {
  avatar: { dy: -10, scale: 60 / 80 },
  name: { dy: -29.15, scale: 17 / 28 },
} as const;

/**
 * The header collapse. UNMEASURED — no capture holds this screen scrolled — but both ends of it are:
 * it runs the presentation's morph backwards, so a fully collapsed header is the conversation's own
 * measured nav bar (avatar Ø60 centred (201, 92) under its measured shadow, the name 17pt centred on
 * y 133.5 inside the measured glass pill, the back button Ø44 at (16, 62), which never moves).
 *
 * `travel` is derived rather than chosen: 120.3333 is the scroll that carries the first cell's
 * measured top (269.6667) onto the nav bar pill's measured bottom edge (149.3333), so the collapse
 * finishes exactly as the content reaches the bar it is passing under, and never overlaps it.
 * `actionFade` is derived the same way: the three glass circles are gone by the scroll (74) that
 * brings the first cell's top onto their measured top (195.6667).
 *
 * The pill's own box is the nav bar's measured padding (12.9531 leading, 10.7188 trailing) around
 * the name at the collapsed scale, so a longer or shorter name gets the pill that name would have.
 */
export const iosDetailsCollapse = {
  travel: 120.3333,
  actionFade: 74,
  pill: { top: 117, height: 32.3333, radius: 16.1667, padLeft: 12.9531, padRight: 10.7188, centre: 201 },
  /** Rendering the collapsed pill's 24 blur (measured on the nav bar) through the collapsed scale. */
  blur: 24,
} as const;

type Pose = Record<string, string>;
type Layer = { el: HTMLElement; from: Pose; to: Pose; duration: number; delay: number; easing: string };

function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function clamp01(value: number) { return Math.max(0, Math.min(1, value)); }
function stop(animation: Animation) { try { animation.cancel(); } catch { /* already gone */ } }
function seekTo(list: Animation[], time: number) {
  list.forEach(animation => { animation.pause(); try { animation.currentTime = time; } catch { /* no timeline yet */ } });
}

/**
 * Where in the rise the sheet stands `covered` of the way up: the entrance curve read backwards.
 * A drag scrubs the timeline, and `cubic-bezier(0.32, 0.72, 0, 1)` spends most of its travel in the
 * first fifth of it, so scrubbing it linearly would leave the screen nearly still under a finger
 * that has already moved 200 pt. Bisect the curve's y for its parameter, then read its x.
 */
function riseSeek(covered: number): number {
  const [x1, y1, x2, y2] = sheetCurve;
  const at = (a: number, b: number, t: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  let low = 0, high = 1, t = 0.5;
  for (let step = 0; step < 24; step++) { t = (low + high) / 2; if (at(y1, y2, t) < covered) low = t; else high = t; }
  return at(x1, x2, t);
}

/** What an element is holding right now, so a dismissal can start from a half-played entrance or a drag. */
function poseNow(el: HTMLElement, shape: Pose): Pose {
  const style = getComputedStyle(el);
  const pose: Pose = {};
  for (const key of Object.keys(shape)) pose[key] = style.getPropertyValue(key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)) || shape[key];
  return pose;
}

/**
 * Every layer of the presentation, as the pose it holds while dismissed and the pose it settles on.
 * The settled pose is what the element already carries at rest, so cancelling the timeline when it
 * lands leaves the measured screen with no animation, no transform and its glass intact (a held
 * animation would promote each layer and cut the glass circles off from the backdrop they blur).
 *
 * `translate` and `scale` are used rather than `transform`, so a layer whose measured position is
 * already carried by a fractional `transform` (the action circles, via `subpixel`) keeps it — and so
 * that the collapse, which owns `transform`, composes with this instead of replacing it.
 */
function detailsLayers(content: HTMLElement, blur: HTMLElement | null, scrim: HTMLElement | null, height: number, saturate: string): Layer[] {
  const m = iosDetailsMotion;
  const layers: Layer[] = [];
  const add = (el: HTMLElement | null, from: Pose, to: Pose, duration: number, delay = 0, easing: string = m.ease) => {
    if (el) layers.push({ el, from, to, duration, delay, easing });
  };
  const own = (slot: string) => content.querySelector<HTMLElement>(`:scope > [data-slot="${slot}"]`);
  const each = (slot: string) => Array.from(content.querySelectorAll<HTMLElement>(`:scope > [data-slot="${slot}"]`));
  const cells = () => Array.from(content.querySelectorAll<HTMLElement>(`:scope > [data-slot="details-scroll"] [data-slot="cell"]`));
  // The chrome that both screens share is already on screen, in the same place: it cancels the
  // sheet's rise exactly (same duration, same easing) and morphs out of the nav bar instead.
  const stay = (dy: number) => `0px ${(dy - height).toFixed(3)}px`;

  add(blur,
    { filter: `blur(0px) saturate(${saturate})`, scale: "1" },
    { filter: `blur(${(m.blur / m.backdropScale).toFixed(3)}px) saturate(${saturate})`, scale: String(m.backdropScale) },
    m.sheet);
  add(scrim, { opacity: "0" }, { opacity: "1" }, m.dim, 0, "ease-out");
  add(content, { translate: `0px ${height}px` }, { translate: "0px 0px" }, m.sheet);
  add(own("back"), { translate: stay(0) }, { translate: "0px 0px" }, m.sheet);
  add(own("back"), { opacity: "0" }, { opacity: "1" }, m.dim, 0, "ease-out");
  add(own("avatar"), { translate: stay(iosDetailsMorph.avatar.dy), scale: String(iosDetailsMorph.avatar.scale) }, { translate: "0px 0px", scale: "1" }, m.sheet);
  add(own("name"), { translate: stay(iosDetailsMorph.name.dy), scale: String(iosDetailsMorph.name.scale) }, { translate: "0px 0px", scale: "1" }, m.sheet);
  each("action").forEach((el, index) => add(el, { translate: `0px ${m.actionRise}px` }, { translate: "0px 0px" }, m.actionDuration, m.actionStart + index * m.actionStagger));
  cells().forEach((el, index) => add(el, { translate: `0px ${m.cellRise}px` }, { translate: "0px 0px" }, m.cellDuration, m.cellStart + Math.min(index, m.cellStaggerMax) * m.cellStagger));
  return layers;
}

/** Web Animations, not a rAF loop or a transition, so `document.getAnimations()` can seek a frame. */
function runLayers(layers: Layer[], phase: "enter" | "exit"): Animation[] {
  const m = iosDetailsMotion;
  return layers.map(({ el, from, to, duration, delay, easing }) => phase === "enter"
    ? el.animate([from, to], { duration, delay, easing, fill: "both" })
    // One flat span on the way out, so the shared chrome's counter-translate still cancels the
    // sheet's exactly, and it starts from wherever the layer is now (settled, or mid-drag).
    : el.animate([poseNow(el, from), from], { duration: m.exit, easing: m.exitEase, fill: "both" }));
}

/**
 * The collapse, as paused animations whose clock is the scroll offset in points: one millisecond of
 * timeline per point scrolled, so seeking is `currentTime = scrollTop`. They own `transform` and
 * `opacity`, which composes with the presentation's `translate` / `scale` rather than replacing it,
 * and they exist only while the surface is scrolled — at the top the timeline is cancelled and the
 * measured screen carries no transform at all, exactly as it does with no collapse in the file.
 */
function collapseLayers(content: HTMLElement, pillWidth: number): Layer[] {
  const c = iosDetailsCollapse;
  const layers: Layer[] = [];
  const add = (el: HTMLElement | null, from: Pose, to: Pose, duration: number = c.travel) => {
    if (el) layers.push({ el, from, to, duration, delay: 0, easing: "linear" });
  };
  const own = (slot: string) => content.querySelector<HTMLElement>(`:scope > [data-slot="${slot}"]`);
  const avatar = own("avatar");
  const shadow = avatar ? getComputedStyle(avatar).getPropertyValue("--ios-dt-av-shadow").trim() || "rgba(0,0,0,0.12)" : "";
  add(avatar,
    { transform: "translateY(0px) scale(1)", boxShadow: "0 2px 4px rgba(0,0,0,0)" },
    { transform: `translateY(${iosDetailsMorph.avatar.dy}px) scale(${iosDetailsMorph.avatar.scale})`, boxShadow: `0 2px 4px ${shadow}` });
  add(own("name"),
    { transform: "translateY(0px) scale(1)" },
    { transform: `translateY(${iosDetailsMorph.name.dy}px) scale(${iosDetailsMorph.name.scale})` });
  const pill = own("collapsed-pill");
  if (pill) {
    pill.style.width = `${pillWidth.toFixed(4)}px`;
    pill.style.left = `${(c.pill.centre - pillWidth / 2).toFixed(4)}px`;
    add(pill, { opacity: "0" }, { opacity: "1" });
  }
  Array.from(content.querySelectorAll<HTMLElement>(`:scope > [data-slot="action"]`))
    .forEach(el => add(el, { opacity: "1" }, { opacity: "0" }, c.actionFade));
  return layers;
}

/** Swallows the click a drag would otherwise leave behind on whatever control it started on. */
function swallowClick(node: HTMLElement | null) {
  if (!node) return;
  const swallow = (event: Event) => { event.stopPropagation(); event.preventDefault(); };
  node.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => node.removeEventListener("click", swallow, true), 0);
}

/**
 * What a control does under a finger. Two values, both from the framework rather than from a still —
 * no capture in this repo holds a pressed control, and a screenshot of a resting screen cannot show
 * one:
 *
 * - **A grouped-list row fills.** `-[CKUITheme detailsSelectedCellColor]` read at the **phone** idiom
 *   is **#dcdcdc** light and **#464646** dark (`--ios-dt-press`). It is an opaque replacement fill,
 *   not an overlay: the same property is `conversationListSelectedCellColor`, which the list paints
 *   over a white/black ground while details paints it over `detailsBackgroundColor` #ececec / #1e1e1e.
 *   Read as a delta on the details ground that is −16 light and +40 dark, and this screen's own
 *   measured cell composite (#efeff0 over white, #1c1c1f over black) moves −19 and +42 to reach it —
 *   the same step to within three levels, which is the check that the value belongs on this surface
 *   too. **The Mac disagrees and must not be given this value**: at idiom 5 the same selector returns
 *   #ffc726 / #ffc600, a find-highlight yellow.
 * - **A round button, or a photo tile, dims.** `-[CKUIBehaviorPhone replyButtonTouchAlpha]` is
 *   **0.4**, and every idiom including Mac agrees. It is ChatKit's alpha for a round chrome button
 *   held under a finger, so the glass circles and the back button take it directly; applying it to a
 *   shared-photo tile as well is an extension of that reading, not a second one.
 *
 * UNMEASURED, and marked as such where they are used: `pressFade` (how long the fill takes to leave
 * once the finger lifts — instant on the way in, as a `UITableViewCell`'s selected background is) and
 * `pressSlop` (how far the finger may travel before the highlight is given up to a scroll; 10 pt is
 * `UIScrollView`'s own pan threshold).
 */
export const iosDetailsPress = { touchAlpha: 0.4, pressFade: 200, pressSlop: 10 } as const;

/**
 * Press state driven by pointer events rather than by `:active`.
 *
 * `:active` is not usable here. A `Input.dispatchTouchEvent` hold — a real finger, as far as the
 * engine is concerned — leaves `el.matches(":active")` **false** in Chromium, so a `:active` rule is
 * a press state that a finger never opens; and even where it does latch, it survives a scroll that
 * has already carried the row out from under the finger. Pointer events give both: the flag opens on
 * `pointerdown`, is given up the moment the finger travels `pressSlop`, and is cleared by a
 * `pointerup` or `pointercancel` **anywhere** — a listener on the element alone leaves the highlight
 * stuck on when the finger lifts off the edge of it.
 *
 * Nothing here focuses anything. That is deliberate: both engines match `:focus-visible` on a
 * programmatic focus taken while a pointer is still held, so a press state that focused its own row
 * would draw the ring the captures do not have (`tapback-bar.tsx` and `audio-recorder.tsx` document
 * the same trap). A tap still focuses the button natively, which does *not* match `:focus-visible`.
 */
export function usePressed(enabled = true) {
  const [pressed, setPressed] = useState(false);
  const origin = useRef<{ id: number; x: number; y: number } | null>(null);
  const release = useCallback(() => { origin.current = null; setPressed(false); }, []);
  useEffect(() => {
    if (!pressed) return;
    const off = () => release();
    window.addEventListener("pointerup", off);
    window.addEventListener("pointercancel", off);
    return () => { window.removeEventListener("pointerup", off); window.removeEventListener("pointercancel", off); };
  }, [pressed, release]);
  const handlers = enabled ? {
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      origin.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      setPressed(true);
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const from = origin.current;
      if (!from || from.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > iosDetailsPress.pressSlop) release();
    },
    onPointerUp: release,
    onPointerCancel: release,
    onPointerLeave: release,
  } : {};
  const on = enabled && pressed;
  return { pressed: on, pressAttr: on ? ("" as const) : undefined, handlers };
}

/**
 * The fill a held grouped-list row paints, under the row's own content. It is a sibling of the row's
 * button rather than a child of it, because a row nudges its text by the measured 0.6667 and the fill
 * must stay on the row's own box. The cell clips it, so a first or last row is cut by the measured
 * radius 26 continuous corner and nothing has to know which row it is.
 */
function PressFill({ on }: { on: boolean }) {
  return (
    <span aria-hidden="true" data-slot="row-press" className="pointer-events-none absolute inset-0 motion-reduce:!transition-none"
      style={{ background: "var(--ios-dt-press)", opacity: on ? 1 : 0, transition: on ? "none" : `opacity ${iosDetailsPress.pressFade}ms ease-out` }} />
  );
}

type GlassCircleProps = ComponentProps<"button"> & { size: number; "data-slot"?: string; "data-action"?: string };

function GlassCircle({ size, className, style, children, disabled, ...rest }: GlassCircleProps) {
  // An unavailable action keeps its circle and drops its glyph (measured); it must not dim under a
  // finger either, and it is marked `aria-disabled` rather than `disabled` so it stays focusable.
  const off = Boolean(disabled) || rest["aria-disabled"] === true || rest["aria-disabled"] === "true";
  const { pressed, pressAttr, handlers } = usePressed(!off);
  return (
    <button type="button" data-pressed={pressAttr} disabled={disabled}
      className={cn("absolute flex items-center justify-center rounded-full motion-reduce:!transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]", className)}
      style={{
        width: size, height: size, background: "var(--ios-dt-fill)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
        // `replyButtonTouchAlpha`. Instant in, so the circle is already dim by the time the eye
        // arrives; the fade back out is the unmeasured `pressFade`.
        opacity: pressed ? iosDetailsPress.touchAlpha : 1,
        transition: pressed ? "none" : `opacity ${iosDetailsPress.pressFade}ms ease-out`,
        ...style,
      }}
      {...handlers} {...rest}>
      {children}
    </button>
  );
}

/**
 * SF Symbol stand-ins, drawn at the ink sizes measured inside the Ø54 circles. Ink boxes read off
 * `details-light.png` (mean-intensity edges, so they are good to about a third of a point):
 * phone x 118.0–136.0 y 213.67–231.33, video x 190.0–213.11 y 215.02–230.33, mail x 263.67–286.33
 * y 214.67–230.67. Blink snaps each `<svg>` box to a whole CSS pixel, so glyphs whose centred
 * position lands on a half point carry the remainder in a transform, the way `subpixel` does.
 */
function ActionGlyph({ icon }: { icon: IosDetailsAction["icon"] }) {
  const id = useId();
  if (icon === "phone") {
    // 18.36 wide, not 17: at 17 the ink measures 16.67 across against the capture's 18.0.
    return (
      <svg aria-hidden="true" width="18.36" height="17.3333" viewBox="1.72 1.25 13.5 13.5" fill="currentColor">
        <path d="M3.654 1.328a.678.678 0 0 0-1.015-.063L1.605 2.3c-.483.484-.661 1.169-.45 1.77a17.6 17.6 0 0 0 4.168 6.608 17.6 17.6 0 0 0 6.608 4.168c.601.211 1.286.033 1.77-.45l1.034-1.034a.678.678 0 0 0-.063-1.015l-2.307-1.794a.68.68 0 0 0-.58-.122l-2.19.547a1.75 1.75 0 0 1-1.657-.459L5.482 8.062a1.75 1.75 0 0 1-.46-1.657l.548-2.19a.68.68 0 0 0-.122-.58z" />
      </svg>
    );
  }
  if (icon === "video") {
    // Body 16.33 wide (capture x 190.0–206.33), a 1.17 gap, then the lens wedge: its neck stands on
    // x 17.5 running y 4.60–10.70 and its outer edge on the ink's right, y 1.22–14.08. Both slanted
    // edges measure 0.615 of rise per point across, checked at x 208.0 and x 212.33 top and bottom.
    // The half-point centring is snapped away by Blink, so the third of a point comes back here.
    return (
      <svg aria-hidden="true" width="23" height="15.3333" viewBox="0 0 23 15.3333" fill="currentColor" style={{ transform: "translateY(0.3333px)" }}>
        <rect x="0" y="0" width="16.3333" height="15.3333" rx="3.6" />
        <path d="M17.969 4.312 22.531 1.508Q23 1.22 23 1.77V13.53Q23 14.08 22.531 13.792L17.969 10.988Q17.5 10.7 17.5 10.15V5.15Q17.5 4.6 17.969 4.312Z" />
      </svg>
    );
  }
  // The envelope is a 22.67 × 16 rounded rect crossed by four 0.9 wide creases, read off
  // `details-light.png`: the flap runs corner to corner through (11.33, 10.4), and a short seam
  // rises from each bottom corner to meet the flap's arm at (8.3, 7.7) / (14.37, 7.7).
  return (
    // Centred on 275 a 22.67 wide box starts on 263.667, and Blink snaps both edges inward: the
    // envelope then renders 22.0 across instead of the capture's 263.67–286.33. A whole 23 wide box
    // survives the snap (263.5 rounds to 264), the viewBox insets the 22.67 of artwork inside it,
    // and half a point of transform carries the pair onto the measured edges.
    <svg aria-hidden="true" width="23" height="16" viewBox="-0.1667 0 23 16" style={{ transform: "translateX(-0.5px)" }}>
      <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="22.6667" height="16">
        <rect width="22.6667" height="16" rx="2.6" fill="#ffffff" />
        <path d="M-0.7 0 11.3333 10.4 23.37 0M0 16 8.3 7.7M22.6667 16 14.3667 7.7" fill="none" stroke="#000000" strokeWidth="0.9" />
      </mask>
      <rect width="22.6667" height="16" rx="2.6" fill="currentColor" mask={`url(#${id})`} />
    </svg>
  );
}

/**
 * The disclosure chevron on a row that navigates. The nav bar's measured one: 4.67 × 12.67 of ink
 * on a 2.6 round stroke, in the measured chevron gray (`ios-nav-bar.tsx`). Its box is centred on the
 * row and its ink sits `cell.inset` in from the cell's trailing edge.
 */
function Chevron() {
  return (
    <svg aria-hidden="true" className="absolute" width="8.6667" height="16.6667" viewBox="-2 -2 8.6667 16.6667" fill="none"
      stroke="var(--ios-dt-chevron)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
      style={{ right: cell.inset - 2, top: "50%", transform: "translateY(-50%)" }}>
      <path d="M1.3 1.3 3.37 6.3333 1.3 11.37" />
    </svg>
  );
}

export type IosSwitchProps = Omit<ComponentProps<"button">, "onChange" | "defaultChecked"> & {
  /**
   * Controlled state. **Omit it and the switch keeps its own**, so a consumer that only wants a
   * working switch gets one; hand it a boolean and the consumer owns every change, as React means it.
   */
  checked?: boolean;
  /** Where an uncontrolled switch starts. Ignored while `checked` is given. */
  defaultChecked?: boolean;
  onChange?: (next: boolean) => void;
  label?: string;
};

/**
 * iOS 26 switch: 63×28 track, 37×24 knob inset 2, so the knob travels 22 (measured on the Hide
 * Alerts row of both captures, which show it off).
 *
 * The on colour is not in any capture and is not a guess either: `+[UIColor systemGreenColor]`,
 * resolved for each `UIUserInterfaceStyle` in a Mac Catalyst process with `-[UIDevice
 * userInterfaceIdiom]` swizzled to phone, is #34c759 light and #30d158 dark.
 *
 * Off, the track is the measured composite over this screen's cell fill (`--ios-dt-track`). Away
 * from that cell there is nothing measured to composite against, so it falls back to the framework's
 * `+[UIColor secondarySystemFillColor]` (#787880 at 16% light, 32% dark).
 *
 * It used to be a switch that could not switch: `checked` defaulted to `false`, so a consumer that
 * passed neither a value nor a handler — which is what `IosMessagesApp` does when its caller hands it
 * no `detailsContent` — got a control pinned off, `aria-checked="false"` before the tap and
 * `aria-checked="false"` after it. The default is gone; `checked === undefined` now means
 * uncontrolled, and only a caller that actually passes a boolean owns the state.
 */
export function IosSwitch({ checked, defaultChecked = false, onChange, label, className, style, ...rest }: IosSwitchProps) {
  const [own, setOwn] = useState(defaultChecked);
  const on = checked ?? own;
  const toggle = () => {
    if (checked === undefined) setOwn(!on);
    onChange?.(!on);
  };
  return (
    <button type="button" data-slot="ios-switch" role="switch" aria-checked={on} aria-label={label} onClick={toggle}
      className={cn(
        "relative shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff] motion-reduce:!transition-none",
        "[--ios-sw-on:#34c759] [--ios-sw-off:rgba(120,120,128,0.16)] dark:[--ios-sw-on:#30d158] dark:[--ios-sw-off:rgba(120,120,128,0.32)]",
        className,
      )}
      style={{ width: 63, height: 28, borderRadius: 14, overflow: "hidden", background: on ? "var(--ios-sw-on)" : "var(--ios-dt-track, var(--ios-sw-off))", transition: "background 200ms ease", ...style }}
      {...rest}>
      {/*
        The capture shows no shadow outside the switch at all: one pixel past the track the pixels
        are already the surrounding gradient, and inside the track the knob only darkens it by ~3/255.
        The track therefore clips the knob's shadow, and that shadow is barely there.

        The knob slides: 220 ms on the sheet's own curve, which is a transition on `transform` and so
        is a real interpolation `document.getAnimations()` can be caught mid-flight on, not a jump
        between two committed frames.
      */}
      <span aria-hidden="true" data-slot="ios-switch-knob" className="absolute block motion-reduce:!transition-none" style={{
        left: 2, top: 2, width: 37, height: 24, borderRadius: 12, background: "var(--ios-dt-knob, #ffffff)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.10)",
        transform: `translateX(${on ? 22 : 0}px)`, transition: "transform 220ms cubic-bezier(0.32,0.72,0,1)",
      }} />
    </button>
  );
}

/**
 * Blink snaps a painted box to whole CSS px, so a fill placed straight on a third-of-a-point edge
 * lands a device pixel off at 3x. The fill therefore sits on an integer box and a transform carries
 * the fraction; transforms are composited without snapping. `subpixel` does the same for any element
 * whose measured position is not a whole point.
 */
export function subpixel(top: number): CSSProperties {
  const whole = Math.floor(top);
  return { top: whole, transform: `translateY(${(top - whole).toFixed(4)}px)` };
}

/**
 * The rows sit inside a clip of the cell's own radius, so a held row's fill is cut by the measured
 * corner and no row has to know whether it is the first or the last one.
 *
 * The clip is a wrapper around the rows rather than `overflow: hidden` on the cell itself, and the
 * difference is measurable. Clipping the cell clips `cell-fill` too, and that fill already paints
 * the same superellipse: the hard mask lands on an edge the fill has already antialiased and the
 * corner comes out a shade dark. Over `details-dark.png` that alone took the settled screen from
 * 3136 mismatched pixels to 5862, a ring two device pixels wide on all sixteen corners of the
 * measured stack. With the clip on the rows instead, the fill is untouched and the dark frame is
 * back where it was. Nothing else inside the wrapper reaches a corner — separators are inset the
 * measured 16, and so is every glyph and tile — so the clip costs nothing but the press fill.
 */
function Cell({ top, height, children }: { top: number; height: number; children: ReactNode }) {
  const whole = Math.floor(top);
  const boxHeight = Math.max(1, Math.round(height));
  return (
    <div data-slot="cell" className="absolute" style={{ left: cell.left, top, width: cell.width, height }}>
      <span aria-hidden="true" data-slot="cell-fill" className="absolute" style={{
        left: 0, top: whole - top, width: cell.width, height: boxHeight, borderRadius: cell.radius,
        background: "var(--ios-dt-fill)", transformOrigin: "0 0",
        transform: `translateY(${(top - whole).toFixed(4)}px) scaleY(${(height / boxHeight).toFixed(5)})`,
        ...continuous,
      }} />
      <div data-slot="cell-clip" className="absolute inset-0" style={{ borderRadius: cell.radius, overflow: "hidden", ...continuous }}>
        {children}
      </div>
    </div>
  );
}

/** The measured hairline: 1pt at a row boundary, inset to x 32–370. */
function Separator({ top }: { top: number }) {
  return (
    <span aria-hidden="true" data-slot="separator" className="absolute"
      style={{ left: cell.inset, right: cell.inset, top: top - 1.3333, transform: "translateY(0.3333px)", height: 1, background: "var(--ios-dt-separator)" }} />
  );
}

const rowFocus = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0088ff]";
/** Row text is 17pt (measured); a second line is 13pt (measured, the phone cell's small label). */
const titleType: CSSProperties = { fontSize: 17, lineHeight: "22px", color: "var(--ios-dt-label)" };
const detailType: CSSProperties = { fontSize: 13, lineHeight: "16px", color: "var(--ios-dt-secondary)" };
const clip: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

/**
 * A shared group's header row: the section's name, how many it holds, and a chevron. The whole 52pt
 * row is the hit target when it navigates, and it is a plain heading when it does not. UNMEASURED.
 */
function SectionHeader({ title, count, onOpen }: { title: string; count?: number | string; onOpen?: () => void }) {
  const { pressed, pressAttr, handlers } = usePressed(Boolean(onOpen));
  const body = (
    <>
      <span style={{ ...titleType, ...clip }}>{title}</span>
      {count !== undefined && (
        <span data-slot="section-count" style={{ ...titleType, color: "var(--ios-dt-secondary)", marginLeft: "auto", marginRight: onOpen ? 8 : 0 }}>{count}</span>
      )}
      {onOpen && <Chevron />}
    </>
  );
  const style: CSSProperties = { paddingLeft: cell.inset, paddingRight: cell.inset + (onOpen ? 14 : 0), transform: "translateY(0.6667px)" };
  return (
    <div className="absolute" style={{ left: 0, right: 0, top: 0, height: cell.row }}>
      {onOpen && <PressFill on={pressed} />}
      {onOpen
        ? <button type="button" data-slot="section-header" data-pressed={pressAttr} onClick={onOpen} className={cn("absolute inset-0 flex items-center text-left", rowFocus)} style={style} {...handlers}>{body}</button>
        : <h2 data-slot="section-header" className="absolute inset-0 m-0 flex items-center font-normal" style={style}>{body}</h2>}
    </div>
  );
}

/**
 * One row of a shared links or shared attachments list. Two lines keep the measured phone cell's
 * three gaps with its 17pt and 13pt lines swapped, so the row is the measured 70.67 tall; a row with
 * no second line is the measured 52. UNMEASURED.
 */
function ItemRow({ item, top, height }: { item: IosDetailsItem; top: number; height: number }) {
  const { pressed, pressAttr, handlers } = usePressed(Boolean(item.onPress));
  const twoLine = item.detail !== undefined;
  const pad = cell.inset + (item.onPress ? 14 : 0);
  const body = twoLine ? (
    <>
      <span className="absolute" style={{ left: cell.inset, right: pad, top: twoLineRow.title, ...titleType, ...clip }}>{item.title}</span>
      <span className="absolute" style={{ left: cell.inset, right: pad, top: twoLineRow.detail, ...detailType, ...clip }}>{item.detail}</span>
      {item.onPress && <Chevron />}
    </>
  ) : (
    <>
      <span style={{ ...titleType, ...clip }}>{item.title}</span>
      {item.onPress && <Chevron />}
    </>
  );
  const style: CSSProperties = twoLine
    ? { transform: "translateY(0.6667px)" }
    : { paddingLeft: cell.inset, paddingRight: pad, transform: "translateY(0.6667px)" };
  return (
    <div className="absolute" style={{ left: 0, right: 0, top, height }}>
      {item.onPress && <PressFill on={pressed} />}
      {/* Every item row sits under a row: the header above the first one, an item above the rest.
          The hairline stays over the fill, the way a held cell's separator does natively. */}
      <Separator top={0} />
      {item.onPress
        ? <button type="button" data-slot="detail-row" data-pressed={pressAttr} onClick={item.onPress} className={cn("absolute inset-0 text-left", !twoLine && "flex items-center", rowFocus)} style={style} {...handlers}>{body}</button>
        : <div data-slot="detail-row" className={cn("absolute inset-0", !twoLine && "flex items-center")} style={style}>{body}</div>}
    </div>
  );
}

/** How tall a shared group's cell is, given what it holds. UNMEASURED; see the header. */
function photosHeight(section: IosDetailsSection<IosDetailsPhoto>) {
  const rows = Math.max(1, Math.ceil(section.items.length / grid.columns));
  return cell.row + cell.inset + rows * tile + (rows - 1) * grid.gap + cell.inset;
}
function listHeight(section: IosDetailsSection<IosDetailsItem>) {
  return cell.row + section.items.reduce((total, item) => total + (item.detail === undefined ? cell.row : cell.twoLine), 0);
}

/** A tile of the shared grid. It dims under a finger at the framework's `replyButtonTouchAlpha`. */
function PhotoTile({ photo, label, box, media }: { photo: IosDetailsPhoto; label: string; box: CSSProperties; media: ReactNode }) {
  const { pressed, pressAttr, handlers } = usePressed();
  return (
    <button type="button" data-slot="photo" data-pressed={pressAttr} aria-label={label} onClick={photo.onPress}
      className={cn("absolute overflow-hidden motion-reduce:!transition-none", "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]")}
      style={{ ...box, opacity: pressed ? iosDetailsPress.touchAlpha : 1, transition: pressed ? "none" : `opacity ${iosDetailsPress.pressFade}ms ease-out` }}
      {...handlers}>
      {media}
    </button>
  );
}

function PhotosCell({ section, top }: { section: IosDetailsSection<IosDetailsPhoto>; top: number }) {
  return (
    <Cell top={top} height={photosHeight(section)}>
      <SectionHeader title={section.title ?? "Photos"} count={section.count ?? section.items.length} onOpen={section.onOpen} />
      <Separator top={cell.row} />
      {section.items.map((photo, index) => {
        const column = index % grid.columns;
        const row = Math.floor(index / grid.columns);
        const box: CSSProperties = {
          left: cell.inset + column * (tile + grid.gap),
          top: cell.row + cell.inset + row * (tile + grid.gap),
          width: tile, height: tile, borderRadius: grid.radius, background: "var(--ios-dt-fill)",
        };
        const label = photo.alt ?? `Photo ${index + 1}`;
        const media = photo.node ?? (photo.src
          // eslint-disable-next-line @next/next/no-img-element -- registry components stay framework-neutral
          ? <img src={photo.src} alt="" className="size-full object-cover" draggable={false} />
          : null);
        return photo.onPress
          ? <PhotoTile key={photo.id} photo={photo} label={label} box={box} media={media} />
          : (
            <span key={photo.id} data-slot="photo" role="img" aria-label={label} className="absolute block overflow-hidden" style={box}>
              {media}
            </span>
          );
      })}
    </Cell>
  );
}

/** One of the second cell's blue rows ("Create New Contact"). It fills while it is held. */
function LinkRow({ link, top, separated }: { link: { id: string; label: string; onPress?: () => void }; top: number; separated: boolean }) {
  const { pressed, pressAttr, handlers } = usePressed();
  return (
    <div className="absolute" style={{ left: 0, right: 0, top, height: cell.row }}>
      <PressFill on={pressed} />
      {separated && <Separator top={0} />}
      <button type="button" data-slot="link" data-pressed={pressAttr} onClick={link.onPress}
        className={cn("absolute inset-0 flex items-center text-left", rowFocus)}
        style={{ paddingLeft: cell.inset, fontSize: 17, lineHeight: "22px", transform: "translateY(0.6667px)", color: "var(--ios-dt-blue)" }}
        {...handlers}>
        {link.label}
      </button>
    </div>
  );
}

/** The destructive row. Its own cell, so the fill is cut by all four of the measured corners. */
function BlockRow({ label, onPress }: { label: string; onPress?: () => void }) {
  const { pressed, pressAttr, handlers } = usePressed();
  return (
    <>
      <PressFill on={pressed} />
      <button type="button" data-slot="block" data-pressed={pressAttr} onClick={onPress}
        className={cn("absolute inset-0 flex items-center text-left", rowFocus)}
        style={{ paddingLeft: cell.inset, fontSize: 17, lineHeight: "22px", transform: "translateY(0.6667px)", color: "var(--ios-dt-red)" }}
        {...handlers}>
        {label}
      </button>
    </>
  );
}

function ListCell({ section, title, top }: { section: IosDetailsSection<IosDetailsItem>; title: string; top: number }) {
  // The rows stack under the header, each one as tall as it needs: 52 with one line, 70.67 with two.
  const rows: Array<{ item: IosDetailsItem; top: number; height: number }> = [];
  section.items.reduce<number>((cursor, item) => {
    const height = item.detail === undefined ? cell.row : cell.twoLine;
    rows.push({ item, top: cursor, height });
    return cursor + height;
  }, cell.row);
  return (
    <Cell top={top} height={listHeight(section)}>
      <SectionHeader title={section.title ?? title} count={section.count ?? section.items.length} onOpen={section.onOpen} />
      {rows.map(row => <ItemRow key={row.item.id} item={row.item} top={row.top} height={row.height} />)}
    </Cell>
  );
}

export function IosDetails({
  name, initials, avatar, phoneLabel = "phone", phone, tag, actions = [], links = [],
  // No `= false` here: that default is what made the switch uncontrolled-but-pinned. `undefined`
  // has to reach `IosSwitch` for it to keep its own state.
  hideAlerts, defaultHideAlerts, onHideAlertsChange, hideAlertsLabel = "Hide Alerts",
  blocked, defaultBlocked = false, blockLabel = "Block Contact", unblockLabel = "Unblock Contact", onBlock,
  photos, sharedLinks, attachments,
  onBack, backdrop, progress, scroll, open = true, onExited, className, style, ...props
}: IosDetailsProps) {
  const letters = initials ?? name.trim().split(/\s+/).slice(0, 2).map(p => p[0] ?? "").join("").toUpperCase();
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const nameInk = useRef<HTMLSpanElement>(null);
  const blur = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const timeline = useRef<Animation[] | null>(null);
  const collapse = useRef<Animation[] | null>(null);
  const scrolled = useRef(0);
  const landed = useRef(false);
  const exited = useRef(onExited);
  useEffect(() => { exited.current = onExited; }, [onExited]);

  // The dismissal is derived during render, not in an effect: an effect leaves one committed frame
  // with the screen already gone, and the exit never runs. `closing` also separates a screen that is
  // leaving (fire `onExited`, stop taking clicks) from one mounted closed, which just sits dismissed.
  // Uncontrolled unless the caller states it, the same contract `IosSwitch` documents.
  const [ownBlocked, setOwnBlocked] = useState(defaultBlocked);
  const isBlocked = blocked ?? ownBlocked;
  const [seenOpen, setSeenOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  if (seenOpen !== open) { setSeenOpen(open); setClosing(!open); }

  // Whether the surface is off the top, derived during render for a seeked scroll and kept in state
  // for a live one. The collapsed pill only exists while it is true, so the screen at rest is the
  // measured one with nothing extra painted over it.
  const [liveCollapsing, setLiveCollapsing] = useState(false);
  const collapsing = scroll !== undefined ? scroll > 0 : liveCollapsing;

  const build = (phase: "enter" | "exit"): Animation[] | null => {
    const node = content.current;
    const box = root.current;
    if (!node || !box) return null;
    const height = box.getBoundingClientRect().height;
    if (!height) return null;
    const saturate = getComputedStyle(box).getPropertyValue("--ios-dt-saturate").trim() || "1";
    return runLayers(detailsLayers(node, blur.current, scrim.current, height, saturate), phase);
  };
  const land = (list: Animation[]) => {
    if (timeline.current !== list) return;
    list.forEach(stop);
    timeline.current = null;
    landed.current = true;
  };

  /**
   * The collapse follows the scroll offset with no animation of its own: build the layers if the
   * surface has left the top, then seek them to the offset. Back at the top the timeline is dropped,
   * which is what keeps the measured screen free of a composited transform.
   */
  const seekCollapse = (top: number) => {
    scrolled.current = top;
    const node = content.current;
    if (!node) return;
    if (top <= 0) { collapse.current?.forEach(stop); collapse.current = null; return; }
    let list = collapse.current;
    if (!list) {
      const back = node.querySelector<HTMLElement>(`:scope > [data-slot="back"]`);
      const title = node.querySelector<HTMLElement>(`:scope > [data-slot="name"]`);
      const ink = nameInk.current;
      // The back button is Ø44 on both screens and the collapse never scales it, so its box is the
      // ruler that turns whatever scale an embedding applies back into points. The name's own scale
      // comes off its computed style, because a half-played entrance is still holding one.
      const unit = back ? back.getBoundingClientRect().width / 44 : 1;
      const nameScale = (title && parseFloat(getComputedStyle(title).scale)) || 1;
      const inkWidth = ink && unit ? ink.getBoundingClientRect().width / unit / nameScale : 0;
      const c = iosDetailsCollapse;
      list = collapseLayers(node, inkWidth * iosDetailsMorph.name.scale + c.pill.padLeft + c.pill.padRight)
        .map(({ el, from, to, duration, easing }) => el.animate([from, to], { duration, easing, fill: "both" }));
      collapse.current = list;
    }
    seekTo(list, Math.min(top, iosDetailsCollapse.travel));
  };

  // Only unmount cancels the timeline. The two phases hand over to each other without one, so a
  // dismissal can read the pose the entrance, or a drag, is still holding.
  useEffect(() => () => {
    timeline.current?.forEach(stop); timeline.current = null;
    collapse.current?.forEach(stop); collapse.current = null;
  }, []);

  useLayoutEffect(() => {
    if (prefersReducedMotion()) { landed.current = true; return; }
    const previous = timeline.current;
    const next = build(open ? "enter" : "exit");
    previous?.forEach(stop);
    timeline.current = next;
    landed.current = false;
    // One rebuild per phase, and `build` only reads refs.
  }, [open]);

  useLayoutEffect(() => {
    // Reduced motion: the screen is simply there, and leaves at once. Its resting styles are the
    // settled pose, so there is nothing to undo.
    if (prefersReducedMotion()) { if (!open && closing) exited.current?.(); return; }
    const list = timeline.current ?? build(open ? "enter" : "exit");
    if (!list) return;
    timeline.current = list;
    const total = open ? iosDetailsMotion.enter : iosDetailsMotion.exit;
    if (progress !== undefined) {
      const time = clamp01(progress) * total;
      seekTo(list, time);
      // A settled checkpoint is screenshotted, so drop the timeline there and let the glass breathe.
      if (open && time >= total) land(list);
      return;
    }
    // Mounted closed rather than closing: hold the dismissed pose instead of playing a dismissal.
    if (!open && !closing) { seekTo(list, total); return; }
    let dropped = false;
    list.forEach(animation => animation.play());
    Promise.allSettled(list.map(animation => animation.finished)).then(() => {
      if (dropped) return;
      if (open) land(list);
      else if (closing && timeline.current === list) exited.current?.();
    });
    return () => { dropped = true; };
  }, [open, progress, closing]);

  // The collapse is rebuilt whenever the pill comes or goes, and re-seeked whenever the offset is
  // handed in rather than scrolled. Both paths end in the same paused, seeked timeline.
  useLayoutEffect(() => {
    collapse.current?.forEach(stop);
    collapse.current = null;
    if (scroll !== undefined && scroller.current) scroller.current.scrollTop = scroll;
    seekCollapse(scroll ?? scrolled.current);
    // `seekCollapse` only reads refs; the offset and the pill's presence are the whole input.
  }, [collapsing, scroll]);

  const onScroll = (event: ReactUIEvent<HTMLDivElement>) => {
    if (scroll !== undefined) return;
    const top = event.currentTarget.scrollTop;
    seekCollapse(top);
    if (top > 0 !== liveCollapsing) setLiveCollapsing(top > 0);
  };

  // The screen covers the conversation, so Escape backs out of it the way the back button does.
  useEffect(() => {
    if (!open || !onBack) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onBack(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onBack]);

  /**
   * Drag down to dismiss. It seeks the entrance backwards rather than writing its own styles, so a
   * half-dragged screen is the same pose as a half-played entrance: the blur, the scrim, the sheet
   * and the header morph all follow the finger together. Released short of the threshold, it plays
   * the rest of the entrance forward from where it is. It only starts at the top of the list, so a
   * drag anywhere below that scrolls instead, the way it does natively.
   */
  const drag = useRef<{ id: number; from: number; last: number; at: number; velocity: number; live: boolean } | null>(null);
  const playIn = () => {
    const list = timeline.current;
    if (!list) return;
    list.forEach(animation => animation.play());
    Promise.allSettled(list.map(animation => animation.finished)).then(() => land(list));
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!open || closing || progress !== undefined || !onBack || !landed.current || prefersReducedMotion()) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((scroller.current?.scrollTop ?? 0) > 0) return;
    drag.current = { id: event.pointerId, from: event.clientY, last: event.clientY, at: event.timeStamp, velocity: 0, live: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.id) return;
    const dy = event.clientY - state.from;
    if (!state.live) {
      // A tap, or a drag back up, leaves the controls alone.
      if (dy < 8) return;
      state.live = true;
      event.currentTarget.setPointerCapture(state.id);
      const list = timeline.current ?? build("enter");
      if (list) { timeline.current = list; seekTo(list, iosDetailsMotion.enter); }
    }
    const elapsed = event.timeStamp - state.at;
    if (elapsed > 0) state.velocity = (event.clientY - state.last) / elapsed;
    state.last = event.clientY;
    state.at = event.timeStamp;
    // The sheet rises by the frame's own height, so tracking the finger means seeking to wherever
    // the rise stands `1 - dy / height` of the way up.
    const height = root.current?.getBoundingClientRect().height || 1;
    const back = riseSeek(clamp01(1 - dy / height)) * iosDetailsMotion.sheet;
    if (timeline.current) seekTo(timeline.current, back);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.id) return;
    drag.current = null;
    if (!state.live) return;
    swallowClick(root.current);
    const dy = event.clientY - state.from;
    // Ask for the dismissal first: the exit builds from the pose this drag is holding. Then play the
    // entrance back in, which springs the screen home if the consumer does not take the dismissal.
    if (dy > iosDetailsMotion.dragCommit || state.velocity > iosDetailsMotion.dragVelocity) onBack?.();
    playIn();
  };

  // The stack, in order. With no shared content it is the four measured cells on their measured
  // tops; each group that is present pushes the ones under it down by its height plus the measured
  // 20, and Block Contact stays last.
  const groups: ReactNode[] = [];
  let cursor = cell.top;
  const place = (height: number, render: (top: number) => ReactNode) => {
    groups.push(render(cursor));
    cursor += height + cell.gap;
  };
  if (phone !== undefined) {
    place(cell.twoLine, top => (
      <Cell key="phone" top={top} height={cell.twoLine}>
        <span data-slot="phone-label" className="absolute" style={{ left: cell.inset, top: 16.875, fontSize: 13, lineHeight: "16px", transform: "translateY(-0.6667px)", color: "var(--ios-dt-secondary)" }}>{phoneLabel}</span>
        <span data-slot="phone-value" className="absolute" style={{ left: cell.inset, top: 34.375, fontSize: 17, lineHeight: "22px", color: "var(--ios-dt-label)" }}>{phone}</span>
        {tag && (
          <span data-slot="tag" className="absolute flex items-center justify-center"
            style={{ left: 312.3333, top: 19.3333, transform: "translateY(0.3333px)", width: 41, height: 11.3333, borderRadius: 3.5, background: "var(--ios-dt-tag)", color: "var(--ios-dt-tag-label)", fontSize: 8.5, lineHeight: 1, fontWeight: 700, letterSpacing: 0 }}>
            {tag}
          </span>
        )}
      </Cell>
    ));
  }
  if (links.length > 0) {
    place(links.length * cell.row, top => (
      <Cell key="links" top={top} height={links.length * cell.row}>
        {links.map((link, index) => (
          <LinkRow key={link.id} link={link} top={index * cell.row} separated={index > 0} />
        ))}
      </Cell>
    ));
  }
  place(cell.row, top => (
    <Cell key="hide-alerts" top={top} height={cell.row}>
      {/* No press fill: a table cell whose accessory is a switch takes `selectionStyle .none`, and
          the row is not a button — only the switch is. */}
      <div className="absolute inset-0 flex items-center justify-between" style={{ paddingLeft: cell.inset, paddingRight: 14 }}>
        <span data-slot="hide-alerts-label" style={{ ...titleType, transform: "translateY(0.6667px)" }}>{hideAlertsLabel}</span>
        <IosSwitch checked={hideAlerts} defaultChecked={defaultHideAlerts} onChange={onHideAlertsChange} label={hideAlertsLabel} style={{ transform: "translateY(0.3333px)" }} />
      </div>
    </Cell>
  ));
  if (photos && photos.items.length > 0) place(photosHeight(photos), top => <PhotosCell key="photos" section={photos} top={top} />);
  if (sharedLinks && sharedLinks.items.length > 0) place(listHeight(sharedLinks), top => <ListCell key="shared-links" section={sharedLinks} title="Links" top={top} />);
  if (attachments && attachments.items.length > 0) place(listHeight(attachments), top => <ListCell key="attachments" section={attachments} title="Attachments" top={top} />);
  place(cell.row, top => (
    <Cell key="block" top={top} height={cell.row}>
      <BlockRow label={isBlocked ? unblockLabel : blockLabel} onPress={() => { if (blocked === undefined) setOwnBlocked(!isBlocked); onBlock?.(!isBlocked); }} />
    </Cell>
  ));
  // The page ends 20 below the last group: the measured gap, used as the bottom inset.
  const pageHeight = cursor;

  return (
    <div ref={root} data-slot="ios-details" data-state={open ? "open" : "closing"}
      data-progress={progress === undefined ? undefined : clamp01(progress).toFixed(3)}
      role="dialog" aria-modal="true" aria-labelledby={titleId}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
      className={cn("relative isolate size-full select-none overflow-hidden", vars, className)}
      style={{ fontFamily: font, ...style }} {...props}>
      {/*
        The morphing avatar and title *are* the nav bar's, moving. The backdrop draws the whole
        conversation behind, its own nav bar included, so at progress 0 - where the morph starts
        exactly on top of the pill, and where the backdrop's blur has not come up yet - the name was
        painted twice within 0.2 pt of itself, at two different sizes, and read as a smear. UIKit
        hides a morph's source view for the length of the transition; this is that, in one rule.
        Scoped to the backdrop, which is `aria-hidden` and inert either way.
      */}
      <style>{`[data-slot="ios-details"] [data-slot="backdrop"] [data-slot="ios-nav-bar"] :is([data-slot="name"],[data-slot="avatar"]){visibility:hidden}`}</style>
      {backdrop !== undefined && (
        <div aria-hidden="true" data-slot="backdrop" className="absolute inset-0 -z-10 overflow-hidden">
          {/*
            Blurring a box larger than the screen keeps the filter's own edge falloff off-screen, and
            the same box takes the sheet's push-back: 60 of overhang is more than the 4% ever needs,
            so no edge of the conversation comes into view. The blur is divided by that scale, so
            what lands on screen is the measured σ18 either way.
          */}
          <div ref={blur} data-slot="details-blur" className="absolute"
            style={{ inset: -60, background: "var(--ios-dt-page)", scale: String(iosDetailsMotion.backdropScale), filter: `blur(${(iosDetailsMotion.blur / iosDetailsMotion.backdropScale).toFixed(3)}px) saturate(var(--ios-dt-saturate))` }}>
            <div className="absolute" style={{ inset: 60 }}>{backdrop}</div>
          </div>
          <div ref={scrim} data-slot="details-scrim" className="absolute inset-0" style={{ background: "var(--ios-dt-scrim)" }} />
        </div>
      )}

      {/* At rest the wrapper carries no transform: a transform node makes Chrome snap descendants to
          whole CSS px, and the entrance is cancelled the moment it lands for exactly that reason. */}
      <div ref={content} data-slot="details-content" className="absolute inset-0"
        style={closing ? { pointerEvents: "none" } : undefined}>
        {/* The cells scroll; the header above them does not, it collapses. With only the measured
            stack the page is shorter than the screen, so there is nothing to scroll and nothing to
            collapse, and the frame is the capture's. */}
        <div ref={scroller} data-slot="details-scroll" className="absolute inset-0" onScroll={onScroll}
          style={{ overflowY: scroll === undefined ? "auto" : "hidden", overscrollBehavior: "contain" }}>
          <div data-slot="details-page" className="relative" style={{ height: pageHeight }}>{groups}</div>
        </div>

        {/*
          The action circles come AFTER the scroll surface, with the rest of the header. They used to
          come before it, and `details-scroll` is `absolute inset-0` — the full screen — so it covered
          all three of them: a finger on Call landed on the scroller and the button was never pressed
          at all, which is exactly what driving one measured (no press, no click, no anything). Here
          they are part of the header the cells pass under, which is also what `iosDetailsCollapse`
          already assumed when it fades them out by the scroll that reaches their measured top.
        */}
        {actions.map((action, index) => (
          <GlassCircle key={action.id} size={54} data-slot="action" data-action={action.id} aria-label={action.label}
            aria-disabled={action.disabled || undefined} onClick={action.disabled ? undefined : action.onPress}
            style={{ ...subpixel(195.6667), left: 100 + index * 74, color: action.disabled ? "var(--ios-dt-glyph-off)" : "var(--ios-dt-glyph)", mixBlendMode: action.disabled ? "var(--ios-dt-glyph-blend)" as CSSProperties["mixBlendMode"] : undefined }}>
            <ActionGlyph icon={action.icon} />
          </GlassCircle>
        ))}

        {collapsing && (
          // The nav bar's own glass, under the name once the header has collapsed into it: measured
          // fill, rim and shadow from `ios-nav-bar.tsx`. Its width is the name's, so it is only in
          // the tree while the collapse is running.
          <span aria-hidden="true" data-slot="collapsed-pill" className="pointer-events-none absolute" style={{
            top: iosDetailsCollapse.pill.top, height: iosDetailsCollapse.pill.height, borderRadius: iosDetailsCollapse.pill.radius,
            opacity: 0, background: "var(--ios-dt-glass)", boxShadow: "var(--ios-dt-glass-rim), var(--ios-dt-glass-shadow)",
            backdropFilter: `blur(${iosDetailsCollapse.blur}px)`, WebkitBackdropFilter: `blur(${iosDetailsCollapse.blur}px)`,
            ...continuous,
          }} />
        )}

        <div aria-hidden="true" data-slot="avatar" className="absolute flex items-center justify-center overflow-hidden rounded-full text-white"
          style={{ left: 161, top: 62, width: 80, height: 80, fontSize: 37.5, lineHeight: 1, fontWeight: 650, background: "linear-gradient(var(--ios-dt-av-top), var(--ios-dt-av-bottom))" }}>
          {avatar ?? letters}
        </div>

        <h1 id={titleId} data-slot="name" className="absolute m-0 whitespace-nowrap text-center"
          style={{ left: 0, right: 0, top: 146.15, fontSize: 28, lineHeight: "33px", fontWeight: 700, letterSpacing: 0, color: "var(--ios-dt-label)" }}>
          <span ref={nameInk}>{name}</span>
        </h1>

        <GlassCircle size={44} data-slot="back" aria-label="Back" onClick={onBack} style={{ left: 16, top: 62 }}>
          <svg aria-hidden="true" width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="var(--ios-dt-glyph)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M24.8 13.87 16.2 22.17 24.8 30.47" />
          </svg>
        </GlassCircle>
      </div>
    </div>
  );
}
