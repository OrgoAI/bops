"use client";

import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { emojiFontStack, fontStack } from "@/components/message-ui/tokens";

/**
 * The iOS 26 sticker picker: the sheet the plus menu's "Stickers" row opens, its category strip, its
 * grid, and the drag of a sticker out of the sheet and onto a bubble.
 *
 * ## Where the numbers come from
 *
 * **1. A capture of the surface itself.** `references/ios/captures/sticker-picker-light.png`
 * (402x874 @3x, iOS 26.0 simulator, iPhone 17 Pro, light). It is not a screen recording of Messages:
 * the card is drawn out of process by `com.apple.StickerKit.StickerPickerService`, so the capture was
 * made by standing the picker up in a throwaway simulator app —
 * `[[NSClassFromString(@"_UIStickerPickerViewController") alloc] init]`, `setSourceView:` /
 * `setSourceRect:` on a stand-in for the composer's `+`, then `presentCard` — and screenshotting with
 * `xcrun simctl io booted screenshot`. UIKit presents it through `_UIFormSheetPresentationController`,
 * and *that presentation* is what the sheet numbers below measure. The card's own contents (the
 * title, the close button, the category strip, the empty state) are StickerKit's, byte for byte the
 * ones Messages hosts, because they are the same remote view controller.
 *
 * What the capture settles, and what the previous version of this file got wrong:
 *
 * - The picker is **not** the plus menu's own 322.67 x 460.67 glass box. It is a full-width sheet
 *   inset 3.1667 from the screen's left, right and bottom edges, 395.6667 x 456.6667, top at 414.1667,
 *   over a backdrop dimmed by exactly 20% black.
 * - The category strip is at the **top**, under a title row, not pinned to the bottom.
 * - There is a title ("Stickers") and a round close button. There is **no search field** and no
 *   grabber.
 * - The selected category sits on a 43.3333 rounded-square chip, and the strip ends with an `EDIT`
 *   pill rather than another category.
 *
 * | Part | Measured | How |
 * |---|---|---|
 * | sheet inset 3.1667 (l/r/b) | 3.163 / 3.195 / 3.194 | sub-pixel coverage of the one transition pixel on each edge |
 * | sheet top 414.1667 | 414.122 | same, on the centre column |
 * | sheet 395.6667 x 456.6667 | | 402 - 2x3.1667, 874 - 414.1667 - 3.1667 |
 * | top corners R 40.4167 | superellipse n 2.204, rms 0.70 device px | 116 sub-pixel boundary points on the top-left arc |
 * | bottom corners R 60.3333 | same fit, rms 1.00 | 158 points; 62.9 (the iPhone 17 Pro display corner) - 3.1667 = 59.73, so the bottom is concentric with the device |
 * | backdrop dim: black at 0.20 | exact | four known patches behind the sheet: 255→204, 128→102, 0→0, (255,0,0)→(204,0,0) |
 * | sheet glass: white at 0.569 | | the card reads a flat 233 over a backdrop of 204 |
 * | header 63 tall, its row centred at 31.3333 | | the title's ink y 439.0-452.0 and the close button's centre both land on 445.5 |
 * | title ink x 170.0-232.0, centred on 201 | | screen centre; 13.0 of ink height, which is 17pt semibold |
 * | close button Ø 43.3333 centred (361.1667, 445.5) | ±1 | its fill is only 4/255 off the card, fitted from the bottom edge and two chords |
 * | close glyph 16.3333 square | | the X's ink box |
 * | strip 43.3333 tall, first chip's left edge 9.6667 in from the sheet | | chip y 477.1667-520.5, x 12.8333-56.1667 |
 * | chip 43.3333 square, pitch 51.3333 (43.3333 + 8) | | chip centres at x 34.5, 85.83, (137.17), 188.17 |
 * | chip corner R 14.3333 | superellipse n 2.204, rms 0.68 device px | 40 boundary points on the chip's top-left arc |
 * | chip and EDIT pill fill `rgba(118,118,128,0.12)` | exact | over a card of (237,230,230) it predicts (222.8,216.6,217.8); measured (222,217,218). That is `+[UIColor tertiarySystemFillColor]`. |
 * | selected glyph `#000000`, everything else `rgba(60,60,67,0.6)` | | the unselected smiley's core reads (130,128,132) against a predicted (129.2,129.2,133.4). That is `+[UIColor secondaryLabelColor]`. |
 * | category glyph Ø 21.6667, stroke 2.3333 | | the clock and smiley outlines |
 * | pack artwork 23 tall | | both pack icons occupy y 487.333-510.333 exactly |
 * | EDIT pill 45 x 20 | | x 223.5-268.5, y 488.83-508.83 |
 *
 * **2. ChatKit, read natively on iOS rather than through a Catalyst swizzle.** The same throwaway
 * simulator app `dlopen`s `/System/Library/PrivateFrameworks/ChatKit.framework/ChatKit` inside the
 * iOS 26 runtime, where `-[UIDevice userInterfaceIdiom]` really is `.phone` and
 * `+[CKUIBehavior sharedBehaviors]` really vends `CKUIBehaviorPhone` — so nothing here depends on a
 * swizzle holding. Every value below names the selector it came from:
 *
 * | Value | Selector |
 * |---|---|
 * | grid inset 8 on four sides | `attachmentBrowserGridSectionInset` = `{8, 8, 8, 8}` |
 * | grid gaps 4 | `attachmentBrowserGridInterItemSpacing`, `attachmentBrowserGridMinimumLineSpacing` |
 * | grid cell 72.5 x 72.5 | `attachmentBrowserDefaultSizeForSquare` |
 * | cell corner 8 | `stickersCellCornerRadius` |
 * | a landed sticker is 48 x 48 | `stickerReactionSize`, and `emojiStickerTranscriptBalloonSize` for an emoji one |
 * | landed rotation 3 to 10 degrees | `minStickerReactionRotation` / `maxStickerReactionRotation` |
 * | stacked landings overlap 25% across and 35% down, odd rows inset 9.6 | `stickerReactionHorizontalOverlapPercentage`, `stickerReactionVerticalOverlapPercentage`, `stickerReactionOddRowInset` |
 * | the carried sticker shrinks to 5/7 | `-[CKBrowserDragStickerView animateScaleDown]`, read off the layer: a `CASpringAnimation` on `transform.scale.xy`, `fromValue` 1, `toValue` 0.7142857142857143, `duration` 0.91, `speed` 0.8 (so 1137.5 ms of wall clock), `fillMode` forwards |
 * | drag easing cubic-bezier(0.14028, 0.004662, 0.57534, 0.96737) | that animation's `timingFunction`, which `+[CKBrowserDragStickerView springAnimationWithKeyPath:speed:]` installs (damping 400, stiffness 300, mass 2 — overdamped, so `settlingDuration` returns FLT_MAX and the 0.91 duration is the whole of it) |
 * | the carry is elastic, not rigid | the five `CKElasticFunction`s `attachElasticEffectsForLocation:` builds: position x and y tension 550 friction 20, rotation tension 350 friction 15, scale x and y tension 350 friction 20 |
 *
 * A `CKElasticFunction` is a tension/friction spring (`x'' = -T(x - input) - F x'`), so those
 * constants are the whole motion: position lands at omega 23.45 rad/s and zeta 0.426, rotation at
 * 18.71 and 0.401, scale at 18.71 and 0.535. All three are underdamped — the carried sticker lags the
 * finger and overshoots, which is what "elastic" means here, and it is why this file integrates a
 * spring instead of writing the pointer straight into a transform.
 *
 * **The 1.4x lift the previous version drew does not exist.** `-[CKBrowserDragStickerView
 * dragViewScaleUp]` returns 1 whenever the rasterised image is at least as big as the drag view's
 * initial size, which is the ordinary case (measured: `initialSize` {72,72}, `rasterizedImageSize`
 * {72,72}, `dragViewScaleUp` 1, `initialScale` 1). The only scale ChatKit applies is the shrink to
 * 5/7 above. So the sticker lifts at its tile size and gets *smaller*, not bigger.
 *
 * ## What is still not measured
 *
 * - **The grid itself.** Recents was empty in every capture, so no frame of this repo shows a sticker
 *   cell. Switching category needs a tap, the card is out of process, and the simulator on this
 *   machine is shared, so no populated capture exists. The grid below is therefore ChatKit's
 *   *attachment browser* grid — inset 8, gap 4, cell 72.5 — which is the browser the sticker browser
 *   is one of, and it is quoted as such rather than as a measurement of this card. At the measured
 *   sheet width that is five columns of 72.7333. `stickerPickerMetrics.grid` is marked accordingly
 *   and `columns` is a prop.
 * - **Dark.** No dark capture of the card exists. Every dark value is the iOS system pair of a
 *   measured light one, and the glass is `ios-plus-menu.tsx`'s measured dark glass.
 * - **The sheet's own entrance and exit.** Nothing records it. 380 and 220 are the long-press menu's
 *   measured open and exit, the same borrow `photo-picker.tsx` makes.
 * - **The half-second before the shrink.** `animateScaleDown` is measured; the `dispatch_after` that
 *   calls it is not something this probe could reach, so `drag.scaleDelay` is judgement.
 * - **The peel.** `CKBrowserDragStickerView` carries `setUpPeelLayers`, `peelMaskLayer`, `meshLayer`,
 *   `perspectiveLayer` and `shineLayer`, so a real dragged sticker peels off the sheet in 3D with a
 *   mesh warp and a shine. This file draws a flat sticker on the measured springs. That is a known,
 *   deliberate gap, not an oversight.
 * - **The category set.** Recents, Emoji and an `EDIT` pill are in the capture; the two pack icons in
 *   it are the simulator's own installed packs. Which categories a device shows is its own business,
 *   so `tabs` is data, not a constant.
 *
 * ## Motion
 *
 * The sheet is one Web Animations timeline, so `document.getAnimations()` reaches it and `progress`
 * pauses and seeks it to a frame that is a pure function of one scalar. The direction is read off the
 * `open` prop **during render**, never in an effect, so a dismissal always gets committed frames
 * before `onExited` lets the caller unmount it.
 *
 * The live drag is the one thing that reads a clock: it integrates ChatKit's three springs against
 * the pointer, so it is disabled whenever `progress` is scrubbing. `dragPreview` exists for exactly
 * that case — it poses the same lift, carry, shrink and landing as a pure function of a progress
 * scalar, so a harness checkpoint can show a sticker in flight without a pointer.
 */

/** Apple's continuous corner. Browsers without `corner-shape` fall back to a plain round corner. */
const continuous = { cornerShape: "superellipse(1.14)" } as CSSProperties;

/**
 * Light values are measured off `sticker-picker-light.png`; the dark set is the iOS system pair of
 * each and is unverified (see the file comment). Written out in full because Tailwind only compiles
 * class names it can read literally in the source.
 */
const vars =
  "[--ios-sp-label:#000000] [--ios-sp-secondary:rgba(60,60,67,0.6)] [--ios-sp-glass:255_255_255] [--ios-sp-alpha:0.569] " +
  "[--ios-sp-fill:rgba(118,118,128,0.12)] [--ios-sp-scrim:rgba(0,0,0,0.2)] [--ios-sp-shadow:rgba(0,0,0,0.12)] " +
  "dark:[--ios-sp-label:#ffffff] dark:[--ios-sp-secondary:rgba(235,235,245,0.6)] dark:[--ios-sp-glass:28_28_28] dark:[--ios-sp-alpha:0.72] " +
  "dark:[--ios-sp-fill:rgba(118,118,128,0.24)] dark:[--ios-sp-scrim:rgba(0,0,0,0.2)] dark:[--ios-sp-shadow:rgba(0,0,0,0.4)]";

export const stickerPickerMetrics = {
  /** The screen the sheet was captured on. Points equal CSS px. */
  screen: { width: 402, height: 874 },
  /**
   * The sheet UIKit puts the card in, measured off `sticker-picker-light.png`. `glassAlpha` is white
   * over the blurred, dimmed backdrop; `blur` is nominal, because Chromium renders every
   * `backdrop-filter: blur()` radius alike on an element like this (see `ios-plus-menu.tsx`).
   * @unverified blur, saturate
   */
  sheet: {
    inset: 3.1667,
    top: 414.1667,
    width: 395.6667,
    height: 456.6667,
    topRadius: 40.4167,
    bottomRadius: 60.3333,
    glassAlpha: 0.569,
    blur: 45,
    saturate: 1.9,
  },
  /** Measured exactly: four known patches behind the sheet all come back multiplied by 0.8. */
  scrimAlpha: 0.2,
  /**
   * The title row. The type is a fit to 13.0 of measured ink height and not a framework reading: at
   * 17pt semibold with tracking -0.2 the browser puts the ink at 439.00-452.33 x 170.33-232.33
   * against the capture's 439.00-452.00 x 170.00-232.00. `titleNudge` is the 0.8333 between where a
   * CSS line box puts SF's ink and where UIKit does. Everything else here is measured.
   * @unverified titleSize, titleWeight, titleTracking, titleNudge, closeGlyphStroke
   */
  header: { height: 63, centerY: 31.3333, titleSize: 17, titleWeight: 600, titleTracking: -0.2, titleNudge: 0.8333, closeSize: 43.3333, closeInset: 15.9722, closeGlyph: 16.3333, closeGlyphStroke: 2 },
  /**
   * The category strip. All measured except `artWidth`, which is the aspect the two pack icons in the
   * capture happen to have (30.67 x 23) rather than a rule. `editGap` is its own measurement and not
   * the strip's 8: four categories on the measured 51.3333 pitch end at 210.1667 and the pill's left
   * edge is at 223.5.
   * The EDIT type is a fit too: 11pt semibold at tracking 0.1 renders 24.67 of ink against the
   * capture's 23.33, with the cap height exact at 8.00.
   * @unverified artWidth, glyphStroke, editFontSize, editTracking
   */
  strip: { height: 43.3333, itemSize: 43.3333, gap: 8, inset: 9.6667, radius: 14.3333, glyphSize: 21.6667, glyphStroke: 2.3333, artHeight: 23, artWidth: 30.6667, editWidth: 45, editHeight: 20, editGap: 13.3333, editFontSize: 11, editTracking: 0.1 },
  /**
   * The empty state, from the capture's own "No Recent Stickers". The three ink runs are measured —
   * headline y 628.3333-645.0 and 189.33 wide, body lines y 656.3333-669.6667 (158.67 wide) and
   * 676.0-689.3333 (145.0) — and everything here is the type that reproduces them, so the sizes and
   * the tracking are a fit to measured ink rather than framework readings. `top` is where the block
   * sits below the content area's own top; the block is NOT centred in that area, which is 36.83
   * lower.
   * @unverified titleSize, titleTracking, bodySize, bodyTracking, bodyMaxWidth
   */
  empty: { top: 103.5, gap: 2.6667, titleSize: 22, titleWeight: 700, titleTracking: -0.2, titleLineHeight: 26, bodySize: 15, bodyTracking: -0.2, bodyLineHeight: 19.3333, bodyMaxWidth: 180 },
  /**
   * NOT a measurement of this card. `inset`, `gap` and `cell` are ChatKit's attachment browser
   * (`attachmentBrowserGridSectionInset`, `attachmentBrowserGridInterItemSpacing`,
   * `attachmentBrowserDefaultSizeForSquare`) and `tileRadius` is `stickersCellCornerRadius`; the
   * sticker browser is one of those browsers, but no capture in this repo shows its cells. See the
   * file comment.
   * @unverified the whole of it, as a description of THIS grid
   */
  grid: { inset: 8, gap: 4, cell: 72.5, tileRadius: 8 },
  /**
   * Where a dragged sticker ends up. `size` is `-[CKUIBehaviorPhone stickerReactionSize]` (and
   * `emojiStickerTranscriptBalloonSize`, which agrees); the rotation band is
   * `minStickerReactionRotation` / `maxStickerReactionRotation`; the overlaps and the odd-row inset
   * are the constants a caller needs to stack more than one on a bubble.
   */
  landing: { size: 48, minRotation: 3, maxRotation: 10, overlapX: 0.25, overlapY: 0.35, oddRowInset: 9.6, textBalloonExtraPadding: 5 },
  /**
   * The carry. `scale`, `scaleDuration` and `easing` are read straight off the `CASpringAnimation`
   * `-[CKBrowserDragStickerView animateScaleDown]` installs (0.91 s at speed 0.8 = 1137.5 ms of wall
   * clock); `settle` is the same factory at speed 1. `elastic` is the five `CKElasticFunction`s the
   * drag view attaches. `scaleDelay` and `threshold` are judgement.
   * @unverified scaleDelay, threshold
   */
  drag: {
    scale: 0.7142857142857143,
    scaleDuration: 1137.5,
    scaleDelay: 500,
    settle: 910,
    threshold: 6,
    elastic: {
      position: { tension: 550, friction: 20 },
      rotation: { tension: 350, friction: 15 },
      scale: { tension: 350, friction: 20 },
    },
  },
  /**
   * The one deterministic drag the harness can seek. Its three phases are the measured durations
   * above laid end to end, so a seeked frame is a pure function of `progress`.
   */
  preview: { total: 500 + 1137.5 + 910, lift: 500, shrink: 1137.5, land: 910 },
  /** @unverified: nothing records the sheet in motion. The long-press menu's measured open and exit. */
  timing: { enter: 380, exit: 220 },
  /** `+[CKBrowserDragStickerView springAnimationWithKeyPath:speed:]`'s own timing function. */
  dragEasing: "cubic-bezier(0.14028, 0.004662, 0.57534, 0.96737)",
  /** The kit's entrance curve, shared with `photo-picker.tsx`. */
  enterEasing: "cubic-bezier(0.32, 0.72, 0, 1)",
  exitEasing: "cubic-bezier(0.4, 0, 1, 1)",
} as const;

/** Which Messages this picker is standing in. See `macStickerPickerMetrics` for what changes. */
export type StickerPickerPlatform = "ios" | "macos";

/**
 * # The macOS presentation
 *
 * macOS Messages does not present the sticker browser as a sheet. Its "+" is a **menu** —
 * `-[CKUIBehaviorMac browserButtonShouldUseMenu]` is YES where `CKUIBehaviorPhone`'s is NO — so the
 * "Stickers" row opens a **popover anchored to the "+" button**, wearing the window's own material.
 * With it go the sheet's title row, its round close button, its 20% backdrop dim and its slide up
 * from the screen's bottom edge: a popover has no titlebar, does not dim the window behind it, and a
 * desktop window has no screen edge for a sheet to leave by — sliding it there is what put a sliver
 * of the card below the *window*.
 *
 * ## Measured — ChatKit 26.5 at idiom 5
 *
 * A Catalyst probe (`clang -target arm64-apple-ios26.0-macabi`, dlopen ChatKit, `-[UIDevice
 * userInterfaceIdiom]` swizzled to 5 **before** anything latches it) then `+[CKUIBehavior
 * sharedBehaviors]`, which vends `CKUIBehaviorMac`. The idiom-0 reading is beside each one, because
 * the Mac does not inherit the Phone:
 *
 * | Selector | idiom 5 (Mac) | idiom 0 (Phone) |
 * |---|---|---|
 * | `stickerPopoverSize` | **{320, 480}** | **{393, 680}** |
 * | `attachmentBrowserGridSectionInset` | {8, 8} | {8, 8} |
 * | `attachmentBrowserGridInterItemSpacing` | 4 | 4 |
 * | `attachmentBrowserGridMinimumLineSpacing` | 4 | 4 |
 * | `attachmentBrowserDefaultSizeForSquare` | 104 | 72.5 |
 * | `stickersCellCornerRadius` | 8 | 8 |
 * | `browserButtonShouldUseMenu` | YES | NO |
 *
 * `stickerPopoverSize` names *this* popover, so its 320 x 480 is the box outright rather than a cap:
 * that is why the height here is fixed where `photo-picker.tsx`'s macOS height is content-derived
 * against a `popOverMaxHeight`. The iPhone sheet this file measures is the 393-wide one, which is
 * why it is not simply re-used at its own size.
 *
 * The **chrome** is the one macOS popover a capture in this repo holds: the fill, the bright inset
 * rim, the dark hairline outside it and the 12 pt corner `macos-plus-menu.tsx` measured off
 * `references/macos/captures/plus-menu-{light,dark}-2x.png`, copied here rather than imported so
 * this file keeps no dependency of its own.
 *
 * The **anchor** is measured at one remove: `macos-plus-menu.tsx` puts the menu's left edge on the
 * "+" button's left edge at pane x 9 and its top 3 pt inside the button's bottom at pane y 626, and
 * `macos-composer.tsx` measures the button 30 square with its bottom 11 above the composer's — so
 * the button is `{9, 599, 30, 30}` in a 640 pt pane, 41 pt up from the pane's bottom edge. That last
 * form is what `anchor` records; at run time the button is *found* rather than assumed.
 *
 * ## Derived, not read
 *
 * **Columns.** 320 less the grid's own measured 8 pt section inset on each side is 304; at ChatKit's
 * 72.5 cell and 4 pt spacing that is `floor((304 + 4) / 76.5)` = **4** columns, and the tiles stretch
 * to 73 to fill the row — the identical rule, and very nearly the identical tile, that the iPhone
 * sheet gets from the same cell at 5 across. The Mac's own
 * `attachmentBrowserDefaultSizeForSquare` of 104 is deliberately **not** used here: it would give
 * two 150 pt stickers in a 320 pt popover, which is not a sticker grid, and it describes the
 * attachment browser's own cells rather than StickerKit's. `photo-picker.tsx` does use the 104,
 * because there the grid really is the attachment browser's.
 *
 * ## Not measured, and marked
 *
 * - **The arrow.** No capture in `references/macos/captures` holds a Messages attachment popover;
 *   ChatKit has no arrow metric; UIKit's `+[_UIPopoverStandardChromeView arrowHeight]` reads **0**
 *   under Catalyst because AppKit draws the chrome there, and AppKit exposes none (`_NSPopoverFrame`
 *   does not exist in macOS 26). Its size and its outline are invented; where it points is measured,
 *   except that a 12 pt corner will not let a 22 pt arrow sit closer than 23 pt to the box's edge,
 *   so at this anchor the tip lands 8 pt right of the button's centre — the clamp UIKit makes too.
 * - **The category strip.** Kept at the measured iPhone geometry (43.3333 chips on a 43.3333 strip).
 *   It is the same StickerKit remote view, but nothing measures what the Mac does to it.
 * - **The motion.** Borrowed whole from `macPlusMenuMetrics.motion`, itself borrowed: 160 ms in,
 *   120 ms out, from 0.96 at the anchor corner.
 */
export const macStickerPickerMetrics = {
  /** `-[CKUIBehaviorMac stickerPopoverSize]`: the popover's box, not a cap. */
  width: 320,
  height: 480,
  /** Measured off `plus-menu-{light,dark}-2x.png` by `macos-plus-menu.tsx`; copied, not imported. */
  radius: 12,
  /**
   * The "+" button as a distance up from the pane's bottom edge, so it survives a pane of another
   * height: `macComposerMetrics.bottom` 11 + `plus.size` 30 = 41, at `plus.left` 9. Fallback only.
   */
  anchor: { left: 9, size: 30, aboveBottom: 41 },
  /** @unverified invented outright; see the note above for why nothing can measure it. */
  arrow: { width: 22, height: 11 },
  /** @unverified borrowed whole from `macPlusMenuMetrics.motion`, which is itself borrowed. */
  motion: {
    enter: 160,
    exit: 120,
    scale: 0.96,
    enterEase: "cubic-bezier(0.2, 0.8, 0.3, 1)",
    exitEase: "cubic-bezier(0.4, 0, 1, 1)",
  },
} as const;

/**
 * The measured macOS popover material, as custom properties so a `.dark` ancestor flips it without
 * the caller passing anything. `photo-picker.tsx` carries the same copy, for the same reason.
 */
const macVars =
  "[--mac-sp-fill:rgba(238,240,241,0.92)] [--mac-sp-edge:inset_0_0_0_1px_rgba(255,255,255,0.8),0_0_0_0.5px_rgba(0,0,0,0.28),0_4px_16px_rgba(0,0,0,0.12)] [--mac-sp-outline:rgba(0,0,0,0.28)] " +
  "dark:[--mac-sp-fill:rgba(37,39,40,0.94)] dark:[--mac-sp-edge:inset_0_0_0_1px_rgba(255,255,255,0.28),0_0_0_0.5px_rgba(0,0,0,0.85),0_4px_16px_rgba(0,0,0,0.35)] dark:[--mac-sp-outline:rgba(0,0,0,0.85)]";

/**
 * A host that wraps this picker in its own popover box — `macos-messages-app.tsx` does, from before
 * the picker knew what a Mac was — would otherwise double the material: two fills, two rims, two
 * shadows. This switches that box off, but only when the picker inside it is drawing the macOS
 * popover itself. The selector outranks the host's, so it wins wherever the two stylesheets land.
 */
const macHostInteropCss = `[data-slot="mac-attachment-popover"]:has([data-slot="sticker-picker"][data-platform="macos"]) > [aria-hidden="true"]:not([data-slot]){background:transparent!important;box-shadow:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}`;

/**
 * Where the popover sits, in the coordinates of whatever box the picker was dropped into. The "+"
 * button is *found*, not assumed: the nearest `[data-im-platform]` ancestor is searched for
 * `[data-slot="attach-button"]`, the slot `macos-composer.tsx` puts on it, so the same component is
 * right inside the app shell's own wrapper and inside a bare pane in a lab route. It always opens
 * **upward**, which is the measured rule rather than a preference: neither Mac popover fits below a
 * button whose bottom is 11 pt off the floor of a 640 pt window, and an AppKit popover flips rather
 * than hangs. `photo-picker.tsx` carries the same hook, copied for the same no-dependency reason.
 */
function useMacPopoverPlacement(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
  box: { width: number; height: number },
  arrow: { width: number; height: number },
  radius: number,
  /** Which composer button the popover hangs off. The smiley opens this one too. */
  anchorSlot: string,
) {
  const [placement, setPlacement] = useState<{ left: number; top: number; arrowX: number } | null>(null);
  useLayoutEffect(() => {
    const node = root.current;
    if (!enabled || !node) return;
    const base = node.getBoundingClientRect();
    const host = node.closest("[data-im-platform]") ?? node.ownerDocument.body;
    const button = host.querySelector(`[data-slot="${anchorSlot}"]`);
    const rect = button?.getBoundingClientRect();
    const a = macStickerPickerMetrics.anchor;
    const anchor = rect
      ? { left: rect.left - base.left, top: rect.top - base.top, width: rect.width }
      : { left: a.left, top: base.height - a.aboveBottom, width: a.size };
    const left = base.width > box.width ? Math.max(0, Math.min(anchor.left, base.width - box.width)) : anchor.left;
    // The arrow points at the button's centre, but never closer to a corner than the corner's own
    // radius plus half the arrow — past that it would come out of the curve. UIKit clamps it too.
    const inset = radius + arrow.width / 2;
    const centre = anchor.left + anchor.width / 2 - left;
    // Measuring the DOM and rendering against what came back is the one thing a layout effect is
    // for, and it cannot be lifted into render: the "+" button does not exist until the commit.
    // The pose is committed before the browser paints, so no frame shows the popover unplaced.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a layout measurement, see above
    setPlacement({ left, top: anchor.top - arrow.height - box.height, arrowX: Math.max(inset, Math.min(centre, box.width - inset)) });
  }, [root, enabled, box.width, box.height, arrow.width, arrow.height, radius, anchorSlot]);
  return placement;
}

/**
 * Reads the platform off the DOM when the caller did not say. The macOS shell stamps
 * `data-im-platform="macos"` on its root, so a picker dropped anywhere inside it gets the macOS
 * presentation with nothing passed. A layout effect, so a client-mounted picker is never painted in
 * the wrong presentation; a picker *server*-rendered already open shows one iOS frame before the
 * effect runs, which is why the `platform` prop exists.
 */
function useHostPlatform(root: RefObject<HTMLElement | null>, override?: StickerPickerPlatform): StickerPickerPlatform {
  const [sniffed, setSniffed] = useState<StickerPickerPlatform>("ios");
  useLayoutEffect(() => {
    if (override) return;
    const host = root.current?.closest("[data-im-platform]");
    // Same reason: the ancestor that says which Messages this is cannot be read during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a DOM read, see above
    setSniffed(host?.getAttribute("data-im-platform") === "macos" ? "macos" : "ios");
  }, [root, override]);
  return override ?? sniffed;
}

/** Columns that fit ChatKit's 72.5 cell across `width`, and the cell size that squares up to it. */
export function stickerGridColumns(width: number = stickerPickerMetrics.sheet.width): number {
  const { inset, gap, cell } = stickerPickerMetrics.grid;
  return Math.max(1, Math.floor((width - 2 * inset + gap) / (cell + gap)));
}

export type StickerKind = "emoji" | "art";

export type Sticker = {
  id: string;
  /** `emoji` draws `glyph` as text; `art` draws it over `fill`, if the caller supplies one. */
  kind?: StickerKind;
  glyph: string;
  /** Accessible name, and what a search matches against together with `keywords`. */
  label: string;
  keywords?: string;
  /** Any CSS background for an `art` sticker. The registry ships no artwork of its own. */
  fill?: string;
};

export type StickerTabIcon = "recents" | "emoji" | "memoji" | "live" | "pack";

export type StickerTab = {
  id: string;
  label: string;
  icon: StickerTabIcon;
  stickers: Sticker[];
  /** Overrides the grid's column count for this category. Unset everywhere in the fixture: see the file comment. */
  columns?: number;
};

const art = (id: string, glyph: string, label: string, keywords?: string): Sticker => ({ id, kind: "art", glyph, label, keywords });
const emoji = (id: string, glyph: string, label: string, keywords?: string): Sticker => ({ id, kind: "emoji", glyph, label, keywords });

/**
 * Fixture categories. The capture's own strip is a clock, a smiley, two installed packs and an `EDIT`
 * pill, so the shape is right; which packs a device carries is the device's business.
 *
 * Recents is filled in below from the categories it is a recency view over, so one sticker keeps one
 * id everywhere and nothing can return it twice.
 */
export const stickerPickerTabs: StickerTab[] = [
  { id: "recents", label: "Recents", icon: "recents", stickers: [] },
  {
    id: "emoji",
    label: "Emoji",
    icon: "emoji",
    stickers: [
      emoji("e-joy", "\u{1F602}", "Face with tears of joy", "laugh haha"),
      emoji("e-love", "\u{1F60D}", "Smiling face with heart eyes", "love"),
      emoji("e-wink", "\u{1F609}", "Winking face"),
      emoji("e-cool", "\u{1F60E}", "Smiling face with sunglasses", "cool"),
      emoji("e-think", "\u{1F914}", "Thinking face"),
      emoji("e-party", "\u{1F973}", "Partying face", "celebrate"),
      emoji("e-heart", "❤️", "Red heart", "love"),
      emoji("e-sparkle", "✨", "Sparkles"),
      emoji("e-fire", "\u{1F525}", "Fire"),
      emoji("e-clap", "\u{1F44F}", "Clapping hands"),
      emoji("e-pray", "\u{1F64F}", "Folded hands", "thanks"),
      emoji("e-rocket", "\u{1F680}", "Rocket"),
      emoji("e-cake", "\u{1F382}", "Birthday cake", "party"),
      emoji("e-coffee", "☕", "Hot beverage", "coffee"),
      emoji("e-dog", "\u{1F415}", "Dog"),
      emoji("e-thumbs", "\u{1F44D}", "Thumbs up", "yes ok"),
    ],
  },
  {
    id: "memoji",
    label: "Memoji",
    icon: "memoji",
    stickers: [
      art("m-alex-wave", "\u{1F44B}", "Alex Morgan waving"),
      art("m-alex-laugh", "\u{1F604}", "Alex Morgan laughing"),
      art("m-jamie-thumbs", "\u{1F44D}", "Jamie Chen giving a thumbs up"),
      art("m-jamie-wow", "\u{1F62E}", "Jamie Chen looking surprised"),
      art("m-sam-heart", "\u{1F60D}", "Sam Rivera sending love"),
      art("m-sam-shrug", "\u{1F937}", "Sam Rivera shrugging"),
    ],
  },
  {
    id: "live",
    label: "Live Stickers",
    icon: "live",
    stickers: [
      art("l-pup", "\u{1F415}", "Puppy cutout", "dog"),
      art("l-shore", "\u{1F3D6}️", "Shore cutout", "beach"),
      art("l-ridge", "⛰️", "Ridge cutout", "mountain"),
      art("l-bloom", "\u{1F339}", "Bloom cutout", "flower"),
      art("l-mug", "☕", "Coffee cutout"),
      art("l-bike", "\u{1F6B2}", "Bicycle cutout"),
    ],
  },
  {
    id: "doodles",
    label: "Doodles",
    icon: "pack",
    stickers: [
      art("d-star", "⭐", "Doodled star"),
      art("d-bolt", "⚡", "Doodled bolt"),
      art("d-moon", "\u{1F319}", "Doodled moon"),
      art("d-wave", "\u{1F30A}", "Doodled wave"),
    ],
  },
];

const byId = new Map(stickerPickerTabs.flatMap(entry => entry.stickers.map(sticker => [sticker.id, sticker] as const)));
/** The five most recently used, taken from the packs they belong to rather than copied. */
stickerPickerTabs[0].stickers = ["m-alex-wave", "e-heart", "l-pup", "e-joy", "d-star"].flatMap(id => {
  const sticker = byId.get(id);
  return sticker ? [sticker] : [];
});

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/**
 * The angle a sticker settles at once it lands, inside ChatKit's measured 3 to 10 degree band.
 * Deterministic on the id and not on a clock or `Math.random`, so a landed sticker poses identically
 * every run and a seeked checkpoint stays byte-identical.
 */
export function stickerLandingRotation(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const { minRotation, maxRotation } = stickerPickerMetrics.landing;
  const magnitude = minRotation + ((hash >>> 8) % 1000) / 1000 * (maxRotation - minRotation);
  return (hash & 1 ? 1 : -1) * magnitude;
}

/**
 * One of ChatKit's `CKElasticFunction`s: `x'' = -tension * (x - input) - friction * x'`, integrated
 * at a fixed 1 ms sub-step so the same pointer path always produces the same pose regardless of the
 * frame rate. `tension` and `friction` are the measured constants; nothing else is invented.
 */
class ElasticFunction {
  output: number;
  velocity = 0;
  input: number;
  constructor(private tension: number, private friction: number, start: number) {
    this.output = start;
    this.input = start;
  }
  step(seconds: number) {
    let left = Math.min(seconds, 0.1);
    while (left > 0) {
      const dt = Math.min(left, 0.001);
      const acceleration = -this.tension * (this.output - this.input) - this.friction * this.velocity;
      this.velocity += acceleration * dt;
      this.output += this.velocity * dt;
      left -= dt;
    }
  }
}

function TabGlyph({ icon, size, stroke }: { icon: StickerTabIcon; size: number; stroke: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true } as const;
  if (icon === "recents") {
    // The capture's Recents glyph: a plain circle with two hands, drawn at the measured Ø and stroke.
    return (
      <svg {...common} stroke="currentColor" strokeWidth={(stroke / size) * 24} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10.7" />
        <path d="M12 5.6V12l4.4 2.6" />
      </svg>
    );
  }
  if (icon === "emoji") {
    return (
      <svg {...common} stroke="currentColor" strokeWidth={(stroke / size) * 24} strokeLinecap="round">
        <circle cx="12" cy="12" r="10.7" />
        <path d="M8.4 9.8v.5M15.6 9.8v.5" strokeWidth={(stroke / size) * 30} />
        <path d="M7.6 14.6a5.6 5.6 0 0 0 8.8 0" />
      </svg>
    );
  }
  if (icon === "memoji") {
    return (
      <svg {...common} stroke="currentColor" strokeWidth={(stroke / size) * 24} strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="12.2" rx="6.6" ry="7.8" />
        <path d="M5.4 10.2a2 2 0 0 0 0 4M18.6 10.2a2 2 0 0 1 0 4" />
        <path d="M9.7 11v1M14.3 11v1" strokeWidth={(stroke / size) * 28} />
        <path d="M9.9 15.6a3.6 3.6 0 0 0 4.2 0" />
      </svg>
    );
  }
  if (icon === "live") {
    // A sticker with its corner peeled up, the shape the plus menu's Stickers row draws.
    return (
      <svg {...common} stroke="currentColor" strokeWidth={(stroke / size) * 24} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.4 7.2A3.8 3.8 0 0 1 7.2 3.4h9.6a3.8 3.8 0 0 1 3.8 3.8v5.6L12.8 20.6H7.2a3.8 3.8 0 0 1-3.8-3.8Z" />
        <path d="M20.6 12.8h-4.2a3.6 3.6 0 0 0-3.6 3.6v4.2" />
      </svg>
    );
  }
  return (
    <svg {...common} stroke="currentColor" strokeWidth={(stroke / size) * 24} strokeLinejoin="round">
      <rect x="3.2" y="3.2" width="7.6" height="7.6" rx="2.2" />
      <rect x="13.2" y="3.2" width="7.6" height="7.6" rx="2.2" />
      <rect x="3.2" y="13.2" width="7.6" height="7.6" rx="2.2" />
      <rect x="13.2" y="13.2" width="7.6" height="7.6" rx="2.2" />
    </svg>
  );
}

/**
 * One sticker's artwork at whatever box the grid, the ghost or a landing gives it.
 *
 * Real stickers are transparent cut-outs sitting straight on the card, so nothing here draws a tile
 * behind one: an opaque rounded square would be a fidelity claim the capture does not support. A
 * caller with real artwork passes `fill`, and only then is there a background — clipped to
 * `stickersCellCornerRadius`.
 */
function StickerArt({ sticker, size }: { sticker: Sticker; size: number }) {
  const m = stickerPickerMetrics;
  return (
    <span
      aria-hidden="true"
      data-slot="sticker-art"
      className="flex size-full items-center justify-center"
      style={{
        fontFamily: emojiFontStack,
        // An emoji sticker is the glyph itself; art keeps a little air inside its cell.
        fontSize: size * (sticker.kind === "emoji" ? 0.78 : 0.68),
        lineHeight: 1,
        ...(sticker.fill ? { background: sticker.fill, borderRadius: m.grid.tileRadius, ...continuous } : null),
      }}
    >
      {sticker.glyph}
    </span>
  );
}

export type StickerPlacement = {
  /** Where the sticker landed, in the picker root's own coordinates. */
  x: number;
  y: number;
  /** The angle it settled at, inside ChatKit's 3-10 degree band. */
  rotation: number;
  /** Its landed size: `-[CKUIBehaviorPhone stickerReactionSize]`, 48. */
  size: number;
};

type DragState = {
  sticker: Sticker;
  pointerId: number;
  /** The tile it came off, root relative, so the ghost and a return home share one space. */
  source: { left: number; top: number; size: number };
  /** Set once the drop's landing animation is running; the pointer no longer drives the ghost. */
  landing: boolean;
};

export type StickerPickerProps = Omit<ComponentProps<"div">, "onSelect" | "children"> & {
  /**
   * The composer button this popover hangs off on the Mac, by `data-slot`. Defaults to the "+", which
   * is what opens it from the plus menu; the smiley passes its own so the arrow points at the button
   * that was actually pressed rather than always at the "+".
   */
  anchorSlot?: string;
  /**
   * Which Messages to be. Left off, it is read from the nearest `[data-im-platform]` ancestor, so
   * the macOS shell gets the macOS popover without passing anything. See `macStickerPickerMetrics`.
   */
  platform?: StickerPickerPlatform;
  tabs?: StickerTab[];
  /** Controlled active category id. */
  tab?: string;
  defaultTab?: string;
  onTabChange?: (tabId: string) => void;
  /** A tap, Enter or Space on a sticker. This is the path the keyboard has to the same result. */
  onSelect?: (sticker: Sticker) => void;
  /**
   * A sticker dragged out of the sheet and let go. Fires when the landing animation finishes, so
   * `placement.size` is the landed 48 and `placement.rotation` is the angle it settled at — draw the
   * sticker there and it takes over from the ghost without a jump. Pointer only; see the file comment.
   */
  onPlace?: (sticker: Sticker, placement: StickerPlacement) => void;
  /** The strip's trailing `EDIT` pill. Omit the handler and the pill is not drawn. */
  onEdit?: () => void;
  /** Escape, the close button, and a tap on the dimmed backdrop. */
  onDismiss?: () => void;
  /** False plays the exit and then calls `onExited`, so the caller can unmount the sheet. */
  open?: boolean;
  onExited?: () => void;
  /**
   * Seek whichever direction `open` selects to this fraction (0..1) instead of playing it, which is
   * what the harness does. A seeked exit poses the sheet and never reports through `onExited`, and it
   * turns the live drag off.
   */
  progress?: number;
  /**
   * A drag posed rather than performed, for a frame the harness can seek: the sticker travelling from
   * its own tile to `to` (root coordinates), scrubbed by `progress` over
   * `stickerPickerMetrics.preview`. Pure: no clock, no pointer.
   */
  dragPreview?: { id: string; to: { x: number; y: number }; progress: number } | null;
  /** The sheet box. Defaults are the capture's. */
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  /** Columns in the grid. Defaults to what ChatKit's 72.5 cell fits across `width`. */
  columns?: number;
  /** False drops the dimming behind the sheet, for a caller that draws its own. */
  scrim?: boolean;
  title?: string;
  emptyTitle?: string;
  emptyBody?: string;
  editLabel?: string;
  closeLabel?: string;
};

export function StickerPicker({
  platform: platformProp,
  anchorSlot = "attach-button",
  tabs = stickerPickerTabs,
  tab: tabProp,
  defaultTab,
  onTabChange,
  onSelect,
  onPlace,
  onEdit,
  onDismiss,
  open = true,
  onExited,
  progress,
  dragPreview,
  left = stickerPickerMetrics.sheet.inset,
  top = stickerPickerMetrics.sheet.top,
  width = stickerPickerMetrics.sheet.width,
  height = stickerPickerMetrics.sheet.height,
  columns: columnsProp,
  scrim = true,
  title = "Stickers",
  emptyTitle = "No Recent Stickers",
  emptyBody = "Stickers you’ve recently used will appear here.",
  editLabel = "EDIT",
  closeLabel = "Close",
  className,
  style,
  ...props
}: StickerPickerProps) {
  const m = stickerPickerMetrics;
  const id = useId();
  const titleId = `${id}-title`;

  const [internalTab, setInternalTab] = useState(defaultTab ?? tabs[0]?.id ?? "");
  const activeTabId = tabProp ?? internalTab;

  const root = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const dim = useRef<HTMLDivElement>(null);

  /**
   * The sheet outlives the `open` prop so the dismissal has frames to run in, and `closing` is
   * derived DURING RENDER rather than in an effect: an effect leaves one committed frame with the
   * sheet already gone and the exit never runs. Same rule as `ios-plus-menu.tsx`.
   *
   * `everOpened` is what stops the bug the previous version shipped: mounting with `open={false}`
   * used to play an exit nobody asked for and call `onExited` on the first frame, so a caller that
   * followed the prop's own documentation unmounted itself immediately.
   */
  const [seenOpen, setSeenOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  const [everOpened, setEverOpened] = useState(open);
  if (seenOpen !== open) {
    setSeenOpen(open);
    setClosing(!open && everOpened);
    if (open) setEverOpened(true);
  }

  /**
   * The callback lives in a ref, not in the timeline effect's dependencies. A caller that passes an
   * inline arrow hands us a new identity on the render `onExited` itself causes, and a dependency on
   * it would tear the finished exit down and start it again from the top.
   */
  const exitedCallback = useRef(onExited);
  useEffect(() => {
    exitedCallback.current = onExited;
  });
  const reported = useRef(false);

  const activeTab = tabs.find(entry => entry.id === activeTabId) ?? tabs[0];
  const empty = useMemo<Sticker[]>(() => [], []);
  const stickers = activeTab?.stickers ?? empty;

  const platform = useHostPlatform(root, platformProp);
  const mac = platform === "macos";
  const mm = macStickerPickerMetrics;

  /**
   * The box. On the Mac it is `stickerPopoverSize` outright and its place comes from the "+" button;
   * on iOS it is the caller's, defaulting to the capture's. Everything below — the strip, the grid,
   * the drag's own "did it land inside the card" test and the seeked drag preview — reads these four
   * and not the props, so one set of arithmetic serves both presentations.
   */
  const placement = useMacPopoverPlacement(root, mac, { width: mm.width, height: mm.height }, mm.arrow, mm.radius, anchorSlot);
  const boxWidth = mac ? mm.width : width;
  const boxHeight = mac ? mm.height : height;
  const boxLeft = mac ? (placement?.left ?? 0) : left;
  const boxTop = mac ? (placement?.top ?? 0) : top;
  /** A popover has no titlebar, so the strip starts at the top and the grid moves up with it. */
  const headerHeight = mac ? 0 : m.header.height;

  const columns = columnsProp ?? activeTab?.columns ?? stickerGridColumns(boxWidth);
  const tileSize = (boxWidth - 2 * m.grid.inset - (columns - 1) * m.grid.gap) / columns;

  /**
   * One Web Animations timeline over the sheet and its dim, run forwards or backwards. Both keyframe
   * sets are constants, so `document.getAnimations()` reaches them and a seeked frame is a pure
   * function of `progress`. The direction comes off `open`, which is a render value.
   *
   * The sheet really does move: it is a form sheet coming up from the bottom, not something already
   * on screen behind the plus menu's rows.
   */
  useEffect(() => {
    const sheetNode = sheet.current;
    if (!sheetNode) return;
    if (open) reported.current = false;
    const isClosing = !open;
    const duration = isClosing ? (mac ? mm.motion.exit : m.timing.exit) : (mac ? mm.motion.enter : m.timing.enter);
    /*
     * A popover does not slide: it grows out of the "+" button's corner and fades, which is what
     * `macos-plus-menu.tsx` does with the same borrowed numbers. Sliding it the way the iOS form
     * sheet does is what left a sliver of the card below the *window's* bottom edge, because a
     * desktop window has no screen edge for a sheet to leave by.
     */
    const away: Keyframe = mac
      ? { opacity: 0, transform: `scale(${mm.motion.scale})` }
      : { transform: `translateY(${height + m.sheet.inset}px)` };
    const settled: Keyframe = mac ? { opacity: 1, transform: "scale(1)" } : { transform: "translateY(0px)" };
    const finish = () => {
      if (reported.current) return;
      reported.current = true;
      exitedCallback.current?.();
    };
    // A sheet mounted with `open={false}` was never open, so there is no dismissal to play and
    // nobody to report to: it just poses off screen. Reporting here is the bug the previous version
    // shipped — a caller that followed `open`'s own documentation unmounted itself on the first frame.
    const posedClosed = isClosing && !everOpened;
    // Scrubbing is inspection, not a dismissal: a seeked exit poses the sheet and reports nothing.
    const reports = isClosing && progress === undefined && !posedClosed;
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      if (!reports) {
        if (posedClosed) sheetNode.animate([away, away], { duration: 1, fill: "both" }).pause();
        return;
      }
      const frame = requestAnimationFrame(finish);
      return () => cancelAnimationFrame(frame);
    }
    const easing = isClosing ? (mac ? mm.motion.exitEase : m.exitEasing) : (mac ? mm.motion.enterEase : m.enterEasing);
    const options: KeyframeAnimationOptions = { duration, easing, fill: "both" };
    const animations = [sheetNode.animate(isClosing ? [settled, away] : [away, settled], options)];
    const dimNode = dim.current;
    if (dimNode) {
      const fade: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];
      animations.push(dimNode.animate(isClosing ? [...fade].reverse() : fade, options));
    }
    const seek = progress !== undefined ? clamp01(progress) * duration : posedClosed ? duration : undefined;
    if (seek !== undefined) {
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = seek;
      }
      return () => {
        for (const animation of animations) animation.cancel();
      };
    }
    if (!isClosing) {
      return () => {
        for (const animation of animations) animation.cancel();
      };
    }
    animations[0].addEventListener("finish", finish);
    return () => animations[0].removeEventListener("finish", finish);
  }, [open, everOpened, progress, height, scrim, mac, mm.motion, m.timing.enter, m.timing.exit, m.sheet.inset, m.enterEasing, m.exitEasing]);

  // Escape closes it, so the sheet never depends on a tap outside to get out of the way.
  useEffect(() => {
    if (!open || !onDismiss) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  /**
   * A modal sheet owns the focus while it is up. Opening moves focus into it and Tab cycles inside
   * it, so the keyboard cannot walk out into the conversation the sheet is covering.
   *
   * The focus lands on the sheet, never on a tile. A tile focused programmatically while the finger
   * that opened the sheet is still down matches `:focus-visible` in both engines - the gesture has
   * not resolved, so the modality is still the keyboard default - and paints a blue ring around a
   * sticker in a capture that has none. The sheet carries `outline-none`, so holding the focus here
   * paints nothing, and `onSheetKeyDown` hands the first arrow to the grid.
   */
  useEffect(() => {
    if (!open) return;
    const node = sheet.current;
    if (!node) return;
    if (!node.contains(document.activeElement)) node.focus({ preventScroll: true });
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab") return;
      // Only what Tab can actually reach. The strip and the grid both use a roving tab index, so most
      // of their buttons are `tabindex="-1"`; treating one of those as the last stop would leave the
      // real last stop unwrapped and let the keyboard walk out of the sheet.
      const stops = Array.from(node.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]"))
        .filter(element => element.tabIndex >= 0 && !element.hasAttribute("disabled") && element.offsetParent !== null);
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (!event.shiftKey && (active === last || active === node)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      }
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [open]);

  const selectTab = useCallback(
    (next: string) => {
      if (tabProp === undefined) setInternalTab(next);
      onTabChange?.(next);
    },
    [tabProp, onTabChange],
  );

  // One tab stop for the grid, arrows to move inside it, the way a native grid behaves. The roving
  // index is clamped during render, so a category that shrinks under it cannot strand the tab stop.
  const [active, setActive] = useState(0);
  const activeIndex = Math.min(active, Math.max(0, stickers.length - 1));
  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" ? 1
      : event.key === "ArrowLeft" ? -1
      : event.key === "ArrowDown" ? columns
      : event.key === "ArrowUp" ? -columns
      : 0;
    let next = step ? activeIndex + step : activeIndex;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = stickers.length - 1;
    if (!step && event.key !== "Home" && event.key !== "End") return;
    if (next < 0 || next >= stickers.length) return;
    event.preventDefault();
    setActive(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-index="${next}"]`)?.focus();
  };

  /**
   * The sheet holds the focus when it opens (above), which is what keeps a ring off a sticker the
   * finger has not let go of yet: a tile focused programmatically while the touch that opened the
   * sheet is still down matches `:focus-visible` in Chrome and WebKit alike, because the gesture has
   * not resolved and the modality is still the keyboard default. The cost of holding it here is that
   * the sheet's own arrow keys have to know what "on the container" means, or the first arrow does
   * nothing - measured: ArrowRight and ArrowDown were both dead until a Tab moved off the sheet.
   * From the sheet the first arrow enters the grid at the roving tab stop, and every arrow after
   * that is the grid's own; a ring is right from there on, because by then the person is on the
   * keyboard. See `tapback-bar.tsx` for the same shape.
   */
  const onSheetKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const index = event.key === "Home" ? 0 : event.key === "End" ? Math.max(0, stickers.length - 1) : activeIndex;
    const tile = sheet.current?.querySelector<HTMLButtonElement>(`[data-slot="sticker"][data-index="${index}"]`);
    if (!tile) return;
    event.preventDefault();
    setActive(index);
    tile.focus();
  };

  const onTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex(entry => entry.id === activeTabId);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    let next = step ? index + step : index;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (!step && event.key !== "Home" && event.key !== "End") return;
    if (next < 0 || next >= tabs.length) return;
    event.preventDefault();
    selectTab(tabs[next].id);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${tabs[next].id}"]`)?.focus();
  };

  /**
   * The live drag. Pointer only, and off while `progress` is scrubbing: a drag is an interaction and
   * would put a pointer's position into a frame the harness expects to be a pure function of one
   * scalar. `dragPreview` covers that case instead. Everything a drag can do a tap can also do, so
   * the keyboard loses nothing.
   */
  const [drag, setDrag] = useState<DragState | null>(null);
  const pending = useRef<{ sticker: Sticker; pointerId: number; startX: number; startY: number; source: DragState["source"] } | null>(null);
  const suppressClick = useRef(false);
  const ghost = useRef<HTMLDivElement>(null);
  const scaler = useRef<HTMLDivElement>(null);
  const dragEnabled = progress === undefined && dragPreview == null && onPlace !== undefined;

  /**
   * The springs, the rAF handle and the target the pointer is feeding them. Never in state: they
   * change every frame. `last` and `started` are filled in on the first animation frame rather than
   * at pointer-down, so nothing in this component's body ever reads a clock — the lint rule that
   * forbids it is also the rule that keeps a re-render from moving the sticker.
   */
  const carry = useRef<{
    x: ElasticFunction;
    y: ElasticFunction;
    rotation: ElasticFunction;
    scale: ElasticFunction;
    raf: number;
    last: number;
    started: number;
    /** The scale the last painted frame used, so a drop can start its landing from the drawn pose. */
    painted: number;
  } | null>(null);

  const rootPoint = (clientX: number, clientY: number) => {
    const rect = root.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  const paint = useCallback((x: number, y: number, rotation: number, scale: number, size: number) => {
    const node = ghost.current;
    if (!node) return;
    node.style.transform = `translate(${x - size / 2}px, ${y - size / 2}px) rotate(${rotation}deg)`;
    const inner = scaler.current;
    if (inner) inner.style.transform = `scale(${scale})`;
  }, []);

  const stopCarry = useCallback(() => {
    const state = carry.current;
    if (state) cancelAnimationFrame(state.raf);
    carry.current = null;
  }, []);

  useEffect(() => stopCarry, [stopCarry]);

  const onTilePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, sticker: Sticker) => {
    // Cleared here, not after the click it suppresses: a drag that ends off the tile may never
    // produce a click at all, and a flag left standing would swallow the next real tap.
    suppressClick.current = false;
    if (!dragEnabled || event.button !== 0) return;
    const rect = root.current?.getBoundingClientRect();
    const tile = event.currentTarget.getBoundingClientRect();
    if (!rect) return;
    pending.current = {
      sticker,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      // The position comes off the live rect, the size off the layout. Lifting a tile mid-entrance
      // would otherwise size the ghost by whatever the entrance had reached.
      source: { left: tile.left - rect.left, top: tile.top - rect.top, size: tileSize },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onTilePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = pending.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const point = rootPoint(event.clientX, event.clientY);
    if (!carry.current) {
      const moved = Math.hypot(event.clientX - start.startX, event.clientY - start.startY);
      if (moved < m.drag.threshold) return;
      suppressClick.current = true;
      const { position, rotation, scale } = m.drag.elastic;
      const centre = { x: start.source.left + start.source.size / 2, y: start.source.top + start.source.size / 2 };
      const state = {
        x: new ElasticFunction(position.tension, position.friction, centre.x),
        y: new ElasticFunction(position.tension, position.friction, centre.y),
        rotation: new ElasticFunction(rotation.tension, rotation.friction, 0),
        scale: new ElasticFunction(scale.tension, scale.friction, 1),
        raf: 0,
        last: 0,
        started: 0,
        painted: 1,
      };
      state.x.input = point.x;
      state.y.input = point.y;
      // The rotation function's input is the angle the sticker settles at; ChatKit's own input is not
      // something this probe could read, so the spring is measured and the target is judgement.
      state.rotation.input = stickerLandingRotation(start.sticker.id);
      carry.current = state;
      setDrag({ sticker: start.sticker, pointerId: event.pointerId, source: start.source, landing: false });
      const tick = (now: number) => {
        const live = carry.current;
        if (!live) return;
        if (!live.started) {
          live.started = now;
          live.last = now;
        }
        const dt = Math.max(0, (now - live.last) / 1000);
        live.last = now;
        live.x.step(dt);
        live.y.step(dt);
        live.rotation.step(dt);
        live.scale.step(dt);
        // ChatKit shrinks the carried sticker to 5/7 half a second in; the spring's own output is the
        // elastic wobble around whichever of the two scales is current.
        const elapsed = now - live.started;
        const shrink =
          elapsed <= m.drag.scaleDelay ? 1
          : lerp(1, m.drag.scale, clamp01((elapsed - m.drag.scaleDelay) / m.drag.scaleDuration));
        live.painted = live.scale.output * shrink;
        paint(live.x.output, live.y.output, live.rotation.output, live.painted, start.source.size);
        live.raf = requestAnimationFrame(tick);
      };
      state.raf = requestAnimationFrame(tick);
      return;
    }
    carry.current.x.input = point.x;
    carry.current.y.input = point.y;
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = pending.current;
    if (start && start.pointerId === event.pointerId) pending.current = null;
    const live = carry.current;
    if (!drag || !live || drag.pointerId !== event.pointerId || drag.landing) return;
    const point = rootPoint(event.clientX, event.clientY);
    const insideSheet = point.x >= boxLeft && point.x <= boxLeft + boxWidth && point.y >= boxTop && point.y <= boxTop + boxHeight;
    const node = ghost.current;
    const inner = scaler.current;
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const size = drag.source.size;
    const from = { x: live.x.output, y: live.y.output, rotation: live.rotation.output, scale: live.painted };
    stopCarry();

    // Let go over the sheet: the sticker goes home, on the spring
    // `+[CKBrowserDragStickerView springAnimationWithKeyPath:speed:]` builds at speed 1.
    // Let go outside it: it lands, rotating into its settled angle at ChatKit's 48.
    const landed = insideSheet
      ? { x: drag.source.left + size / 2, y: drag.source.top + size / 2, rotation: 0, scale: 1 }
      : { x: point.x, y: point.y, rotation: stickerLandingRotation(drag.sticker.id), scale: m.landing.size / size };
    const report = () => {
      if (!insideSheet) onPlace?.(drag.sticker, { x: landed.x, y: landed.y, rotation: landed.rotation, size: m.landing.size });
      setDrag(null);
    };
    if (!node || !inner || reduced) {
      report();
      return;
    }
    setDrag(current => (current ? { ...current, landing: true } : current));
    const options: KeyframeAnimationOptions = { duration: m.drag.settle, easing: m.dragEasing, fill: "both" };
    node.animate(
      [
        { transform: `translate(${from.x - size / 2}px, ${from.y - size / 2}px) rotate(${from.rotation}deg)` },
        { transform: `translate(${landed.x - size / 2}px, ${landed.y - size / 2}px) rotate(${landed.rotation}deg)` },
      ],
      options,
    );
    const scale = inner.animate([{ transform: `scale(${from.scale})` }, { transform: `scale(${landed.scale})` }], options);
    scale.addEventListener("finish", report);
  };

  /**
   * The posed drag. A pure function of `dragPreview.progress` over the three measured phases: the
   * carry before the shrink, the shrink to 5/7, then the landing at 48.
   */
  const preview = useMemo(() => {
    if (!dragPreview) return null;
    const sticker = stickers.find(entry => entry.id === dragPreview.id) ?? byId.get(dragPreview.id);
    if (!sticker) return null;
    const index = stickers.findIndex(entry => entry.id === dragPreview.id);
    if (index < 0) return null;
    const row = Math.floor(index / columns);
    const column = index % columns;
    // The tile's own box, from the layout rather than from a measured rect, so the pose does not
    // depend on the grid having been laid out yet.
    const gridLeft = boxLeft + m.grid.inset;
    const gridTop = boxTop + headerHeight + m.strip.height + m.grid.inset;
    const source = {
      x: gridLeft + column * (tileSize + m.grid.gap) + tileSize / 2,
      y: gridTop + row * (tileSize + m.grid.gap) + tileSize / 2,
    };
    const p = clamp01(dragPreview.progress);
    const time = p * m.preview.total;
    const travel = clamp01(time / (m.preview.lift + m.preview.shrink));
    const shrink = clamp01((time - m.preview.lift) / m.preview.shrink);
    const land = clamp01((time - m.preview.lift - m.preview.shrink) / m.preview.land);
    const carried = lerp(1, m.drag.scale, shrink);
    return {
      sticker,
      size: tileSize,
      x: lerp(lerp(source.x, dragPreview.to.x, travel), dragPreview.to.x, land),
      y: lerp(lerp(source.y, dragPreview.to.y, travel), dragPreview.to.y, land),
      rotation: lerp(0, stickerLandingRotation(sticker.id), Math.max(travel, land)),
      scale: lerp(carried, m.landing.size / tileSize, land),
    };
  }, [dragPreview, stickers, columns, tileSize, boxLeft, boxTop, headerHeight, m.grid.inset, m.grid.gap, m.strip.height, m.preview, m.drag.scale, m.landing.size]);

  const alive = open || closing;
  const gridId = `${id}-grid`;

  return (
    <div
      ref={root}
      data-slot="sticker-picker"
      data-picker={id}
      data-platform={mac ? "macos" : undefined}
      data-state={open ? "open" : closing ? "closing" : "closed"}
      className={cn("absolute inset-0 z-20 select-none", vars, mac ? macVars : null, className)}
      style={{ fontFamily: mac ? "-apple-system, BlinkMacSystemFont, sans-serif" : fontStack, pointerEvents: "none", ...style }}
      {...props}
    >
      {mac ? <style>{macHostInteropCss}</style> : null}
      {/* The dim is measured: black at exactly 0.20 over everything behind the sheet. It is also the
          tap-outside target, but not a control: Escape and the close button do the same job, so it
          stays out of the tab order and out of the accessibility tree. */}
      {alive && scrim && !mac ? (
        <div
          ref={dim}
          aria-hidden="true"
          data-slot="dim"
          onClick={onDismiss}
          className={cn("absolute inset-0", onDismiss ? "pointer-events-auto cursor-default" : null)}
          style={{ background: "var(--ios-sp-scrim)" }}
        />
      ) : null}

      <div
        ref={sheet}
        // The Mac's box is a popover, not a sheet, and it says so: a host that rewrites
        // `[data-slot="sheet"]` to strip an iPhone sheet's glass must not strip the Mac's own.
        data-slot={mac ? "mac-popover" : "sheet"}
        role="dialog"
        // Only a form sheet over a 20% dim makes the rest of the window unavailable. A popover does
        // not dim anything, so claiming the window is inert behind it would be a lie to the reader.
        aria-modal={mac ? undefined : true}
        aria-labelledby={mac ? undefined : titleId}
        aria-label={mac ? title : undefined}
        tabIndex={-1}
        // A closed sheet is not just off screen: `inert` takes its grid and strip out of the tab
        // order and out of the accessibility tree, which a transform alone would not.
        inert={!open}
        onKeyDown={onSheetKeyDown}
        className={cn("pointer-events-auto absolute outline-none", mac ? "bg-[var(--mac-sp-fill)] shadow-[var(--mac-sp-edge)]" : "overflow-hidden")}
        style={mac
          ? {
              left: boxLeft,
              top: boxTop,
              width: boxWidth,
              height: boxHeight,
              borderRadius: mm.radius,
              // Nothing to show until the "+" has been found: a popover that paints one frame at the
              // wrong end of the pane is worse than one that waits a frame.
              visibility: placement ? undefined : "hidden",
              backdropFilter: "blur(30px)",
              WebkitBackdropFilter: "blur(30px)",
              color: "var(--ios-sp-label)",
              // It grows out of the arrow's tip, which is the "+" button: the plus menu's corner
              // rule, moved to the corner this popover is actually anchored by.
              transformOrigin: `${placement?.arrowX ?? boxWidth / 2}px ${boxHeight + mm.arrow.height}px`,
            }
          : {
              left: boxLeft,
              top: boxTop,
              width: boxWidth,
              height: boxHeight,
              borderRadius: `${m.sheet.topRadius}px ${m.sheet.topRadius}px ${m.sheet.bottomRadius}px ${m.sheet.bottomRadius}px`,
              ...continuous,
              background: `rgb(var(--ios-sp-glass) / var(--ios-sp-alpha))`,
              backdropFilter: `blur(${m.sheet.blur}px) saturate(${m.sheet.saturate})`,
              WebkitBackdropFilter: `blur(${m.sheet.blur}px) saturate(${m.sheet.saturate})`,
              boxShadow: "0 4px 24px 0 var(--ios-sp-shadow)",
              color: "var(--ios-sp-label)",
            }}
      >
        {/*
          The arrow. Invented outright — see `macStickerPickerMetrics.arrow` — and drawn as the
          popover's own material clipped to a triangle, with the box's hairline carried down its two
          slanted edges. It overlaps the box by half a point so the two fills meet without a seam.
        */}
        {mac ? (
          <span
            aria-hidden="true"
            data-slot="mac-popover-arrow"
            className="pointer-events-none absolute"
            style={{ left: (placement?.arrowX ?? boxWidth / 2) - mm.arrow.width / 2, top: boxHeight - 0.5, width: mm.arrow.width, height: mm.arrow.height + 0.5 }}
          >
            <span
              className="absolute inset-0 bg-[var(--mac-sp-fill)]"
              style={{ clipPath: "polygon(0 0, 100% 0, 50% 100%)", backdropFilter: "blur(30px)", WebkitBackdropFilter: "blur(30px)" }}
            />
            <svg aria-hidden="true" className="absolute inset-0 block size-full" viewBox={`0 0 ${mm.arrow.width} ${mm.arrow.height + 0.5}`} fill="none" preserveAspectRatio="none">
              <path d={`M0 0.25 L${mm.arrow.width / 2} ${mm.arrow.height + 0.25} L${mm.arrow.width} 0.25`} stroke="var(--mac-sp-outline)" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
            </svg>
          </span>
        ) : null}

        {/* A popover has no titlebar and no close button: Escape and a click outside dismiss it. */}
        {mac ? null : (
        <div data-slot="header" className="absolute left-0 top-0 w-full" style={{ height: m.header.height }}>
          <p
            id={titleId}
            data-slot="title"
            className="absolute left-0 w-full text-center"
            style={{
              // `titleNudge` is the 0.8333 between where a 34px CSS line box puts SF's ink and
              // where the capture has it; without it the title renders a point high.
              top: m.header.centerY - m.header.titleSize + m.header.titleNudge,
              lineHeight: `${m.header.titleSize * 2}px`,
              fontSize: m.header.titleSize,
              fontWeight: m.header.titleWeight,
              letterSpacing: m.header.titleTracking,
            }}
          >
            {title}
          </p>
          {onDismiss ? (
            <button
              type="button"
              data-slot="close"
              aria-label={closeLabel}
              onClick={onDismiss}
              className="absolute flex items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0088ff]"
              style={{
                right: m.header.closeInset,
                top: m.header.centerY - m.header.closeSize / 2,
                width: m.header.closeSize,
                height: m.header.closeSize,
                background: "var(--ios-sp-fill)",
                color: "var(--ios-sp-secondary)",
              }}
            >
              <svg aria-hidden="true" width={m.header.closeGlyph} height={m.header.closeGlyph} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={m.header.closeGlyphStroke} strokeLinecap="round">
                <path d="M0.85 0.85 15.15 15.15M15.15 0.85 0.85 15.15" />
              </svg>
            </button>
          ) : null}
        </div>
        )}

        <div
          data-slot="tab-strip"
          role="tablist"
          aria-label={`${title} categories`}
          aria-orientation="horizontal"
          onKeyDown={onTabsKeyDown}
          className="absolute left-0 flex items-center overflow-x-auto"
          style={{
            top: headerHeight,
            height: m.strip.height,
            width: "100%",
            paddingLeft: m.strip.inset,
            paddingRight: m.strip.inset,
            gap: m.strip.gap,
          }}
        >
          {tabs.map(entry => {
            const selected = entry.id === activeTabId;
            const pack = entry.icon === "pack" || entry.icon === "memoji";
            return (
              <Fragment key={entry.id}>
                <button
                  type="button"
                  role="tab"
                  data-slot="tab"
                  data-tab={entry.id}
                  aria-selected={selected}
                  aria-controls={gridId}
                  aria-label={entry.label}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectTab(entry.id)}
                  className="flex shrink-0 items-center justify-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0088ff]"
                  style={{
                    width: m.strip.itemSize,
                    height: m.strip.itemSize,
                    borderRadius: m.strip.radius,
                    ...continuous,
                    background: selected ? "var(--ios-sp-fill)" : "transparent",
                    color: selected ? "var(--ios-sp-label)" : "var(--ios-sp-secondary)",
                  }}
                >
                  {pack ? (
                    // A pack's tab is its own artwork, not a glyph: in the capture both packs occupy
                    // the same 30.67 x 23 box, so that is the box a pack gets here.
                    <span
                      aria-hidden="true"
                      data-slot="tab-art"
                      className="flex items-center justify-center overflow-hidden"
                      style={{ width: m.strip.artWidth, height: m.strip.artHeight, borderRadius: m.strip.artHeight / 2, background: "var(--ios-sp-fill)", fontFamily: emojiFontStack, fontSize: m.strip.artHeight * 0.72, lineHeight: 1 }}
                    >
                      {entry.stickers[0]?.glyph ?? ""}
                    </span>
                  ) : (
                    <TabGlyph icon={entry.icon} size={m.strip.glyphSize} stroke={m.strip.glyphStroke} />
                  )}
                </button>
              </Fragment>
            );
          })}
          {onEdit ? (
            <button
              type="button"
              data-slot="edit"
              onClick={onEdit}
              className="flex shrink-0 items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0088ff]"
              style={{
                marginLeft: m.strip.editGap - m.strip.gap,
                width: m.strip.editWidth,
                height: m.strip.editHeight,
                borderRadius: m.strip.editHeight / 2,
                background: "var(--ios-sp-fill)",
                color: "var(--ios-sp-secondary)",
                fontSize: m.strip.editFontSize,
                fontWeight: 600,
                letterSpacing: m.strip.editTracking,
                lineHeight: 1,
              }}
            >
              {editLabel}
            </button>
          ) : null}
        </div>

        <div
          data-slot="grid-scroller"
          className="absolute overflow-y-auto overflow-x-hidden [overscroll-behavior:contain]"
          style={{ left: 0, right: 0, top: headerHeight + m.strip.height, bottom: 0, padding: m.grid.inset }}
        >
          {stickers.length === 0 ? (
            // The empty state is the capture's: a bold headline over a two-line secondary body,
            // centred in the content area rather than at a fixed offset.
            <div
              data-slot="empty"
              className="flex w-full flex-col items-center text-center"
              style={{ paddingTop: m.empty.top - m.grid.inset, gap: m.empty.gap }}
            >
              <p style={{ fontSize: m.empty.titleSize, fontWeight: m.empty.titleWeight, letterSpacing: m.empty.titleTracking, lineHeight: `${m.empty.titleLineHeight}px` }}>{emptyTitle}</p>
              <p style={{ fontSize: m.empty.bodySize, letterSpacing: m.empty.bodyTracking, lineHeight: `${m.empty.bodyLineHeight}px`, maxWidth: m.empty.bodyMaxWidth, color: "var(--ios-sp-secondary)" }}>{emptyBody}</p>
            </div>
          ) : (
            <div
              id={gridId}
              data-slot="grid"
              role="tabpanel"
              aria-label={activeTab?.label ?? title}
              onKeyDown={onGridKeyDown}
              className="grid"
              style={{ gridTemplateColumns: `repeat(${columns}, ${tileSize}px)`, gap: m.grid.gap }}
            >
              {stickers.map((sticker, index) => (
                <button
                  key={sticker.id}
                  type="button"
                  data-slot="sticker"
                  data-index={index}
                  data-sticker={sticker.id}
                  data-dragging={drag?.sticker.id === sticker.id || preview?.sticker.id === sticker.id ? "true" : undefined}
                  aria-label={sticker.label}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onFocus={() => setActive(index)}
                  onPointerDown={event => onTilePointerDown(event, sticker)}
                  onPointerMove={onTilePointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onClick={() => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    onSelect?.(sticker);
                  }}
                  className="block touch-none p-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0088ff]"
                  style={{
                    width: tileSize,
                    height: tileSize,
                    opacity: drag?.sticker.id === sticker.id || preview?.sticker.id === sticker.id ? 0 : undefined,
                  }}
                >
                  <StickerArt sticker={sticker} size={tileSize} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/*
        The carried sticker. It lives outside the sheet so it can be taken over the transcript, and it
        is inert to the accessibility tree: the tile it came from still carries the name, and letting
        go over the transcript reaches the same handler a tap does. The outer element carries the
        springs' position and rotation, the inner one carries the scale, so the shrink and the landing
        can be Web Animations runs without fighting the rAF transform.
      */}
      {drag || preview ? (
        <div
          ref={preview ? undefined : ghost}
          aria-hidden="true"
          data-slot="drag-ghost"
          data-landing={drag?.landing ? "true" : undefined}
          className="pointer-events-none absolute left-0 top-0"
          style={
            preview
              ? {
                  width: preview.size,
                  height: preview.size,
                  transform: `translate(${preview.x - preview.size / 2}px, ${preview.y - preview.size / 2}px) rotate(${preview.rotation}deg)`,
                }
              : { width: drag?.source.size, height: drag?.source.size }
          }
        >
          <div ref={preview ? undefined : scaler} className="size-full" style={preview ? { transform: `scale(${preview.scale})` } : undefined}>
            <StickerArt sticker={(preview?.sticker ?? drag?.sticker)!} size={preview?.size ?? drag?.source.size ?? 0} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
