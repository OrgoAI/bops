"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { fontStack } from "@/components/message-ui/tokens";

/**
 * The Photos picker iOS 26 opens inside the Messages composer.
 *
 * ## Provenance, in the order this repo prefers it
 *
 * **1. Measured, from `references/ios/captures/photo-picker-light.png`** (iOS 26.0, iPhone 17 Pro,
 * 402x874 pt at 3x). Device pixels are quoted wherever the point value is a third.
 *
 * A white panel, inset **5.3333 (16 px)** from the screen's left, right and bottom edges, holding a
 * three-column grid of thumbnails flush to its own left, right and top edges. Over the middle of the
 * first row sits a drag grabber. That is the whole of what the capture shows: **no header, no title,
 * no "Recents" label, no Albums button, no camera tile, no search field, no send or count button,
 * and no selection badge on any tile.** The last one is a measurement in its own right and this file
 * relies on it: an unselected tile in this picker carries no empty ring, unlike the Photos app's
 * select mode, so the badge is only ever drawn on a selected tile. The device confirms that directly -
 * in `scratchpad/photostates/state0.png` one tile of twelve is picked and only that tile has a badge.
 *
 * That list of absences is true **of the collapsed detent**. Every one of them except the camera tile
 * and the search field turns out to exist in the expanded one: a title, a Clear button, a
 * Photos/Collections segmented control and a blue confirm button. See `expandedDetent`.
 *
 * The capture shows two rows with empty white under them. That is the library, not the layout: the
 * simulator ships six sample photos. The grid scrolls vertically; at this panel height a third row
 * would be visible for 121.3 of its 129.56.
 *
 * | Part | Value | How |
 * |---|---|---|
 * | Inset (left, right, bottom) | 5.3333 (16 px) | white run x 16-1189, bottom-most white row 2605 of 2622 |
 * | Width at a 402 screen | 391.3333 | 1174 px |
 * | Top / height in the capture | 485 / 383.6667 | grid top 1455 px, panel bottom 2606 px |
 * | Fill | `#ffffff` | flat, sampled all over the empty area below the grid |
 * | Top corners | superellipse n 2.204, R **39.0** (rms 0.84 px) | 109 sub-pixel boundary points, top-right |
 * | Bottom corners | superellipse n 2.204, R **57.5833** (rms 0.90 px) | 183 points, bottom-left |
 * | Shadow / dim | none | the blurred backdrop reads a flat 244-246 right up to the panel edge |
 * | Grid gap | **1.6667** (5 px exactly) | superseded: see the device note under `gap` |
 * | Tile | **129.3333** x 129.5325 | follows from the 5 px gap; the capture's own column average was 388.09 px against this 388.0 |
 * | Tile corner | **2.3** | see below |
 * | Grabber | **36 x 5**, top **5.0**, centred | superseded: see the device note under `grabber` |
 * | Composer above it | field bottom 463.6667, so 21.3333 of backdrop above the panel | the composer stays *full*: `+`, "iMessage" and the mic are all still drawn, unlike the plus-menu state |
 *
 * The plain circle is fitted separately, because it is what the panel actually renders (see the
 * clip-path note in the panel's own style): **36.1667** top (rms 0.94 px) and **53.5** bottom (rms
 * 1.27 px). The bottom corner is the device's own corner made concentric with the panel: 57.58 + 5.33
 * = 62.9, the iPhone 17 Pro display radius.
 *
 * **The grabber went 36 x 5 -> 35 x 4.6667 -> 36 x 5, and the last move is the one that sticks.**
 * A 2D area fit over 2640 pixels of *this* capture (five parameters solved at once against sub-pixel
 * coverage, with the background modelled per column) read the pill at **105.000 x 14.000 device px**
 * and that is what this file carried. It was fitting a `_UILumaTrackingBackdropView` **over
 * photographs**: the grid is flush to the panel's top edge here, so the pill has a picture behind it,
 * its own colour changes across it, and the fit has to invent the background before it can find the
 * ink.
 *
 * The expanded detent puts the same pill on the panel's flat fill, and there it needs no fit at all -
 * see `grabber` below for the row-by-row numbers. It is **108 x 15 device px** with hard edges on all
 * four sides, i.e. exactly `-[_UIGrabber intrinsicContentSize]` {36, 5} at its `cornerRadius` 2.5, and
 * `-[CKAppGrabberView layoutSubviews]`'s y 5.0 was always corroborated. Three sources agree against
 * one fit over a photograph, so the framework number is restored and 105 x 14 is recorded as what a
 * vibrancy composite measures rather than as the layer's box.
 *
 * **The tile corner, re-measured.** Nine tile corners that meet clean white (the bottom row's
 * bottom edges and both sides of every gap junction) were each fitted with the same 2D coverage
 * model, taking the photo colour from a plane fitted to the tile's own interior. sRGB blending fits
 * better than linear (mean rms 0.168 against 0.207), and the nine circles come out 6.55 to 7.97
 * device px: median 6.87, rms-weighted mean 6.94. So **2.3** (6.9 device px), with a spread of about
 * +/-0.2 pt corner to corner. The 2.1 this file used to carry sits under the whole cluster, and the
 * **12** `SPEC.md` line 164 still records is 36 device px against a measured 6.9 - off by a factor
 * of five, and copied from there into `group-details.tsx` and `ios-details.tsx`.
 *
 * **2. From the frameworks**, by the Catalyst probe this repo uses elsewhere: `clang -target
 * arm64-apple-ios26.0-macabi`, dlopen
 * `/System/iOSSupport/System/Library/PrivateFrameworks/PhotosUICore.framework/PhotosUICore`, swizzle
 * `-[UIDevice userInterfaceIdiom]` to Phone.
 *
 * | Value | Where |
 * |---|---|
 * | selection badge box **26 x 26** | `+[PXSelectionBadgeUIViewTile preferredSize]` |
 * | badge **3.5** trailing and **3.5** bottom inside the cell | `-[PUPhotosGridCell layoutSubviews]` at a 129.364 x 129.5633 cell: badge frame `{99.864, 100.0633, 26, 26}` |
 * | badge ink **O 22.0**, white rim **1.5449**, blue disc **O 18.9102**, fill **#0088ff** | the badge is a `UIImage`, and its `CGImage` is 52 x 52 at scale 2, so it is read at that native size rather than upscaled. The alpha edge is hard: the disc spans exactly 44 of the 52 px in both axes and in both centre rows and columns. The rim integrates to 3.0898 px of white coverage inward from that edge; the blue is exactly `rgb(0 136 255)`, the kit's measured iOS blue |
 * | check stroke **1.4248**, vertices (-4.408, 0.941) (-1.334, 4.670) (3.957, -3.645) from the badge centre | a seven-parameter least-squares fit of a round-capped, round-joined polyline against the white coverage of 928 pixels of that same native image, supersampled 8 x 8: rms 0.0125 of coverage |
 *
 * **Superseded by a device capture — see `badge` below.** The reasoning that used to close this
 * section ("the badge sits 3.5 inside a 26 box whose ink is 22, so the visible disc is 5.5 from the
 * tile's trailing and bottom edges") is arithmetic over two readings that do not belong to this
 * sheet. `scratchpad/photostates/state0.png` shows a selected tile in the Messages picker with the
 * badge over a flat magenta fill, and it measures **ink O 23.00, blue disc O 20.00, rim 1.50, inset
 * 13 device px = 4.3333** - none of which the {26, 26} / 3.5 pair produces. `PUPhotosGridCell` is the
 * Photos *app's* grid cell; this is not that grid. The two framework rows above are kept because they
 * are true of what they name, not because they describe this badge.
 *
 * The search row, if the expanded detent draws one, reuses `sticker-picker.tsx`'s framework numbers
 * (row 44, field 34, SF Medium 17, `tertiarySystemFill`), which this file's own probe re-read:
 * `+[UIColor tertiarySystemFillColor]` is `rgb(118 118 128 / 0.12)` light and `/ 0.24` dark.
 *
 * **3. Not measured, and not measurable from here.** Everything in this group is marked
 * `@unverified` on the metric that carries it and is listed in the component's return.
 *
 * - **The dark palette.** No dark capture of this surface exists, and the Catalyst probe cannot
 *   stand in for one: under Catalyst the colour catalog is the *macOS* one whatever the idiom trait
 *   says. `+[UIColor systemBackgroundColor]` resolves dark to `#1e1e1e` (iOS is `#000000`) and
 *   `secondarySystemBackgroundColor` resolves light to `#ececec` (iOS is `#f2f2f7`), so a dark value
 *   read that way would be a macOS value wearing an iOS label. The panel is `#ffffff` in light,
 *   which is `systemBackground` and `secondarySystemGroupedBackground` alike, and those two part
 *   company in dark (`#000000` against `#1c1c1e`) - so even the *right* token is undecided. The dark
 *   set below is a guess and says so.
 * - **Both easing curves and both durations.** 380 ms open and 220 ms exit are borrowed from the
 *   long-press menu's measured pair, the same borrow `ios-plus-menu.tsx` and `sticker-picker.tsx`
 *   make; the curves are invented. Nothing in `references/` records this panel moving. The panel
 *   translates and does **not** fade: the away pose clears the screen on its own (`height + inset`,
 *   so the panel top lands exactly on the screen's bottom edge), which is what an iOS sheet does,
 *   and the fade this file used to run was covering an away pose that left 5.3 pt on screen.
 * - **The expanded detent and everything in it**: its height, the header, the "Recents" title, the
 *   Albums button and the search row's placement. The capture is of the collapsed detent and shows
 *   none of them, so this is a missing *state*, not a wrong pixel. The drag itself, its 24 pt handle
 *   strip and the halfway snap are judgement too.
 * - **The composer attachment chip** (`PhotoPickerAttachments`). No capture in either directory
 *   shows a selection sitting in the composer, and no ChatKit metric describes it -
 *   `-[CKUIBehaviorPhone entryViewAttachmentHorizontalOffset]` is -5 and the vertical one is 0,
 *   which places something without sizing it. Every number on the chip is invented.
 * - **The ordered badge's number**, and the 150 ms the badge scales in over.
 */
export const photoPickerMetrics = {
  /** The screen the numbers were measured on. Points equal CSS px. */
  screen: { width: 402, height: 874 },
  /** Left, right and bottom inset from the screen edge (16 device px at 3x). */
  inset: 5.3333,
  /** Where the panel's top edge falls in the capture, and how tall it is there. */
  top: 485,
  height: 383.6667,
  width: 391.3333,
  /**
   * `topRadius` and `bottomRadius` are the continuous corner the capture actually draws. `round*` is
   * the best plain circle for the same arc, and it is what the panel renders: see the clip-path note
   * on the panel for why the shape gives way to sub-pixel edges here.
   */
  topRadius: 39,
  bottomRadius: 57.5833,
  roundTopRadius: 36.1667,
  roundBottomRadius: 53.5,
  columns: 3,
  /**
   * **Exactly 5 device px.** The collapsed capture's three seam fits averaged 1.6207 (4.862 px), but
   * they were fitting a seam between two photographs. `scratchpad/photostates/state0.png` catches the
   * same grid in the expanded detent with flat-colour tiles, and the seams there have **no
   * anti-aliasing at all**: at rows 600, 900, 1000, 1100, 1400 and 1500 the white run is x 399-403
   * and x 802-806, five pixels each, with x 398 and x 404 fully saturated tile colour on either side.
   * A gap that wide cannot be 4.862 px, so the value is **5 px = 1.6667 pt** and the earlier fit was
   * reading the photographs' own edges into the seam.
   */
  gap: 1.6667,
  /**
   * Implied by width, columns and gap: (1174 - 2 x 5) / 3 = 388.0 device px. The collapsed capture's
   * own column average was 388.09, so the two agree to 0.09 px and this is the arithmetic one.
   */
  tileWidth: 129.3333,
  /**
   * Tiles are not quite square in the capture, and both axes are measured over 100+ boundary points:
   * columns average 388.09 device px, rows 388.69. `tileAspect` is that ratio, so a second row lands
   * on the measured 2237.24 instead of 1.2 px above it.
   *
   * The expanded detent in `scratchpad/photostates/state0.png` reads the same lean the other way and
   * smaller: rows there are a hard 399 px tall on a 404 px pitch, columns 399/398/399 on a 403 px
   * pitch, so height / width is 1.00084 against this file's 1.00154. Both are inside one pixel of
   * frame rounding - the layout takes a fractional tile and snaps each frame to the device grid, which
   * is why the three columns are not even the same width as each other - so neither reading falsifies
   * the other and the fitted one is kept. What the expanded capture does settle is that the tile is
   * *meant* to be square and the lean is rounding, not design.
   */
  tileHeight: 129.5633,
  tileAspect: 129.364 / 129.5633,
  /** Median of nine 2D corner fits (6.55-7.97 device px, median 6.87, weighted mean 6.94). */
  tileRadius: 2.3,
  /**
   * **Re-measured on the device, over flat white, and it is the framework's own `{36, 5}` after all.**
   *
   * `scratchpad/photostates/state0.png` catches this sheet in its *expanded* detent, where the pill
   * sits on the panel's plain fill instead of on the photographs the collapsed capture puts under it.
   * Over white it has **no anti-aliased rim at all**: row 230 is #ffffff, rows 231-245 are a flat
   * (197,197,198), row 246 is #ffffff again, and the same holds across the seam at x 548/549 and
   * 656/657. Ink extents row by row are 100, 104, 106, 106, then 108 px for rows 235-242, then back
   * down 106, 106, 104, 100 - the profile of a capsule of radius height / 2, which is what
   * `_UIGrabber`'s `cornerRadius` 2.5 draws.
   *
   * So the pill is **108 x 15 device px = 36 x 5 pt**, its top 15 px (5.0 pt) below the panel's top
   * edge (216 px, itself a hard edge), centred on 602.5 against a screen centre of 603.
   *
   * This supersedes the 35 x 4.6667 that a 2D area fit read off the collapsed capture. That fit was
   * careful, but it was fitting a **luma-tracking vibrancy view over a photograph**, where the pill's
   * own colour changes across it and the fit has to model the background per column; here the pill is
   * over one flat colour with hard edges and the box is read directly. Three sources now agree -
   * `-[_UIGrabber intrinsicContentSize]` {36, 5}, its `cornerRadius` 2.5, and this capture - against
   * one fit over a photograph, so the framework number wins and the earlier 105 x 14 is recorded here
   * as what a vibrancy composite measures rather than as the layer's box.
   *
   * The pill's colour came off the same rows - (197,197,198) on a ground that is #ffffff for at least
   * nine pixels on every side, so over white the fill is (255 - 197) / 255 = 0.227 of black. That
   * lives on `--ios-pp-grabber` with the rest of the palette rather than here, so there is one source
   * for it; see the note above `vars`.
   */
  grabber: { width: 36, height: 5, radius: 2.5, top: 5 },
  /**
   * **Measured on the device**, off the numbered badge in `scratchpad/photostates/state0.png`: a
   * selected tile whose flat magenta fill puts the badge's white rim against a single known colour,
   * so both edges are read to a hundredth of a pixel rather than fitted.
   *
   * Through the badge's centre row (y 915) and centre column (x 351), with coverage taken in the
   * channel of largest contrast:
   *
   * | | device px | pt |
   * |---|---|---|
   * | outer white ink | 316.896 - 385.906 across, 881.230 - 950.225 down: **69.01 / 68.99** | **23.00** |
   * | blue disc | 321.396 - 381.400 across, 885.733 - 945.729 down: **60.00 / 60.00** | **20.00** |
   * | white rim | (69.0 - 60.0) / 2 = 4.5 | **1.50** |
   * | ink inset from the tile's trailing edge | 399 - 385.906 = 13.09 | 4.365 |
   * | ink inset from the tile's bottom edge | 963 - 950.225 = 12.78 | 4.258 |
   *
   * The two insets agree to 0.3 px on **13 device px = 4.3333 pt**, and the fill samples exactly
   * `rgb(0 136 255)`, which is the blue the Catalyst probe already read. The blue disc is not a field
   * of its own because `size - 2 x rim` already is it, to the measurement: 23 - 3 = **20.00**.
   *
   * **What this overturns.** The probe's `+[PXSelectionBadgeUIViewTile preferredSize]` {26, 26} and
   * `-[PUPhotosGridCell layoutSubviews]` 3.5 pt cell inset are real, but composing them - 3.5 plus the
   * 2 pt margin a 22 pt ink leaves inside a 26 pt box - gives an ink of 22.0 at an inset of 5.5, and
   * the device draws **23.0 at 4.3333**. The measured pair does not decompose into that {26, 26} / 3.5
   * pair at all (a 23 ink in a 26 box would sit at 2.833, in a 24 box at 3.833), so the composition was
   * the error, not either reading: `PUPhotosGridCell` is the *Photos app's* grid cell, and this sheet
   * is not it. The capture wins, and `box` is dropped because nothing here measures a box.
   *
   * **The badge in this picker is numbered, not a checkmark.** The device draws "1" in the disc on the
   * first-picked tile, which is why `ordered` now defaults to true - see the prop.
   *
   * `fontSize` 13 is no longer a guess either. Masking the white ink to a circle of radius 26 px inside
   * the disc, the device's "1" measures **12 x 27 device px** and ours at 13 pt semibold measures
   * **13 x 27** - the same 27 px (9.0 pt) cap height, one pixel apart on the flag. What is still off by
   * a hair is where the glyph sits: the device centres its ink 0.27 px *below* the badge centre and
   * ours lands 1.16 px above it, a 1.4 px (0.47 pt) lift that comes out of `lineHeight: 1` against SF's
   * own metrics. Left as it is rather than nudged, because a hard-coded offset would be fitting one
   * digit's ink box rather than the layout rule.
   */
  badge: { size: 23, inset: 4.3333, rim: 1.5, checkStroke: 1.4248, fill: "#0088ff", fontSize: 13 },
  /**
   * Where the panel sits relative to the composer in the capture, which nothing else records: the
   * composer's field ends at 463.6667 and the panel starts at 485, and the composer keeps its `+`,
   * its "iMessage" placeholder and its mic (the plus-menu state, SPEC.md line 162, collapses it to
   * mic-only; this one does not).
   */
  composer: { fieldBottom: 463.6667, gap: 21.3333 },
  /**
   * **The expanded detent, measured on the device at last** — from `scratchpad/photostates/state0.png`,
   * the Messages picker dragged open with one photo picked. Everything in `detents.expanded` and in
   * `header` above was invented against a collapsed-only capture, and almost none of it survives.
   *
   * | Part | Device | What this file draws today |
   * |---|---|---|
   * | panel top | **72.0** (216 px, a hard edge) | 165 |
   * | side and bottom inset | **0** — the grid runs to x 0 and x 1205, and the panel reaches the screen's bottom | 5.3333 on all three |
   * | grid top | **188.0** (564 px) | the panel top |
   * | header height | **116.0** (panel top to grid top) | 76-ish of title + search row |
   * | grabber | unchanged: 36 x 5 at top 5.0, centred | same |
   * | tile | 398.667 x 399 device px = **132.889 x 133.0** | 129.33 square-ish |
   * | gap | 5 device px, same as collapsed | same |
   * | search row | **none** | a 44 pt row with a 34 pt field |
   *
   * The header holds, top to bottom: the grabber; a centred title, "Select up to 20 items." (dark ink
   * spanning y 313-348 device px); then one row of controls at y 380-507 — a white "Clear" capsule on
   * the left starting at x 48, a "Photos | Collections" segmented control in the middle, and a **blue
   * circular confirm button** on the right carrying a white check. That button measures **O 131.3
   * device px = 43.8 pt** (its edge is soft over ~3 px, so 44 is inside the reading), centred on
   * (1091.5, 443.9) px = (363.83, 147.97) pt, with its right edge 48.4 px = 16.1 pt inside the screen.
   *
   * **Why `detents.expanded` was not just changed to match.** The height is the smallest part of this:
   * the device's expanded detent is a different *surface*, with a title, a Clear button, a two-way
   * segmented control and a confirm button that this component does not draw, and whose grid is full
   * bleed rather than inset. Moving the panel top from 165 to 72 without any of that would put 116 pt
   * of empty white above the grid and call it measured. So the numbers are recorded here as the spec
   * for building that state, and the invented ones above are left flagged as invented until someone
   * does. What *is* fixed from this capture is everything that the two detents share: the grabber, the
   * gap, and the selection badge.
   */
  expandedDetent: { top: 72, inset: 0, gridTop: 188, headerHeight: 116, tileWidth: 132.889, tileHeight: 133, confirmSize: 43.8, confirmCentre: { x: 363.83, y: 147.97 }, confirmInset: 16.1 },
  /**
   * `collapsed` is the capture's own height. `expanded` is still the invented one, and it is now known
   * to be wrong - see `expandedDetent` below for what the device does and why this was not simply
   * swapped for it.
   * @unverified expanded, handle
   */
  detents: { collapsed: 383.6667, expanded: 703.6667, handle: 24 },
  /**
   * The expanded detent's header. Every number here is judgement except the search row, which is
   * `sticker-picker.tsx`'s framework pair (`-[UISearchBar sizeThatFits:]` 44 and
   * `-[UISearchTextField sizeThatFits:]` 34) at SF Medium 17.
   *
   * The device's expanded header is **not this**: it has no search row at all. See `expandedDetent`.
   * @unverified everything except rowHeight and fieldHeight
   */
  header: { titleTop: 16, titleSize: 17, actionSize: 17, searchTop: 8, rowHeight: 44, fieldHeight: 34, fieldRadius: 17, fieldSize: 17, inset: 12, bottom: 8 },
  /**
   * @unverified enter and exit are the long-press menu's measured 380 / 220, borrowed; `badge` and
   * `detent` are invented, and so are both easing curves below.
   */
  timing: { enter: 380, exit: 220, badge: 150, detent: 320 },
  /** @unverified invented outright; no recording of this panel moving exists. */
  easing: { enter: "cubic-bezier(0.32, 0.72, 0, 1)", exit: "cubic-bezier(0.4, 0, 1, 1)" },
} as const;

/** Which Messages this picker is standing in. See `macPhotoPickerMetrics` for what changes. */
export type PhotoPickerPlatform = "ios" | "macos";

/**
 * # The macOS presentation
 *
 * macOS Messages does not put the Photos browser in a sheet. The "+" is a **menu** there and not the
 * iPhone's app strip — `-[CKUIBehaviorMac browserButtonShouldUseMenu]` is YES where the Phone's is
 * NO, and `entryViewSupportsBrowserButton` is NO on both — so its "Photos" row opens a **popover
 * anchored to the "+" button**, sized to its content and wearing the window's own material. Nothing
 * about the iOS panel survives that: no grabber, no detents, no sheet corners, no bottom-edge inset,
 * and no slide up from the screen's bottom edge, which in a desktop window put a sliver of tiles
 * below the window itself.
 *
 * ## Measured — ChatKit 26.5 at idiom 5
 *
 * A Catalyst probe (`clang -target arm64-apple-ios26.0-macabi`, dlopen ChatKit, `-[UIDevice
 * userInterfaceIdiom]` swizzled to 5 **before** anything latches it) then `+[CKUIBehavior
 * sharedBehaviors]`, which vends `CKUIBehaviorMac`. The idiom-0 reading is beside each one, because
 * the Mac does not inherit the Phone and the pair is the whole point:
 *
 * | Selector | idiom 5 (Mac) | idiom 0 (Phone) |
 * |---|---|---|
 * | `popOverWidth` | **252** | absent |
 * | `popOverMaxHeight` | **400** | absent |
 * | `popoverPadding` | **7** | absent |
 * | `popoverHeightPadding` | **16** | absent |
 * | `attachmentBrowserGridSectionInset` | {8, 8} | {8, 8} |
 * | `attachmentBrowserGridInterItemSpacing` | 4 | 4 |
 * | `attachmentBrowserGridMinimumLineSpacing` | 4 | 4 |
 * | `attachmentBrowserDefaultSizeForSquare` | **{104, 104}** | **{72.5, 72.5}** |
 * | `searchPhotosCellCornerRadius` | **8** | **0** |
 *
 * Two readings in that table are narrower than they look, and both are recorded rather than hidden.
 * `attachmentBrowserDefaultSizeForSquare` returns a `CGSize`, not a scalar - it is square, so the
 * one number is the whole of it, but the selector is not a length. And `searchPhotosCellCornerRadius`
 * names the cell in *search*, not the attachment browser's; nothing on either class names the
 * browser tile's corner, so 8 is that neighbour's radius borrowed, which is why the tile carries it
 * as a `clip-path` and not as a measured token.
 *
 * There is **no** photo-specific popover selector on either class: the whole
 * `browser|picker|popover|photo|grid|sticker` selector list on `CKUIBehaviorMac` and on the base
 * `CKUIBehavior` was dumped and holds no `photoPopoverSize` or `browserPopoverSize`. So the Photos
 * row takes the generic Mac popover, 252 x 400, and that is what `width` / `maxHeight` are.
 *
 * The **chrome** is the one macOS popover a capture in this repo does hold: the fill, the bright
 * inset rim, the dark hairline outside it and the 12 pt corner `macos-plus-menu.tsx` measured off
 * `references/macos/captures/plus-menu-{light,dark}-2x.png`. Those values are copied here rather
 * than imported, so this file stays a registry item with no dependency of its own — the same copy
 * `macos-messages-app.tsx` keeps, for the same reason.
 *
 * The **anchor** is measured too, at one remove: `macos-plus-menu.tsx` puts the menu's left edge on
 * the "+" button's left edge at pane x 9 and its top edge 3 pt inside the button's bottom at pane
 * y 626, which places the button's bottom at 629; `macos-composer.tsx` measures the button 30 square
 * with its own bottom 11 above the composer's, so the button is `{9, 599, 30, 30}` in a 640 pt pane
 * and sits **41 pt above the pane's bottom edge**. That last form is what `anchor` records, because
 * it is the one that survives a pane of another height. At run time the button is *found* rather
 * than assumed — see `useMacPopoverPlacement` — so a caller that moves it keeps the arrow.
 *
 * ## Derived, not read
 *
 * - **Columns.** 252 less `popoverPadding` on each side is 238; less the grid's own 8 pt section
 *   inset on each side is 222. At the measured 104 square and 4 pt spacing that is
 *   `floor((222 + 4) / 108)` = **2** columns, and the tiles then stretch to 109 to fill the row.
 *   The stretch is the rule this file's iOS grid already follows (its 5 columns of 72.73 come out of
 *   ChatKit's 72.5 the same way), not a new invention — but the 109 itself is arithmetic, not a
 *   reading.
 * - **Height.** `popoverHeightPadding` = 16 is measured; that it is 8 above and 8 below rather than
 *   16 of something else is an assumption. The box is the grid's own height plus that 16, capped at
 *   the measured `popOverMaxHeight`, which is what "sized to its content" means here.
 *
 * ## Not measured, and marked
 *
 * - **The arrow.** No capture in `references/macos/captures` holds a Messages attachment popover.
 *   ChatKit has no arrow metric. UIKit's own `+[_UIPopoverStandardChromeView arrowHeight]` reads
 *   **0** under Catalyst, because AppKit draws the chrome there, and AppKit exposes none
 *   (`_NSPopoverFrame` does not exist in macOS 26). So the arrow's size and its outline are
 *   invented. Where it *points* is measured — the "+" button's centre — except that a 12 pt corner
 *   will not let a 22 pt arrow sit closer than 23 pt to the box's edge, so at this anchor the tip
 *   lands 8 pt right of the button's centre. That clamp is what UIKit does too.
 * - **The motion.** Borrowed whole from `macPlusMenuMetrics.motion`, which is itself borrowed: 160
 *   ms in, 120 ms out, from 0.96 at the anchor corner. Nothing records this popover opening.
 * - **The tile aspect.** The iOS capture's tiles are 0.6 device px taller than they are wide; the
 *   Mac square is `attachmentBrowserDefaultSizeForSquare`, so these are square. That is a reading of
 *   the selector's name, not of a capture.
 */
export const macPhotoPickerMetrics = {
  /** `-[CKUIBehaviorMac popOverWidth]` and `popOverMaxHeight`. */
  width: 252,
  maxHeight: 400,
  /** `-[CKUIBehaviorMac popoverPadding]`: what the popover keeps clear left and right of its content. */
  padding: 7,
  /**
   * `-[CKUIBehaviorMac popoverHeightPadding]`. Measured at 16; that it splits 8 above and 8 below is
   * an assumption, since nothing says whether it is a total or a per-edge value.
   * @unverified the split
   */
  heightPadding: 16,
  /**
   * The attachment browser's grid, all at idiom 5. `cell` is a *target*: the column count comes out
   * of it and the tiles then stretch to fill, exactly as the iOS grid does with ChatKit's 72.5.
   */
  grid: { inset: 8, gap: 4, cell: 104, tileRadius: 8 },
  /** Measured off `plus-menu-{light,dark}-2x.png` by `macos-plus-menu.tsx`; copied, not imported. */
  radius: 12,
  /**
   * The "+" button, expressed as a distance up from the pane's bottom edge so it survives a pane of
   * another height: `macComposerMetrics.bottom` 11 + `plus.size` 30 = 41, at `plus.left` 9.
   * Only the fallback: the button is looked up in the DOM when it is there.
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
 * the caller passing anything. Every value is `macos-plus-menu.tsx`'s, copied rather than imported
 * so this file keeps no dependency of its own.
 */
const macVars =
  "[--mac-pp-fill:rgba(238,240,241,0.92)] [--mac-pp-edge:inset_0_0_0_1px_rgba(255,255,255,0.8),0_0_0_0.5px_rgba(0,0,0,0.28),0_4px_16px_rgba(0,0,0,0.12)] [--mac-pp-outline:rgba(0,0,0,0.28)] " +
  "dark:[--mac-pp-fill:rgba(37,39,40,0.94)] dark:[--mac-pp-edge:inset_0_0_0_1px_rgba(255,255,255,0.28),0_0_0_0.5px_rgba(0,0,0,0.85),0_4px_16px_rgba(0,0,0,0.35)] dark:[--mac-pp-outline:rgba(0,0,0,0.85)]";

/**
 * A host that wraps this picker in its own popover box — `macos-messages-app.tsx` does, from before
 * the picker knew what a Mac was — would otherwise double the material: two fills, two rims, two
 * shadows. These rules switch that box off *only* when the picker inside it is drawing the macOS
 * popover itself, and take back the clip the same host forces on this component so the arrow is not
 * cut off. Both selectors outrank the host's, so they win wherever the two stylesheets land.
 */
const macHostInteropCss = `[data-slot="mac-attachment-popover"]:has(> [data-slot="photo-picker"][data-platform="macos"]),
[data-slot="mac-attachment-popover"]:has([data-slot="photo-picker"][data-platform="macos"]) > [aria-hidden="true"]:not([data-slot]){background:transparent!important;box-shadow:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;overflow:visible!important}
[data-slot="mac-attachment-popover"] [data-slot="photo-picker"][data-platform="macos"]{clip-path:none!important;background:transparent!important}`;

/**
 * Where the popover sits, in the coordinates of whatever box the picker was dropped into.
 *
 * The "+" button is *found*, not assumed: the nearest `[data-im-platform]` ancestor is searched for
 * `[data-slot="attach-button"]`, which is the slot `macos-composer.tsx` puts on it. That is what lets
 * the same component be right inside the app shell's own popover wrapper (a 252 pt box at pane x 9)
 * and inside a bare pane in a lab route, without either caller passing coordinates. When there is no
 * button to find, `macPhotoPickerMetrics.anchor` stands in, measured from the pane's bottom edge.
 *
 * It always opens **upward**. That is the measured rule, not a preference: neither Mac popover fits
 * below a button whose bottom is 11 pt off the floor of a 640 pt window, and an AppKit popover flips
 * rather than hangs.
 */
function useMacPopoverPlacement(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
  box: { width: number; height: number },
  arrow: { width: number; height: number },
  radius: number,
  /** Which composer button the popover hangs off. The smiley opens the sticker one too. */
  anchorSlot: string,
) {
  const [placement, setPlacement] = useState<{ left: number; top: number; arrowX: number } | null>(null);
  const last = useRef<{ left: number; top: number; arrowX: number } | null>(null);
  useLayoutEffect(() => {
    const node = root.current;
    if (!enabled || !node) return;
    const place = () => {
    /**
     * The origin is taken through `offsetParent`, not from `node.getBoundingClientRect()`, and the
     * difference is a bug that only showed on the path a person actually takes.
     *
     * `useHostPlatform` sniffs in a layout effect, so the first client commit renders the *iOS*
     * branch. Both branches return a `<div>` in the same slot, so React reuses the DOM node, and the
     * iOS entrance animation - `fill: "both"`, `translateY(restHeight + inset)` - is still on that
     * node when the sniff flips to macOS and this effect runs. A rect taken then is 393 pt low, the
     * placement is committed against it, and when the animation goes away the popover is left 393 pt
     * high: `top: -398px`, arrow pointing at the header, over the sidebar and the titlebar. Every
     * screenshot missed it because `/harness?scene=photo-picker` mounts with `progress` set (the
     * animation is seeked, not running) and `/lab/macos-pickers` passes `platform="macos"` (there is
     * no iOS commit at all).
     *
     * `offsetLeft`/`offsetTop`/`offsetWidth`/`offsetHeight` are layout, so the node's own transform
     * cannot reach them; the parent's rect is still a rect, so a transform on an *ancestor* is kept,
     * which is right - the button's rect lives in that same space.
     */
    const parent = node.offsetParent;
    let base: { left: number; top: number; width: number; height: number };
    if (parent instanceof HTMLElement) {
      const box = parent.getBoundingClientRect();
      const edge = getComputedStyle(parent);
      base = {
        left: box.left + parseFloat(edge.borderLeftWidth) + node.offsetLeft,
        top: box.top + parseFloat(edge.borderTopWidth) + node.offsetTop,
        width: node.offsetWidth,
        height: node.offsetHeight,
      };
    } else {
      const box = node.getBoundingClientRect();
      base = { left: box.left, top: box.top, width: box.width, height: box.height };
    }
    const host = node.closest("[data-im-platform]") ?? node.ownerDocument.body;
    const button = host.querySelector(`[data-slot="${anchorSlot}"]`);
    const rect = button?.getBoundingClientRect();
    const a = macPhotoPickerMetrics.anchor;
    // In the root's own coordinates, so the caller's box can be the pane or a wrapper inside it.
    const anchor = rect
      ? { left: rect.left - base.left, top: rect.top - base.top, width: rect.width }
      : { left: a.left, top: base.height - a.aboveBottom, width: a.size };
    // Flush with the button's left edge, the way the "+" menu's own measured left edge is, and pulled
    // back inside the box it was dropped into when that box is wide enough to have an inside.
    const left = base.width > box.width ? Math.max(0, Math.min(anchor.left, base.width - box.width)) : anchor.left;
    // The arrow points at the button's centre, but never closer to a corner than the corner's own
    // radius plus half the arrow — past that it would come out of the curve. UIKit clamps it too.
    const inset = radius + arrow.width / 2;
    const centre = anchor.left + anchor.width / 2 - left;
    // Measuring the DOM and rendering against what came back is the one thing a layout effect is
    // for, and it cannot be lifted into render: the "+" button does not exist until the commit.
    // The pose is committed before the browser paints, so no frame shows the popover unplaced.
    const next = {
      left,
      top: anchor.top - arrow.height - box.height,
      arrowX: Math.max(inset, Math.min(centre, box.width - inset)),
    };
    const previous = last.current;
    if (previous && previous.left === next.left && previous.top === next.top && previous.arrowX === next.arrowX) return;
    last.current = next;
    setPlacement(next);
    };
    place();
    // The measurement is only as good as the frame it was taken in: the "+" button can still be
    // moving when the shell mounts. Re-measuring on the next frame and on any resize of the host
    // costs one comparison when nothing has changed, and the comparison above makes a re-place that
    // agrees with the last one a no-op rather than a render.
    const frame = requestAnimationFrame(place);
    const host = node.closest("[data-im-platform]") ?? node.ownerDocument.body;
    const observer = new ResizeObserver(place);
    observer.observe(host);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [root, enabled, box.width, box.height, arrow.width, arrow.height, radius, anchorSlot]);
  return placement;
}

/**
 * Reads the platform off the DOM when the caller did not say. The macOS shell stamps
 * `data-im-platform="macos"` on its root, so a picker dropped anywhere inside it gets the macOS
 * presentation with nothing passed — which is what `macos-messages-app.tsx` does today, since it
 * predates this component knowing about platforms. It is a layout effect, so a client-mounted picker
 * is never painted in the wrong presentation; a picker that is *server*-rendered already open shows
 * one iOS frame before the effect runs, which is why the `platform` prop exists.
 */
function useHostPlatform(root: RefObject<HTMLElement | null>, override?: PhotoPickerPlatform): PhotoPickerPlatform {
  const [sniffed, setSniffed] = useState<PhotoPickerPlatform>("ios");
  useLayoutEffect(() => {
    if (override) return;
    const host = root.current?.closest("[data-im-platform]");
    // Same reason: the ancestor that says which Messages this is cannot be read during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a DOM read, see above
    setSniffed(host?.getAttribute("data-im-platform") === "macos" ? "macos" : "ios");
  }, [root, override]);
  return override ?? sniffed;
}

/**
 * Light values are measured off the capture, except the two `tertiarySystemFill` alphas, which are
 * `+[UIColor tertiarySystemFillColor]` read in both styles (that family does come back with the iOS
 * values under Catalyst). The dark panel and tile are unverified: see the file comment for why the
 * probe cannot settle them. They are custom properties so a `.dark` ancestor flips the panel without
 * the caller passing anything.
 *
 * `--ios-pp-grabber` is no longer one of the unverified ones **in light**. In the expanded detent the
 * pill sits on the panel's own flat fill, and `scratchpad/photostates/state0.png` reads it at
 * (197,197,198) with #ffffff on every side of it for at least nine pixels - so over white the fill is
 * (255 - 197) / 255 = **0.227** of black, not the 0.3 this file used to carry, which composites to
 * 178.5 and is 18.5/255 too dark. The blue channel wants 0.222 rather than 0.227, a 1/255 lean that a
 * single alpha cannot carry and that is not worth a second token. The **dark** value is still a
 * guess: no dark capture of this panel exists.
 */
const vars =
  "[--ios-pp-panel:#ffffff] [--ios-pp-grabber:rgba(0,0,0,0.227)] [--ios-pp-tile:#e9e9eb] [--ios-pp-badge:#0088ff] [--ios-pp-glyph:#ffffff] [--ios-pp-label:#000000] [--ios-pp-muted:#8a8a8e] [--ios-pp-field:rgba(118,118,128,0.12)] " +
  "dark:[--ios-pp-panel:#1c1c1e] dark:[--ios-pp-grabber:rgba(255,255,255,0.3)] dark:[--ios-pp-tile:#2c2c2e] dark:[--ios-pp-badge:#0088ff] dark:[--ios-pp-glyph:#ffffff] dark:[--ios-pp-label:#f4f3f4] dark:[--ios-pp-muted:#97979d] dark:[--ios-pp-field:rgba(118,118,128,0.24)]";

/** Keeps a hidden string in the accessible name without depending on the consumer's utility classes. */
const offscreen: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

export type PhotoPickerPhoto = {
  /** Stable identity for selection. Falls back to the index. */
  id?: string;
  /** A URL, or nothing for a solid `fill`. The registry itself ships no photographs. */
  src?: string;
  alt?: string;
  /** Any CSS background, used when there is no `src` and when a `src` fails to load. */
  fill?: string;
};

/** Which of the two heights the panel is resting at. */
export type PhotoPickerDetent = "collapsed" | "expanded";

/**
 * Placeholder tiles in the tonal range of the capture's landscapes, so the geometry can be reviewed
 * without shipping anyone's photographs in a registry item.
 */
export const photoPickerSamples: PhotoPickerPhoto[] = [
  { id: "bloom", fill: "linear-gradient(160deg, #c8175f 0%, #e8408a 45%, #7a8f2e 100%)" },
  { id: "falls", fill: "linear-gradient(180deg, #8fa2ad 0%, #4e6b5a 55%, #26361f 100%)" },
  { id: "cascade", fill: "linear-gradient(200deg, #8d9aa1 0%, #55605c 50%, #2a3128 100%)" },
  { id: "canyon", fill: "linear-gradient(170deg, #9fb0b8 0%, #5c7a5f 45%, #2c3a24 100%)" },
  { id: "dune", fill: "linear-gradient(190deg, #b7c9cf 0%, #7f9a63 55%, #b52f57 100%)" },
  { id: "leaf", fill: "linear-gradient(150deg, #7fa04a 0%, #3f5c25 60%, #d9c02f 100%)" },
];

export type PhotoPickerProps = Omit<ComponentProps<"div">, "onSelect" | "children"> & {
  /**
   * The composer button this popover hangs off on the Mac, by `data-slot`. Defaults to the "+", which
   * is what opens it from the plus menu; the smiley passes its own so the arrow points at the button
   * that was actually pressed rather than always at the "+".
   */
  anchorSlot?: string;
  /**
   * Which Messages to be. Left off, it is read from the nearest `[data-im-platform]` ancestor, so
   * the macOS shell gets the macOS popover without passing anything. See `macPhotoPickerMetrics`.
   */
  platform?: PhotoPickerPlatform;
  photos?: PhotoPickerPhoto[];
  /** Controlled selection, as photo ids, in the order they were picked. */
  selected?: string[];
  defaultSelected?: string[];
  /** Fires with the whole selection, plus the photo that just changed and its new state. */
  onSelectionChange?: (selected: string[], photo: PhotoPickerPhoto, isSelected: boolean) => void;
  /** False keeps one tile chosen at a time. */
  multiple?: boolean;
  /**
   * Number the badges in pick order. **Defaults to true, because the device does it**: the Messages
   * picker in `scratchpad/photostates/state0.png` draws "1" inside the badge on the first-picked tile,
   * not a checkmark. Pass `false` for the plain check badge, which is what the Photos app's own select
   * mode draws and what `PhotoPickerSelectionBadge` still renders.
   */
  ordered?: boolean;
  columns?: number;
  /** Panel box. Defaults are the capture's; the tile size follows from `width`, `columns` and the gap. */
  width?: number;
  height?: number;
  inset?: number;
  /** The taller detent's height. Unmeasured: see the file comment. */
  expandedHeight?: number;
  /** Controlled detent. Uncontrolled unless this is passed. */
  detent?: PhotoPickerDetent;
  defaultDetent?: PhotoPickerDetent;
  onDetentChange?: (detent: PhotoPickerDetent) => void;
  /** False takes the grabber away, and with it the drag between detents. */
  grabber?: boolean;
  /** The expanded detent's header: the title, the trailing action and the search row. */
  title?: string;
  albumsLabel?: string;
  onAlbums?: () => void;
  search?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** False plays the exit timeline and then calls `onExited`. */
  open?: boolean;
  onExited?: () => void;
  /**
   * Seek whichever direction `open` selects to this fraction (0..1) instead of playing it, which is
   * what the harness does. A seeked exit poses the panel and never reports through `onExited`.
   */
  progress?: number;
  /** Accessible name for the grid. */
  label?: string;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const idOf = (photo: PhotoPickerPhoto, index: number) => photo.id ?? String(index);

/**
 * The badge PhotosUICore draws on a selected tile: a blue disc inside a white rim, with a white
 * check. Every number is the 12x render of `+[PXSelectionBadgeUIViewTile preferredSize]`'s own
 * image, measured in the file comment; the view box is the badge's ink, so the caller only has to
 * place a square.
 */
export function PhotoPickerSelectionBadge({ size = photoPickerMetrics.badge.size }: { size?: number }) {
  const m = photoPickerMetrics.badge;
  const r = m.size / 2;
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox={`0 0 ${m.size} ${m.size}`} fill="none">
      {/* The disc runs under the rim's inner half so the two cannot leave an anti-aliased seam. */}
      <circle cx={r} cy={r} r={r - m.rim / 2} fill="var(--ios-pp-badge)" />
      <circle cx={r} cy={r} r={r - m.rim / 2} stroke="var(--ios-pp-glyph)" strokeWidth={m.rim} />
      {/* Centreline of the framework's own check, moved from badge-centre coordinates into the box. */}
      <path
        d={`M${r - 4.408} ${r + 0.941}L${r - 1.334} ${r + 4.67}L${r + 3.957} ${r - 3.645}`}
        stroke="var(--ios-pp-glyph)"
        strokeWidth={m.checkStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The magnifier traced for the conversation list's search pill, at 0.72 of the size it is drawn there. */
function SearchGlyph({ scale = 0.72 }: { scale?: number }) {
  return (
    <svg aria-hidden="true" width={18.3333 * scale} height={18.6667 * scale} viewBox="-1 -1 18.3333 18.6667" fill="none" stroke="var(--ios-pp-muted)" strokeLinecap="round">
      <circle cx="6.745" cy="7.219" r="5.883" strokeWidth="1.725" />
      <path d="M11.4 12.01 15.17 15.78" strokeWidth="2.467" />
    </svg>
  );
}

export function PhotoPicker({
  platform: platformProp,
  anchorSlot = "attach-button",
  photos = photoPickerSamples,
  selected: selectedProp,
  defaultSelected,
  onSelectionChange,
  multiple = true,
  ordered = true,
  columns = photoPickerMetrics.columns,
  width = photoPickerMetrics.width,
  height = photoPickerMetrics.height,
  inset = photoPickerMetrics.inset,
  expandedHeight = photoPickerMetrics.detents.expanded,
  detent: detentProp,
  defaultDetent = "collapsed",
  onDetentChange,
  grabber = true,
  title = "Recents",
  albumsLabel = "Albums",
  onAlbums,
  search = true,
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search",
  open = true,
  onExited,
  progress,
  label = "Recent photos",
  className,
  style,
  ...props
}: PhotoPickerProps) {
  const m = photoPickerMetrics;
  const [internal, setInternal] = useState<string[]>(defaultSelected ?? []);
  const selected = selectedProp ?? internal;
  const [internalDetent, setInternalDetent] = useState<PhotoPickerDetent>(defaultDetent);
  const detent = detentProp ?? internalDetent;
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  /** Live drag, or null. `from` is the height the drag started at, so the pose is pure arithmetic. */
  const [drag, setDrag] = useState<{ pointer: number; startY: number; from: number; y: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** The macOS popover's own box, which is what the presentation animates. */
  const macBox = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const exited = useRef(false);
  /** Set by the arrow keys, consumed after the render that puts the tile in the window. */
  const pendingFocus = useRef<number | null>(null);
  /**
   * The callback lives in a ref, not in the timeline effect's dependencies. A caller that passes an
   * inline arrow hands us a new identity on the render `onExited` itself causes, and a dependency on
   * it would tear the finished exit down and start it again from the top.
   */
  const exitedCallback = useRef(onExited);
  /**
   * How far the exit has to travel, kept in a ref rather than in the timeline's dependencies. A
   * detent change moves it, and a dependency on it would replay the entrance on a panel that is
   * already open.
   */
  const awayDistance = useRef(0);

  const platform = useHostPlatform(panel, platformProp);
  const mac = platform === "macos";
  const mm = macPhotoPickerMetrics;

  /**
   * The macOS popover's box, sized to its content. Width and the cap are ChatKit's; the column count
   * and the tile size fall out of them, and the height is however many rows that makes, plus the
   * measured `popoverHeightPadding`, capped at the measured `popOverMaxHeight`. All of it is pure
   * arithmetic over `photos.length`, so it is available during render and the placement effect can
   * depend on it.
   */
  const macContentWidth = mm.width - mm.padding * 2;
  const macGridWidth = macContentWidth - mm.grid.inset * 2;
  const macColumns = Math.max(1, Math.floor((macGridWidth + mm.grid.gap) / (mm.grid.cell + mm.grid.gap)));
  const macTile = (macGridWidth - (macColumns - 1) * mm.grid.gap) / macColumns;
  const macRows = Math.max(1, Math.ceil(photos.length / macColumns));
  const macGridHeight = mm.grid.inset * 2 + macRows * macTile + (macRows - 1) * mm.grid.gap;
  const macHeight = Math.min(mm.maxHeight, Math.round(macGridHeight + mm.heightPadding));

  const placement = useMacPopoverPlacement(panel, mac, { width: mm.width, height: macHeight }, mm.arrow, mm.radius, anchorSlot);

  const collapsedHeight = height;
  /**
   * The panel's height is derived during render, never stored: at rest it is the detent's, and under
   * a finger it is the drag's own arithmetic. Nothing has to be cleaned up when the drag ends.
   */
  const restHeight = detent === "expanded" ? expandedHeight : collapsedHeight;
  const panelHeight = drag
    ? Math.max(collapsedHeight, Math.min(expandedHeight, drag.from + (drag.startY - drag.y)))
    : restHeight;
  useEffect(() => {
    exitedCallback.current = onExited;
    awayDistance.current = restHeight + inset;
  });

  const setDetent = useCallback(
    (next: PhotoPickerDetent) => {
      if (detentProp === undefined) setInternalDetent(next);
      if (next !== detent) onDetentChange?.(next);
    },
    [detent, detentProp, onDetentChange],
  );

  const toggle = useCallback(
    (photo: PhotoPickerPhoto, id: string) => {
      const isSelected = selected.includes(id);
      const next = isSelected
        ? selected.filter(entry => entry !== id)
        : multiple
          ? [...selected, id]
          : [id];
      if (selectedProp === undefined) setInternal(next);
      onSelectionChange?.(next, photo, !isSelected);
    },
    [selected, selectedProp, multiple, onSelectionChange],
  );

  /**
   * The row height comes from the tile's own measured aspect, not from `aspect-square`: the capture's
   * rows really are 0.6 device px taller than its columns are wide.
   */
  const gap = mac ? mm.grid.gap : m.gap;
  const gridColumns = mac ? macColumns : columns;
  const gridWidth = mac ? macGridWidth : width;
  const tileWidth = (gridWidth - (gridColumns - 1) * gap) / gridColumns;
  // The Mac's cell is `attachmentBrowserDefaultSizeForSquare`, so its tiles are square; the iOS
  // capture's really are 0.6 device px taller than they are wide.
  const tileHeight = mac ? tileWidth : tileWidth / m.tileAspect;
  const tileRadius = mac ? mm.grid.tileRadius : m.tileRadius;
  // Guarded: a caller that hands the panel a zero width would otherwise divide by zero windowing it.
  const stride = Math.max(1, tileHeight + gap);

  /**
   * Identity and accessible name are fixed against the *unfiltered* library, so a search cannot
   * renumber "Photo 3" or move a selection onto a different tile.
   */
  const items = photos.map((photo, index) => ({ photo, id: idOf(photo, index), name: photo.alt ?? `Photo ${index + 1}` }));
  const text = searchValue ?? query;
  const needle = text.trim().toLowerCase();
  const filtered = needle ? items.filter(item => item.name.toLowerCase().includes(needle)) : items;
  // Header visibility follows the detent, not the live drag: revealing it mid-drag would jump the
  // grid the moment the finger moved a pixel.
  // A popover has one size, so the detent, its header and its search row are iOS-only.
  const expanded = !mac && detent === "expanded";
  const headerHeight = expanded
    ? m.header.titleTop + m.header.rowHeight + (search ? m.header.searchTop + m.header.rowHeight : 0) + m.header.bottom
    : 0;

  /**
   * One tab stop for the whole grid, arrows to move inside it, the way a native grid behaves. The
   * roving index is clamped during render, so a library that shrinks under it cannot strand the tab
   * stop on a tile that is gone.
   */
  const activeIndex = Math.min(active, Math.max(0, filtered.length - 1));
  const rows = Math.ceil(filtered.length / gridColumns);
  const viewport = mac ? macHeight - mm.heightPadding - mm.grid.inset * 2 : Math.max(0, panelHeight - headerHeight);
  /**
   * Windowed, because a real library is thousands of tiles and every one of them would otherwise
   * carry an `<img>`. Two rows of overscan on each side, and the active row is always in range so
   * the keyboard can reach a tile that has scrolled away.
   */
  const firstRow = Math.max(0, Math.floor(scrollTop / stride) - 2);
  const lastRow = Math.min(rows - 1, Math.ceil((scrollTop + viewport) / stride) + 1);
  const visible = filtered.slice(firstRow * gridColumns, (lastRow + 1) * gridColumns);
  /**
   * The roving tab stop has to be a tile that exists. Scrolling the active tile out of the window
   * moves the stop to the first tile still drawn; focusing that one puts `active` back on it, so the
   * arrows carry on from wherever the eye is.
   */
  const tabStop = activeIndex >= firstRow * gridColumns && activeIndex <= lastRow * gridColumns + gridColumns - 1
    ? activeIndex
    : firstRow * gridColumns;

  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    scroller.current?.querySelector<HTMLButtonElement>(`[data-index="${index}"]`)?.focus();
  });

  /**
   * The panel takes the focus when it opens, not a tile and not the scroller.
   *
   * The picker is opened from the plus menu's Photos row, and that row unmounts in the same commit:
   * measured with a held touch, the focus fell to `body`, the arrows did nothing, and the first two
   * Tabs walked into the *composer behind the sheet* before they reached the grid. So the focus has
   * to move here. It moves to the panel rather than to a tile because a tile focused programmatically
   * while the finger is still down matches `:focus-visible` in Chrome and WebKit alike - the gesture
   * has not resolved, so the modality is still the keyboard default - and paints a blue ring around a
   * photo on a sheet the person opened by touch. The panel carries `outline-none`, so it paints
   * nothing, and `onPanelKeyDown` sends the first arrow into the grid, where a ring is right.
   *
   * No Tab trap, unlike `sticker-picker.tsx`: this sheet is not modal. Native keeps the composer live
   * underneath - it keeps its `+`, its placeholder and its mic - so Tab is allowed to leave.
   */
  useEffect(() => {
    // A scrubbed entrance must not move the caret: the harness seeks frames, it does not open sheets.
    if (!open || progress !== undefined) return;
    panel.current?.focus({ preventScroll: true });
  }, [open, progress]);

  /**
   * From the panel itself the first arrow enters the grid, at the roving tab stop, which is the tile
   * the eye is on. Every arrow after that is the grid's own, below.
   */
  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const index = event.key === "Home" ? 0 : event.key === "End" ? Math.max(0, filtered.length - 1) : tabStop;
    const tile = scroller.current?.querySelector<HTMLButtonElement>(`[data-index="${index}"]`);
    if (!tile) return;
    event.preventDefault();
    setActive(index);
    tile.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Arrows only steer the grid from inside it. Focused on the scroller itself they scroll it,
    // which is the only way a keyboard reaches a row that is not next to the roving tile.
    if (event.target === event.currentTarget) return;
    const step =
      event.key === "ArrowRight" ? 1
      : event.key === "ArrowLeft" ? -1
      : event.key === "ArrowDown" ? gridColumns
      : event.key === "ArrowUp" ? -gridColumns
      : 0;
    let next = step ? activeIndex + step : activeIndex;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = filtered.length - 1;
    if (!step && event.key !== "Home" && event.key !== "End") return;
    if (next < 0 || next >= filtered.length) return;
    event.preventDefault();
    // Scroll first, so the row the focus is about to land on is inside the window this render draws.
    const node = scroller.current;
    if (node) {
      const row = Math.floor(next / gridColumns);
      const top = row * stride;
      const bottom = top + tileHeight;
      let target = node.scrollTop;
      if (top < target) target = top;
      else if (bottom > target + node.clientHeight) target = bottom - node.clientHeight;
      if (target !== node.scrollTop) {
        node.scrollTop = target;
        setScrollTop(target);
      }
    }
    setActive(next);
    pendingFocus.current = next;
  };

  /**
   * The drag between detents. The pose is derived from `drag` during render; the pointer handlers
   * only record where the finger is, and the release picks the nearer detent.
   */
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!grabber || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ pointer: event.pointerId, startY: event.clientY, from: restHeight, y: event.clientY });
  };
  const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    setDrag({ ...drag, y: event.clientY });
  };
  const onHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const settled = drag.from + (drag.startY - drag.y);
    const midpoint = (collapsedHeight + expandedHeight) / 2;
    setDrag(null);
    setDetent(settled > midpoint ? "expanded" : "collapsed");
  };

  /**
   * One Web Animations timeline, run forwards or backwards, so `document.getAnimations()` reaches it
   * and `progress` can pause and seek either direction to a frame that renders identically every run.
   * Which direction it runs is read off the `open` prop during render, so the closing pose gets its
   * committed frames before `onExited` lets the caller unmount anything.
   *
   * The away pose is `height + inset`, not `height`: the panel is positioned by its bottom, so
   * translating it by its own height alone leaves the inset on screen.
   */
  useEffect(() => {
    const node = mac ? macBox.current : panel.current;
    if (!node) return;
    // Reopening arms the exit again, so a panel that opens and closes twice reports twice.
    if (open) exited.current = false;
    const closing = !open;
    const duration = closing ? (mac ? mm.motion.exit : m.timing.exit) : (mac ? mm.motion.enter : m.timing.enter);
    /*
     * A popover does not slide: it grows out of the "+" button's corner and fades, which is what
     * `macos-plus-menu.tsx` does with the same borrowed numbers. Sliding it the way the iOS sheet
     * does is what put a sliver of tiles below the *window's* bottom edge, because a desktop window
     * has no screen edge for a sheet to leave by.
     */
    const away = mac ? { opacity: 0, transform: `scale(${mm.motion.scale})` } : { transform: `translateY(${awayDistance.current}px)` };
    const settled = mac ? { opacity: 1, transform: "scale(1)" } : { transform: "translateY(0px)" };
    const finish = () => {
      if (exited.current) return;
      exited.current = true;
      exitedCallback.current?.();
    };
    // Scrubbing is inspection, not a dismissal: a seeked exit poses the panel and reports nothing.
    const reports = closing && progress === undefined;
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      if (!reports) return;
      const frame = requestAnimationFrame(finish);
      return () => cancelAnimationFrame(frame);
    }
    const animation = node.animate(closing ? [settled, away] : [away, settled], {
      duration,
      easing: closing ? (mac ? mm.motion.exitEase : m.easing.exit) : (mac ? mm.motion.enterEase : m.easing.enter),
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
  }, [open, progress, mac, mm.motion, m.timing.enter, m.timing.exit, m.easing.enter, m.easing.exit]);

  const field = (
    <div
      className="relative flex items-center"
      style={{ height: m.header.fieldHeight, borderRadius: m.header.fieldRadius, background: "var(--ios-pp-field)" }}
    >
      <span aria-hidden="true" className="pointer-events-none absolute flex" style={{ left: 10, top: (m.header.fieldHeight - 18.6667 * 0.72) / 2 }}>
        <SearchGlyph />
      </span>
      {/*
        No focus ring on the field, deliberately: the caret is a text field's focus indicator, and
        iOS draws nothing else around this one. A field is also the case where the modality heuristic
        does not help - both engines match `:focus-visible` on a text input however it was focused,
        so a `focus-visible:outline` here would paint on every tap, not only on a keyboard's. The
        classes that used to sit here painted nothing anyway, because `outline-none` on the same
        element leaves `outline-style: none` for `focus-visible:outline-2` to widen; they read as a
        ring that was meant to show, which is worse than not having them.
      */}
      <input
        type="search"
        data-slot="photo-picker-search"
        value={text}
        placeholder={searchPlaceholder}
        onChange={event => {
          if (searchValue === undefined) setQuery(event.target.value);
          onSearchChange?.(event.target.value);
        }}
        className="size-full bg-transparent outline-none placeholder:[color:var(--ios-pp-muted)] [&::-webkit-search-cancel-button]:appearance-none"
        style={{ paddingLeft: 34, paddingRight: 12, borderRadius: m.header.fieldRadius, fontSize: m.header.fieldSize, fontWeight: 500, color: "var(--ios-pp-label)" }}
      />
    </div>
  );

  /**
   * The grid. One subtree for both platforms: only the box it sits in, the column count, the tile
   * size and the tile corner change, and those are settled above.
   */
  const gridScroller = (
    <div
      ref={scroller}
      data-slot="photo-picker-scroller"
      // A scroll container has to be reachable by keyboard: without a tab stop the only way to
      // move the panel is to focus a tile that happens to be off screen.
      tabIndex={0}
      role="group"
      aria-label={label}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      className={cn("overflow-y-auto overflow-x-hidden [overscroll-behavior:contain] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0088ff]", mac ? null : "w-full")}
      // On the Mac the grid sits inside the popover's own `popoverPadding` and then inside the
      // browser grid's own 8 pt section inset, both measured; on iOS it is flush to the panel.
      style={mac
        ? { position: "absolute", left: mm.padding + mm.grid.inset, top: mm.heightPadding / 2 + mm.grid.inset, width: macGridWidth, height: viewport }
        : { height: viewport }}
    >
      {/* The full scroll height, with only the visible band of rows drawn inside it. */}
      <div style={{ position: "relative", height: Math.max(0, rows * stride - gap) }}>
        {/*
          A group of toggles, not a listbox: each tile keeps its own pressed state and the grid never
          owes the keyboard a single mandatory selection.
        */}
        <div
          data-slot="photo-picker-grid"
          className="grid select-none"
          style={{
            position: "absolute",
            top: firstRow * stride,
            left: 0,
            right: 0,
            gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
            gridAutoRows: `${tileHeight}px`,
            gap,
          }}
        >
          {visible.map(({ photo, id, name }, offset) => {
            const index = firstRow * gridColumns + offset;
            const order = selected.indexOf(id);
            const isSelected = order >= 0;
            const broken = failed.includes(id);
            return (
              <button
                key={id}
                type="button"
                data-slot="photo-picker-tile"
                data-index={index}
                data-selected={isSelected ? "true" : "false"}
                aria-label={name}
                aria-pressed={isSelected}
                tabIndex={index === tabStop ? 0 : -1}
                onFocus={() => setActive(index)}
                onClick={() => toggle(photo, id)}
                className="relative block size-full p-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0088ff]"
                style={{
                  background: photo.src && !broken ? "var(--ios-pp-tile)" : (photo.fill ?? "var(--ios-pp-tile)"),
                  // Clipped, not rounded, for the same reason the panel is; the focus ring is drawn
                  // inside the tile so the clip cannot swallow it.
                  clipPath: `inset(0 round ${tileRadius}px)`,
                }}
              >
                {photo.src && !broken ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={photo.src}
                    alt=""
                    aria-hidden="true"
                    loading="lazy"
                    decoding="async"
                    sizes={`${Math.round(tileWidth)}px`}
                    onError={() => setFailed(prev => (prev.includes(id) ? prev : [...prev, id]))}
                    className="absolute inset-0 size-full object-cover"
                    draggable={false}
                  />
                ) : null}
                {/* `aria-pressed` already says selected, so the hidden text only carries the pick order. */}
                {ordered && isSelected ? <span style={offscreen}>{`${order + 1} of ${selected.length}`}</span> : null}
                {/*
                  The badge never unmounts: it is always in the tree and only its opacity and scale
                  change, so a deselect gets the same committed frames a select does instead of
                  vanishing on the render that drops it. The 150 ms is unverified.
                */}
                <span
                  aria-hidden="true"
                  data-slot="photo-picker-badge"
                  className="pointer-events-none absolute flex items-center justify-center motion-safe:transition-[opacity,transform]"
                  style={{
                    right: m.badge.inset,
                    bottom: m.badge.inset,
                    width: m.badge.size,
                    height: m.badge.size,
                    transitionDuration: `${m.timing.badge}ms`,
                    opacity: isSelected ? 1 : 0,
                    transform: isSelected ? "scale(1)" : "scale(0.6)",
                  }}
                >
                  {ordered ? (
                    <>
                      {/*
                        The rim is drawn *inside* the box, not as a spread shadow outside it, so the
                        numbered badge and the check badge are the same circle: `size` is the outer
                        white ink the device measures at 23.0, and the blue disc is that less the rim
                        on each side, which lands on the measured 20.0. The old spread shadow made the
                        blue disc the full `size` and pushed the ink out to size + 2 x rim, so the two
                        branches drew badges of different diameters from the same constant.
                      */}
                      <span className="absolute inset-0 rounded-full" style={{ background: "var(--ios-pp-glyph)" }} />
                      <span className="absolute rounded-full" style={{ inset: m.badge.rim, background: "var(--ios-pp-badge)" }} />
                      <span className="relative" style={{ color: "var(--ios-pp-glyph)", fontSize: m.badge.fontSize, fontWeight: 600, lineHeight: 1 }}>
                        {isSelected ? order + 1 : ""}
                      </span>
                    </>
                  ) : (
                    <PhotoPickerSelectionBadge size={m.badge.size} />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  if (mac) {
    /*
     * The macOS popover. Its box is `popOverWidth` wide and as tall as its own grid, capped at
     * `popOverMaxHeight`; it wears the plus menu's measured material and 12 pt corner; and it grows
     * out of the "+" button rather than sliding up from an edge a desktop window does not have.
     * There is no grabber, no detent, no header and no search row, because a popover has one size.
     *
     * The root stays the box it was dropped into and only holds the coordinate space: it is the
     * popover *inside* it that is placed, so the same component is right in the app shell's own
     * wrapper and in a bare pane. It is invisible until the placement effect has run, because a
     * popover that paints one frame at the wrong end of the pane is worse than one that waits.
     */
    return (
      <div
        ref={panel}
        data-slot="photo-picker"
        data-platform="macos"
        data-state={open ? "open" : "closed"}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
        className={cn("absolute inset-0 outline-none", vars, macVars, className)}
        style={{ pointerEvents: "none", fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif", ...style }}
        {...props}
      >
        <style>{macHostInteropCss}</style>
        <div
          ref={macBox}
          data-slot="mac-popover"
          role="group"
          aria-label={label}
          className="absolute bg-[var(--mac-pp-fill)] shadow-[var(--mac-pp-edge)]"
          style={{
            left: placement?.left ?? 0,
            top: placement?.top ?? 0,
            width: mm.width,
            height: macHeight,
            borderRadius: mm.radius,
            visibility: placement ? undefined : "hidden",
            pointerEvents: "auto",
            backdropFilter: "blur(30px)",
            WebkitBackdropFilter: "blur(30px)",
            // It grows out of the arrow's tip, which is the "+" button: the same corner rule the
            // plus menu follows, moved to the corner this popover is actually anchored by.
            transformOrigin: `${placement?.arrowX ?? mm.width / 2}px ${macHeight + mm.arrow.height}px`,
          }}
        >
          {/*
            The arrow. Invented outright — see `macPhotoPickerMetrics.arrow` — and drawn as the
            popover's own material clipped to a triangle, with the box's hairline carried down its
            two slanted edges. It overlaps the box by half a point so the fills meet without a seam.
          */}
          <span
            aria-hidden="true"
            data-slot="mac-popover-arrow"
            className="pointer-events-none absolute"
            style={{ left: (placement?.arrowX ?? mm.width / 2) - mm.arrow.width / 2, top: macHeight - 0.5, width: mm.arrow.width, height: mm.arrow.height + 0.5 }}
          >
            <span
              className="absolute inset-0 bg-[var(--mac-pp-fill)]"
              style={{ clipPath: "polygon(0 0, 100% 0, 50% 100%)", backdropFilter: "blur(30px)", WebkitBackdropFilter: "blur(30px)" }}
            />
            <svg aria-hidden="true" className="absolute inset-0 block size-full" viewBox={`0 0 ${mm.arrow.width} ${mm.arrow.height + 0.5}`} fill="none" preserveAspectRatio="none">
              <path d={`M0 0.25 L${mm.arrow.width / 2} ${mm.arrow.height + 0.25} L${mm.arrow.width} 0.25`} stroke="var(--mac-pp-outline)" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
            </svg>
          </span>
          {gridScroller}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={panel}
      data-slot="photo-picker"
      data-state={open ? "open" : "closed"}
      data-detent={detent}
      data-dragging={drag ? "true" : "false"}
      // A focus holder, not a control: `-1` keeps it out of the tab order while it can still hold
      // the focus, and `outline-none` keeps it from painting on the frame `:focus-visible` matches.
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      className={cn("ios-photo-picker absolute outline-none", vars, className)}
      style={{
        // Left plus width, never left plus right: two fractional insets resolve independently and the
        // panel ends up a device pixel wider than the capture's 1174.
        left: inset,
        bottom: inset,
        width,
        height: panelHeight,
        background: "var(--ios-pp-panel)",
        fontFamily: fontStack,
        // Unmeasured, like the detent itself; suppressed under a finger so the drag tracks exactly.
        transition: drag ? undefined : `height ${detent === "expanded" ? m.timing.detent : m.timing.exit}ms ${m.easing.enter}`,
        /*
         * The rounding is a clip path, not `border-radius`, and that is a fidelity decision rather
         * than a style one. Chrome paints a `border-radius` box snapped out to whole device pixels: at
         * this panel's measured left of 15.984 device px it fills pixel 15 completely, and the same
         * snapping on each tile eats the gaps, turning the measured 4.86 device px into 3. `clip-path`
         * renders sub-pixel, so both land where the capture puts them (pixel 15 comes out 241 against
         * the backdrop's 244, which is the 1.6% of a pixel the panel really covers).
         *
         * The cost is the corner profile. `clip-path: inset(... round)` can only draw a circle, and the
         * capture's corner is one of Apple's continuous ones: fitting the traced arc gives the
         * superellipse 0.84 device px rms on the top corner and 0.90 on the bottom, against the best
         * circle's 0.94 and 1.27. Trading 0.1 to 0.37 px of rms on two arcs for a device pixel on every
         * straight edge and every gap is the right way round, so the circle wins here.
         */
        clipPath: `inset(0 round ${m.roundTopRadius}px ${m.roundTopRadius}px ${m.roundBottomRadius}px ${m.roundBottomRadius}px)`,
        ...style,
      }}
      {...props}
    >
      {expanded ? (
        <div data-slot="photo-picker-header" style={{ height: headerHeight, paddingTop: m.header.titleTop, paddingLeft: m.header.inset, paddingRight: m.header.inset }}>
          <div className="flex items-center justify-between" style={{ height: m.header.rowHeight }}>
            <span style={{ fontSize: m.header.titleSize, fontWeight: 600, color: "var(--ios-pp-label)" }}>{title}</span>
            <button
              type="button"
              data-slot="photo-picker-albums"
              onClick={onAlbums}
              className="rounded-[8px] px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]"
              style={{ fontSize: m.header.actionSize, color: "var(--ios-pp-badge)", background: "none", border: 0 }}
            >
              {albumsLabel}
            </button>
          </div>
          {search ? <div style={{ paddingTop: m.header.searchTop, height: m.header.rowHeight + m.header.searchTop }}>{field}</div> : null}
        </div>
      ) : null}

      {gridScroller}

      {grabber ? (
        <div
          data-slot="photo-picker-handle"
          aria-hidden="true"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          className="absolute left-0 top-0 touch-none"
          style={{ width, height: m.detents.handle }}
        >
          <span
            data-slot="photo-picker-grabber"
            className="pointer-events-none absolute left-1/2"
            style={{
              top: m.grabber.top,
              width: m.grabber.width,
              height: m.grabber.height,
              marginLeft: -m.grabber.width / 2,
              borderRadius: m.grabber.radius,
              background: "var(--ios-pp-grabber)",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * What a selection turns into once it is in the composer.
 *
 * **Nothing here is measured.** No capture in `references/ios/captures` or
 * `references/macos/captures` shows a photo sitting in the Messages composer, and ChatKit only
 * offers `-[CKUIBehaviorPhone entryViewAttachmentHorizontalOffset]` (-5) and
 * `entryViewAttachmentVerticalOffset` (0), which say where such a thing goes without saying what it
 * is. The chip's size, radius, gap and remove button are invented, and its blue is the kit's
 * measured `#0088ff`. `ios-composer.tsx` takes no children, so this row is positioned by the shell
 * above the composer rather than inside it.
 *
 * @unverified size, radius, gap, removeSize, removeInset
 */
export const photoPickerChipMetrics = { size: 56, radius: 12, gap: 6, removeSize: 20, removeInset: 3, rowInset: 16 } as const;

export type PhotoPickerAttachmentsProps = Omit<ComponentProps<"div">, "children"> & {
  /** The picked photos, in pick order. */
  photos: PhotoPickerPhoto[];
  /** Fires with the id the chip's ✕ was pressed on, so the caller can drop it from the selection. */
  onRemove?: (id: string) => void;
  size?: number;
  label?: string;
};

export function PhotoPickerAttachments({ photos, onRemove, size = photoPickerChipMetrics.size, label = "Attachments", className, style, ...props }: PhotoPickerAttachmentsProps) {
  const c = photoPickerChipMetrics;
  if (photos.length === 0) return null;
  return (
    <div
      data-slot="photo-picker-attachments"
      role="list"
      aria-label={label}
      className={cn("flex items-end", vars, className)}
      style={{ gap: c.gap, fontFamily: fontStack, ...style }}
      {...props}
    >
      {photos.map((photo, index) => {
        const id = idOf(photo, index);
        const name = photo.alt ?? `Photo ${index + 1}`;
        return (
          <div key={id} role="listitem" data-slot="photo-picker-chip" className="relative" style={{ width: size, height: size }}>
            <span
              aria-hidden="true"
              className="absolute inset-0"
              style={{ background: photo.fill ?? "var(--ios-pp-tile)", clipPath: `inset(0 round ${c.radius}px)` }}
            />
            {photo.src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo.src} alt="" aria-hidden="true" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 size-full object-cover" style={{ clipPath: `inset(0 round ${c.radius}px)` }} />
            ) : null}
            {onRemove ? (
              <button
                type="button"
                data-slot="photo-picker-chip-remove"
                aria-label={`Remove ${name}`}
                onClick={() => onRemove(id)}
                className="absolute flex items-center justify-center rounded-full p-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0088ff]"
                style={{
                  top: c.removeInset,
                  right: c.removeInset,
                  width: c.removeSize,
                  height: c.removeSize,
                  border: 0,
                  background: "rgba(0,0,0,0.5)",
                  color: "var(--ios-pp-glyph)",
                }}
              >
                <svg aria-hidden="true" width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
                  <path d="M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5" />
                </svg>
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
