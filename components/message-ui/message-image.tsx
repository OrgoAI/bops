"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { usePlatform, type Platform } from "@/components/message-ui/platform";
import { bubbleMetrics, fontStack, type Direction } from "@/components/message-ui/tokens";
import { bodyClipPath, tailBox, tailPath, tailSeamOverlap } from "@/components/message-ui/bubble-shape";

/**
 * Photos and videos sent in a conversation. A photo takes the bubble's shape, tail included, so the
 * same traced outline in `bubble-shape.ts` clips the image instead of filling it.
 *
 * NOT MEASURED against a native photo message: the corner radius and tail come from the measured text
 * bubble. The multi-photo layout is the stack ChatKit actually draws, with the framework's own
 * constants — see `photoStackLayout` for which parts of composing them are a reading.
 *
 * ## What a photo message offers, and what is here (audit, 2026-09-09)
 *
 * | part                    | native evidence                                              | here |
 * |-------------------------|--------------------------------------------------------------|------|
 * | single photo's box      | `thumbnailFillSizeForWidth:imageSize:`, swept                 | yes, MEASURED, within 0.38 pt (ChatKit rounds to the device grid; see `photoBox`) |
 * | multi-photo box         | `-[CKUIBehavior previewBalloonSizeThatFits:]`, read at both idioms | yes, MEASURED: see `photoStackBox`. 375 x 353 on Mac, 350.625 x 332.625 on iPhone |
 * | balloon max width       | `balloonMaxWidthForTranscriptWidth:…`, `balloonMaxWidthPercent` 0.85 iPhone / 0.65 Mac | rule recorded in `balloonMaxWidth`; the group uses the measured constant and now cannot exceed its container |
 * | loading                 | `DOWNLOADING` = "Downloading…"                                 | partial: tiles hold on the placeholder and the group is `aria-busy`, but there is NO progress indicator and no "Downloading…" copy. `photoSheetProgressIndicatorSize` {20, 20} is the picker sheet, not the balloon, so the balloon's spinner is UNMEASURED |
 * | failed / not downloaded | `TAP_TO_DOWNLOAD`, `CLICK_TO_DOWNLOAD`, `downloadButtonFont` 17 | yes: copy and type size MEASURED; `pending` offers it without a failed fetch. A *send* failure is a different thing and belongs to the shell (`FailedSendBadge`, ChatKit's `_clearFailureBadge`), not to this component |
 * | video duration badge    | none on a transcript balloon                                   | NO — and correctly so. `CKMovieBalloonView` is `CKImageBalloonView` plus an `AVPlayerLayer` and has no duration label at all (`playsInlineVideo` = 1). The only `_durationLabel` in ChatKit is on `CKPhotoSearchResultCell`, the search-results cell. Adding one to a bubble would be inventing a control native does not draw |
 * | Live Photo badge        | `CKImageBalloonView._irisBadgeView`, `livePhotoBadgeImage`      | yes, added here: symbol identity and ring geometry MEASURED off the framework's own `UIImage` (see `livePhotoBadge`); its position in the tile is judgement |
 * | spatial badge           | `CKImageBalloonView._monoskiBadgeView`                          | NO. Not built; no size read yet |
 * | overflow count past 4   | `PXMessagesStackAdditionalItemsView`, `_localizedTitleForAdditionalItemsCount:` | yes: the last card slot stops being a photo and becomes the count card, a blur under SF Bold 17 in systemBlue reading "+7 Items". The copy and the type are MEASURED; the blur has nothing behind it to measure against |
 * | tap target → viewer     | —                                                              | yes: every tile is a `<button>` and `onOpenImage` hands the viewer the tile's own `DOMRect` |
 *
 ## The grid was the wrong layout, and it is gone
 *
 * There is no photo-*grid* balloon in ChatKit. Two or more attachments on one message are a **stack**:
 * `CKGenericPhotoStackBalloonView` over a `PXMessagesStackView`, which pages left and right
 * (`pageLeftAnimated:` / `pageRightAnimated:`) and counts the rest on a
 * `PXMessagesStackAdditionalItemsView`. The `CKPhotoGrid*` names in the framework belong to the
 * full-screen grid the stack opens into, not to the transcript. The accessibility format this file
 * quotes, `messages.attachment.stack.view.format`, is that stack view's.
 *
 * The note that used to sit here said the stack could not be built because its frames live in
 * PhotoFoundation's solver and no capture exists to fit them against. Half of that was wrong: the
 * constants are readable — see `photoStackLayout` — and they are what this draws now. The half that
 * still stands is that no capture of a multi-photo message exists, so *composing* those constants is
 * a reading and is marked as one.
 *
 * The stack's **outer box**, though, is no longer a guess — see `photoStackBox`. `PFMessagesStackLayoutFrameSolver`
 * only ever hands out *normalized* geometry (`normalizedVerticalInsets`, `normalizedVerticalOffset`,
 * `normalizedSizeTransform`, `normalizedHorizontalOffsets`), and `-[PXMessagesStackItemsLayoutHelper
 * maxItemSizeForReferenceSize:]` is handed the reference size from outside, so the absolute box has to
 * come from the chat item — and it does.
 *
 * The single photo's box, on the other hand, is now read out of ChatKit rather than guessed: see
 * `photoBox` below. So are the accessible names: ChatKit's own accessibility bundle
 * (`/System/iOSSupport/System/Library/AccessibilityBundles/ChatKitFramework.axbundle`,
 * `Accessibility.loctable`) calls one attachment `photo.attachment` = "Photo", counts them with
 * `attachment.count` = "%d attachments" and positions each one with
 * `messages.attachment.stack.view.format` = "attachment %1$d of %2$d".
 *
 * A photo sent together with text is NOT one balloon with a caption under the photo. ChatKit splits a
 * message into parts (`-[CKMessagePartChatItem messagePartRange]`, `CKTextMessagePartChatItem` vs
 * `CKAttachmentMessagePartChatItem`), and each part is its own balloon chat item, so native draws the
 * photo balloon and the text balloon as two bubbles of one cluster. "Caption" exists nowhere in the
 * image balloon; in ChatKit it belongs to Business Chat rich cards
 * (`-[CKBalloonView didTapTruncatedCaptionForRichCard:]`). The message list therefore renders the two,
 * passing `tail` to whichever comes last; this component stays a photo group.
 */
export type MessageImage = {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  /**
   * The transfer has not been fetched. The tile offers `TAP_TO_DOWNLOAD` / `CLICK_TO_DOWNLOAD`
   * straight away instead of only after an <img> errors, which is what native does with an
   * attachment it is holding but has not downloaded.
   */
  pending?: boolean;
  /** A Live Photo. Draws ChatKit's `livePhotoBadgeImage` over the tile; see `livePhotoBadge`. */
  livePhoto?: boolean;
};

export type MessageImagesProps = Omit<ComponentProps<"div">, "children"> & {
  images: MessageImage[];
  direction?: Direction;
  tail?: boolean;
  /**
   * The balloon width the transcript grants this message — native's `balloonMaxWidth`, which is what
   * `-[CKChatItem size]` passes down. Defaults to the platform's measured maximum bubble width. A single
   * photo fills it (`photoBox`); a group derives its own box from it by ChatKit's rule (`photoStackBox`)
   * and, on iOS, comes out *wider* than this value, exactly as native does.
   */
  maxWidth?: number;
  /** Tallest the group may grow, in px. Defaults to the native cap (see `photoBox`). */
  maxHeight?: number;
  /** The transfer has not arrived yet: hold every tile on the placeholder. */
  loading?: boolean;
  /**
   * Open the full-screen viewer at `index`. The second argument is the tile's own box in viewport
   * coordinates, so the viewer can zoom out of the tile the way native does instead of fading in.
   */
  onOpenImage?: (index: number, rect: DOMRect) => void;
  /** @deprecated Use `onOpenImage`, which also hands over the tile's box. */
  onOpen?: (index: number) => void;
  /** Tapback balloons; positioned on the group's top corner away from the screen edge. */
  reactions?: ReactNode;
  platform?: Platform;
};

/**
 * Native draws five cards. `_stackedItemsCount` is 4 and reads like the answer, but it is the number
 * of cards BEHIND the front one: `-[PXGLayout styleForSpriteAtIndex:]` answers alpha 1.0 for sprites
 * 0 through 4 and alpha 0.0 for sprite 5, at every item count and both idioms.
 */
const MAX_TILES = 5;

/**
 * The card the tail continues. The front card is the only one whose bottom edge reaches the
 * balloon's - the ones behind it are smaller, pushed sideways and turned, and none touches the
 * corner the tail grows out of - and a single photo is its own front card, so it is 0 either way.
 * Module scope so it is a constant rather than a dependency of the measuring callback.
 */
const TAIL_TILE = 0;

/** The "+N Items" pill: 17 pt Bold in a capsule, inset from the front card's corner. Placement only. */
const countCardHeight = 30;
const countCardInset = 12;

/**
 * How big one photo's balloon is, read out of ChatKit instead of a screenshot.
 * `-[CKUIBehaviorPhone thumbnailFillSizeForWidth:imageSize:]`, swept over widths 100…900 against
 * extreme image sizes, fills the balloon width and then clamps the shape: anything wider than 16:9
 * comes back at `width x 0.5625` and anything taller than 3:4 at `width x 1.3333`, in both cases
 * cropped, since the answer is a *fill* size (its sibling `unconstrainedAspectFillSizeForWidth:`
 * returns the unclamped fit).
 *
 * `-[CKUIBehaviorMac thumbnailFillSizeForWidth:imageSize:]` overrides it and applies no shape clamp at
 * all: it returns the true aspect fit (w 382.5, a 4:1 photo → 382.5 x 96, where the phone stops at
 * 215.5). Re-swept 2026-09-09; the Mac override only answers for real once it is asked in its own
 * process, because `+sharedBehaviors` caches the first singleton it builds and a second call in the
 * same process hands back the phone's.
 *
 * `maxHeight` is a PORTRAIT-ONLY ceiling on both, which the sweep is unambiguous about: 3:4, 9:16 and
 * 1:4 all stop at 500 and shrink their width to hold the ratio (w 382.5, 9:16 → 281.5 x 500), while
 * 1:1 at w 900 comes back 900 x 900 and 16:9 at w 900 comes back 900 x 506.5. Nothing in this kit
 * ever hands a photo 900 pt, so the two rules agree everywhere it is used; `portraitOnly` records
 * which one is native rather than leaving the wrong one to bind if a caller ever passes a wide box.
 *
 * Native rounds each result to the device pixel grid (it answers 158.0 where 280.5 x 0.5625 is
 * 157.78); the fractions are kept here, which is why the lab's own probe reports our box within 0.38 pt
 * of ChatKit's rather than equal to it.
 *
 * This is the **single**-photo rule only. Two or more attachments are a different chat item with a
 * different, fixed box; see `photoStackBox`.
 */
export const photoBox: Record<Platform, { minRatio: number; maxRatio: number; maxHeight: number; portraitOnly: true; maxWidth: number | null }> = {
  ios: { minRatio: 0.5625, maxRatio: 4 / 3, maxHeight: 500, portraitOnly: true, maxWidth: 252.667 },
  macos: { minRatio: 0, maxRatio: Number.POSITIVE_INFINITY, maxHeight: 500, portraitOnly: true, maxWidth: null },
};

/**
 * **A photo balloon is narrower than a text bubble, and this is the width it actually gets.**
 *
 * `bubbleMetrics.ios.maxWidth` is 280.5, and that is right for text — it is `(402 - 72) x 0.85` from
 * `balloonMaxWidthForTranscriptWidth:` to the last digit. A photo does not get it. Captured off a real
 * iPhone 17 Pro running iOS 26, a sent photo balloon measures **252.667 pt** across (758 device pixels
 * at 3x) with its right edge on 386.000 — the same trailing margin every text bubble uses — and that
 * width does not move between a 4:3, a 1:1 and a 3:4 photo.
 *
 * Two independent readings agree, which is why this is a constant and not a guess:
 *
 * | photo | device drew | `thumbnailFillSizeForWidth:252.667` | with 280.5 |
 * | --- | --- | --- | --- |
 * | 4:3 landscape | 189.667 | 189.5 | 210.5 |
 * | 1:1 square | 252.667 | 253.0 | 280.5 |
 * | 3:4 portrait | **337.0** | **337.0** | 374.0 |
 *
 * The portrait row is the one that settles it: 337.0 exactly, and the 280.5 column cannot produce it.
 *
 * **Where 252.667 comes from is not established.** It is not `balloonMaxWidthForTranscriptWidth:` at
 * any sensible inset — swept at 402 over insets 0…90 in eighths and every flag combination, the only
 * inset that lands on it is 52.375, which is not a number anything else in ChatKit uses. So this is a
 * measured constant for a 402 pt screen, exactly as `bubbleMetrics.ios.maxWidth` is, and a wider
 * transcript may well scale it. `macos` is `null` because no macOS capture holds a photo balloon; the
 * Mac keeps the bubble's own width until one does, rather than inheriting a number measured on a phone.
 *
 * **Re-measured on a second capture**, three 3:4 photos sent as a run, reading the lowest balloon
 * (the only one no chrome overlaps): 252.667 pt wide, right edge 386.000, and 343.667 pt tall — of
 * which 6.8 is the tail's hang, leaving a 336.9 pt body against the 337.0 the table above predicts.
 * Two captures, taken on different days from different photos, agree to a third of a point.
 *
 * The corner was measured at the same time and is **not** a separate constant. Fitting a circle to
 * the balloon's top-left arc gives 19.5–19.8 pt depending on where the edge threshold is put
 * (rmse 0.46–0.73 device px, so the arc really is circular), against `bubbleMetrics.ios.radius`
 * 20.0107 measured for a text bubble. The gap is smaller than the ±0.3 pt the threshold alone moves
 * it, so a photo balloon uses the bubble's corner and nothing here overrides it — a second constant
 * would be recording the measurement's noise, not the device's behaviour.
 */

/**
 * One photo's balloon, given the photo's aspect and the width the transcript allows.
 * `-[CKUIBehavior thumbnailFillSizeForWidth:imageSize:]` in one function: clamp the shape, cap the
 * width at the photo balloon's own, and hold the ratio if a portrait would out-grow `maxHeight`.
 */
export function photoBalloonSize(aspect: number, platform: Platform, available: number, maxHeight?: number) {
  const box = photoBox[platform];
  const ceiling = maxHeight ?? box.maxHeight;
  const ratio = Math.min(Math.max(1 / aspect, box.minRatio), box.maxRatio);
  // The ceiling is portrait-only on both idioms, which is what the sweep says; a landscape or square
  // photo keeps its true fit however wide the box is.
  const capped = box.portraitOnly ? ratio > 1 : true;
  const widest = box.maxWidth === null ? available : Math.min(available, box.maxWidth);
  const width = capped ? Math.min(widest, ceiling / ratio) : widest;
  return { width, height: width * ratio };
}

/**
 * How big a balloon holding **more than one** photo is. This is not `photoBox` and it is not the text
 * balloon's width, which is what this component used to hand it: two or more attachments on a message
 * are a `CKAggregateAttachmentMessagePartChatItem`, and its entire `-loadSizeThatFits:textAlignmentInsets:`
 * is one unconditional call —
 *
 *     -[CKUIBehavior sharedBehaviors] previewBalloonSizeThatFits:size
 *
 * — with no branch on the photos at all. `-[CKChatItem size]` calls that with `(self.maxWidth,
 * CGFLOAT_MAX)`, and `maxWidth` is `balloonMaxWidth` unchanged, because
 * `+[CKBalloonChatItem resultingMaxWidthWithBalloonMaxWidth:fullMaxWidth:transcriptTraitCollection:
 * transcriptBackgroundLuminance:]` is a bare `ret`. So the whole rule is `previewBalloonSizeThatFits:`,
 * whose body is:
 *
 *     w' = min(w, previewMaxWidth) * 1.25
 *     h' = w' - 2 * (stackBalloonVerticalInset - smallTranscriptSpace)
 *
 * MEASURED twice: read out of the disassembly and then confirmed by calling the selector at both idioms
 * over a dozen widths (100…900), which reproduces the formula exactly. The three inputs, read at their
 * own idiom in their own process:
 *
 * | idiom  | previewMaxWidth | stackBalloonVerticalInset | smallTranscriptSpace | at its `maxWidth` |
 * |--------|-----------------|---------------------------|----------------------|-------------------|
 * | iPhone | 761             | 15                        | 6                    | 280.5 → 350.625 x 332.625 |
 * | Mac    | **300**         | 15                        | 4                    | 382.5 → **375 x 353**     |
 *
 * `previewMaxWidth` is the whole story on the Mac: at 300 it saturates for any balloon max width at or
 * above 300, so a macOS photo group is **375 x 353 whatever the window does**, and 382.5 x 382.5 — the
 * text balloon's width squared by a 2x2 grid — was never a number ChatKit produces. It is also not
 * square: the height is 22 pt (Mac) / 18 pt (iPhone) short of the width.
 *
 * Nothing else bounds it, and several things that look like they might do not:
 *   - `calculatesWidthForAttachmentBalloons` is **0 on both idioms**, so it is not a Mac difference.
 *   - `attachmentBalloonSize` is `{187, 124.5}` on **both** idioms; it belongs to the fixed rich-icon
 *     file balloon (`attachmentBalloonRichIconInsets`), not to a photo.
 *   - `-[CKUIBehaviorMac thumbnailFillSizeForWidth:imageSize:]`, re-swept today at idiom 5 in its own
 *     process, still fills the width it is given with only the portrait 500 ceiling (see `photoBox`) —
 *     it never narrows anything, and it is the *single*-photo path, not this one.
 *   - `balloonMaxWidthPercent` 0.65 makes the Mac balloon proportionally narrower than the iPhone's, but
 *     it is the same balloon width a text bubble gets; there is no photo-specific percent.
 *   - `macTotalMarginWidth` = 40 is Mac-only and matches the measured `edgeInset` 20 per side, but
 *     `(630 - 40) x 0.65` = 383.5 against the capture's 382.5, so it still does not close that 1.0 pt.
 *   - There is no photo-grid or collage constant on either idiom.
 */
export const photoStackBox: Record<Platform, { previewMaxWidth: number; widthScale: number; heightInset: number }> = {
  ios: { previewMaxWidth: 761, widthScale: 1.25, heightInset: 2 * (15 - 6) },
  macos: { previewMaxWidth: 300, widthScale: 1.25, heightInset: 2 * (15 - 4) },
};

/**
 * **The stack, with its numbers — and now with its frames.**
 *
 * ## Read this first: iOS 26's own send path never makes one of these
 *
 * Driving the real Messages app on an iPhone 17 Pro through XCUITest — attach N photos in the picker,
 * tap Send **once** — produces **N separate messages**, each a single-photo balloon, at N = 1, 3 and
 * 10. The ten-photo send put exactly ten cells in the transcript, each labelled "Your iMessage,
 * Includes picture", in the picked order. There is no fan, nothing behind the front card, and no
 * "+N Items" pill anywhere in the pixels or in any accessibility dump. `photo-run` in
 * `harness/scenarios.ts` is that, and it is what a user actually sees.
 *
 * So the geometry below is real — it came out of `PXMessagesStackView`'s own layout, and every frame
 * in the table is the framework's answer — but **the balloon it describes has not been observed on a
 * device**. `CKGenericPhotoStackBalloonView` exists and is fully built; what makes it appear is not
 * established. The obvious candidate, a *received* message carrying several attachments, could not be
 * produced: the simulator has no iMessage service and no `sms.db` to inject one into. Until something
 * does produce one, treat this as the drawing of a balloon the kit can render rather than as a
 * description of what sending photos looks like.
 *
 * The note this replaces said the solver could not be run, so the arithmetic below was a *reading* of
 * the normalized ivars. It can be run, and the reading was wrong in most of its parts. What works:
 * `-[CKGenericPhotoStackBalloonView _createStackView]` builds a plain `PXMessagesStackView` (not the
 * `CKMessagesCarouselView` that `+genericStackView` hands back); install it in a real balloon,
 * `layoutIfNeeded`, then drive the layout with `-[PXGItemsLayout setNumberOfItems:]` + `-update` and
 * no data source at all. `-[PXGLayout geometryForSpriteAtIndex:]` then returns a real frame and
 * `-styleForSpriteAtIndex:` a float vector whose `f[0]` is alpha, `f[14]` rotation in radians and
 * `f[15]` scale. (Two traps: `geometryForSpriteAtIndex:` returns a struct much larger than its
 * truncated encoding claims, so a snug sret buffer smashes the stack; and `-sizeForItem:` segfaults
 * without a data source.)
 *
 * | ivar | value |
 * | --- | --- |
 * | `_stackedItemsCount` | **4** — cards *behind* the front one, so **five** are drawn |
 * | `_normalizedStackSizeTransform` | **0.9** |
 * | `_normalizedStackHorizontalOffsets` | **[0.0666667, 0.0483333, 0.0333333, 0.03]** |
 * | `_rotationAngle` | **0.03490658 rad = 2.0°**, accumulating, **always toward +x** |
 * | `_minItemAspectRatio` / `_maxItemAspectRatio` | **0.75 / 1.3333** |
 * | `_itemCornerRadius` | **20** |
 * | `_verticalContentInsets` | **15**, and it insets the **square**, not the balloon |
 *
 * **The layout box, and why it is *not* a square.** `-[CKGenericPhotoStackBalloonView layoutSubviews]`
 * disassembles to one rule, with no `min()`, no square and no centring in it:
 *
 *     frame = (bounds.x, bounds.y - d, bounds.w, bounds.h + 2d),  d = stackBalloonVerticalInset - smallTranscriptSpace
 *
 * pixel-snapped afterwards (the y floored, then all four rounded). `d` is **9** on iPhone and **11**
 * on Mac, which is exactly half of `photoStackBox.heightInset`. Swept: a 400×200 balloon gives
 * (0, −9, 400, 218) and a 200×400 balloon gives (0, −9, 200, 418) — the box simply follows the
 * balloon's own width and outsets its height.
 *
 * It comes out *square* at the balloon sizes this kit actually draws only because
 * `previewBalloonSizeThatFits:` sets `h = w - 2d`, so `w` and `h + 2d` are the same number there —
 * and the earlier reading of this ("a square of side = the balloon's width, vertically centred")
 * could not tell the two apart from that one data point. It matters the moment the balloon is
 * clamped narrower than its natural width, which is exactly when this file used to fall apart.
 *
 * The cards then live in an `S × S` square anchored at that box's **top-left**, `S = min(w, h)` of
 * the box — not centred in it. At the natural size the two are the same; at 200×400 the cards sit in
 * the top 200×200 rather than at the box's middle.
 *
 * **The card.** `aspect-fit(clamp(photoAspect, 0.75, 1.3333))` into `(S - 30)²`. With no photo aspect
 * known it is 0.75 — a **portrait** card, not the near-square this file used to draw. Swept: at
 * `minItemAspectRatio` 0.4 and 0.6 the sprite box stayed at aspect 0.75; at 0.8 it became 0.8. The
 * container's own aspect never enters into it.
 *
 * **The arch.** Every card shares the square's centre y, and card *k* has centre
 * `x = S/2 + S · Σ offsets[0..k)`. The offsets are successive deltas, and their denominator is the
 * square's side — `dx₁/S` came back 0.066666667 in all 40 rows of the sweep while `dx₁/cardWidth`
 * wandered over 0.0733…0.1170. Scale is `0.9ᵏ` and rotation `+2k°`; **neither is mirrored for an
 * outgoing message**, which is the part this file used to get backwards. Its `lean = -1` reproduced
 * the framework's *leading* keyframes (175.31, 151.94, 134.99, 123.30) — the paged-past half of the
 * arch — where the resting stack is the trailing half (175.25, 198.62, 215.56, 227.24, 237.76).
 *
 * The measured balloon-space frames, painted (i.e. after the scale), which is what the table below
 * has to reproduce:
 *
 * | k | iPhone, in 350.625 × 332.625 | Mac, in 375 × 353 |
 * | --- | --- | --- |
 * | 0 | (55.0625, 6, 240.375, 320.5) 0° | (58.125, 4, 258.75, 345) 0° |
 * | 1 | (90.4479, 22.025, 216.3375, 288.45) +2° | (96.0625, 21.25, 232.875, 310.5) +2° |
 * | 2 | (118.2056, 36.4475, 194.7038, 259.605) +4° | (125.8313, 36.775, 209.5875, 279.45) +4° |
 * | 3 | (139.6241, 49.4278, 175.2334, 233.6445) +6° | (148.8106, 50.7475, 188.6287, 251.505) +6° |
 * | 4 | (158.9008, 61.11, 157.71, 210.28) +8° | (169.4921, 63.3228, 169.7659, 226.3545) +8° |
 *
 * **Contested, and worth settling from a real balloon.** The balloon's own stack view reports
 * `keepItemAspectRatioConstant = NO`, which is why each card below is fitted to its own photo. A
 * separate probe *inside the simulator* — a different view, configured with that flag YES — found the
 * card size identical for 0.75, 1.0 and 1.5 images, i.e. a hard-wired 3:4. Both readings are of real
 * objects; they are of different objects. The card's painted corner follows the same reasoning: the
 * sprite style reports radius 20 on every sprite and the scale is applied on top, so the painted
 * corner is `20 · 0.9ᵏ`, which is what a scaled element gives for free.
 *
 * **Still not measured**, and marked as such where it is used: the colour of the per-depth overlay
 * (`overlayAlpha` is 0.1·k in the geometry, but the sprite style carries no colour, so the item
 * effect view must paint it); and where the "+N Items" accessory card sits — `setAdditionalItemsCount:`
 * raises on a layout with no data source, and all that is established is that it is an *accessory*
 * item (`numberOfAccessoryItems`), structurally separate from the five photo slots, so it does not
 * consume one. `PXMessagesStackAdditionalItemsView` is a `UIBlurEffect` behind a centred SF Bold 17
 * label in systemBlue, and `_localizedTitleForAdditionalItemsCount:` is where "+2 Items" comes from.
 *
 * What all this replaces was first a 2×2 grid — which Messages does not draw at all, there is no
 * photo-grid balloon on either idiom — and then a mirrored four-card fan of near-square cards.
 */
export const photoStackLayout = {
  /** Cards drawn at once, however many photos there are: `_stackedItemsCount` 4, plus the front one. */
  visible: 5,
  /** Each card behind is this fraction of the one in front. */
  sizeTransform: 0.9,
  /** Successive horizontal deltas, as fractions of the **square's side** — never of the card. */
  offsets: [0.0666667, 0.0483333, 0.0333333, 0.03],
  /** Degrees each card behind is turned, accumulating with depth, always toward +x. */
  rotation: 2,
  /** The card's corner, which is the balloon's own. */
  radius: 20,
  minAspect: 0.75,
  maxAspect: 4 / 3,
  /** `-[PXMessagesStackView verticalContentInsets]`, = `-[CKUIBehavior stackBalloonVerticalInset]`. */
  verticalInset: 15,
  /** `overlayAlpha` from the keyframe table: 0, 0.1, 0.2, 0.3, 0.4 by depth. */
  overlayStep: 0.1,
  /** The count card's label, `_localizedTitleForAdditionalItemsCount:`. */
  more: (count: number) => `+${count} Item${count === 1 ? "" : "s"}`,
} as const;

/**
 * Where card `index` sits inside a stack whose square is `side` points across and whose balloon is
 * `height` tall, given the aspect of the photo on it. This is the measured model and nothing else:
 * a square inset by 30, an aspect-fit card, and an arch of centres at fractions of the side. It is a
 * pure function of the *rendered* size so a clamped balloon stays a balloon — the cards used to keep
 * absolute pixel geometry while only the box clamped, and at a 140 pt container the front card hung
 * 178 pt out of its row with the tail 210 pt adrift.
 */
export function photoStackCard(index: number, balloonWidth: number, balloonHeight: number, platform: Platform, photoAspect?: number | null) {
  const L = photoStackLayout;
  // `d`, the vertical outset, is `stackBalloonVerticalInset - smallTranscriptSpace` — and that is
  // precisely what `photoStackBox.heightInset` already is, twice over, so the two cannot drift apart.
  const outset = photoStackBox[platform].heightInset / 2;
  // Snapped to the nearest half point, the way `layoutSubviews` snaps its frame, and that snap is the
  // whole of the difference between this model and the framework. On Mac it changes nothing (375 and
  // -11 are already there); on iPhone the balloon is 350.625 across and the box is 350.5, and *with*
  // the snap all five iPhone frames come out exact too, where without it they sit 0.03-0.09 pt off.
  // Half a point is not visible, but a model that reproduces the framework to four decimals is
  // checkable and one that nearly does is not.
  const snap = (value: number) => Math.round(value * 2) / 2;
  const boxWidth = snap(balloonWidth);
  const boxHeight = snap(balloonHeight + 2 * outset);
  const side = Math.min(boxWidth, boxHeight);
  // The card square hangs off the box's top-left corner, and the box's own top is `-d` in balloon
  // space. At the natural balloon size this lands on the balloon's centre line; away from it, it does
  // not, and that is the framework's behaviour rather than a simplification of it.
  const centreY = -outset + side / 2;
  const inner = Math.max(0, side - 2 * L.verticalInset);
  const aspect = Math.min(Math.max(photoAspect ?? L.minAspect, L.minAspect), L.maxAspect);
  // Aspect-fit into the square: a portrait card is as tall as the square allows, a landscape one as wide.
  const cardHeight = aspect <= 1 ? inner : inner / aspect;
  const cardWidth = cardHeight * aspect;
  let shift = 0;
  for (let step = 0; step < index; step++) shift += (L.offsets[step] ?? L.offsets[L.offsets.length - 1]!) * side;
  const centreX = side / 2 + shift;
  return {
    width: cardWidth,
    height: cardHeight,
    // Laid out unscaled and centred on the arch, then scaled about its own centre — which lands on
    // the measured painted frame exactly, and keeps the element's box meaningful for hit-testing.
    left: centreX - cardWidth / 2,
    top: centreY - cardHeight / 2,
    scale: L.sizeTransform ** index,
    rotate: index * L.rotation,
    /** The per-depth overlay's strength. Its colour is NOT measured; see the note above. */
    scrim: L.overlayStep * index,
  };
}

/** `-[CKUIBehavior previewBalloonSizeThatFits:]` for a balloon the transcript allows `balloonWidth`. */
export function photoStackSize(balloonWidth: number, platform: Platform): { width: number; height: number } {
  const box = photoStackBox[platform];
  const width = Math.min(balloonWidth, box.previewMaxWidth) * box.widthScale;
  return { width, height: width - box.heightInset };
}

/**
 * The width a transcript of `transcriptWidth` gives any balloon, photo balloons included:
 * `-[CKUIBehavior balloonMaxWidthForTranscriptWidth:marginInsets:shouldShowPluginButtons:
 * shouldShowCharacterCount:shouldCoverSendButton:]`, which is exactly
 * `(transcriptWidth - insets.left - insets.right) * balloonMaxWidthPercent`. Verified against the
 * framework at ten widths on each idiom: 630 with 16 pt margins answers 508.3 on iPhone and 388.7 on
 * Mac, which is (630 - 32) x 0.85 and (630 - 32) x 0.65 to the last digit.
 *
 * **`balloonMaxWidthPercent` is 0.65 on Mac against 0.85 on iPhone**, so the Mac balloon is
 * proportionally the *narrower* of the two — the opposite of what this component used to imply by
 * handing macOS a 382.5 pt box and iOS a 280.5 pt one with nothing tying either to its pane.
 *
 * Solving the formula for the two constants this kit already measured off captures:
 *
 * - iPhone, transcript 402: an inset of **36.0** gives (402 - 72) x 0.85 = **280.5000**, which is
 *   `bubbleMetrics.ios.maxWidth` exactly. The framework and the capture agree to the last digit.
 * - Mac, transcript 630: the inset that lands on 382.5 is 20.77, which is not a round number. The
 *   obvious 20 (`bubbleMetrics.macos.edgeInset`) gives 383.5 — a whole point wider than the capture.
 *
 * That 1.0 pt is unresolved and is the reason the measured constant, not this formula, is still the
 * default: swapping it in would move every macOS bubble by a point on the strength of a guessed
 * inset. `shouldCoverSendButton` is the only flag that changes the answer, and it is the composer's
 * concern, not the transcript's. A shell that resizes its transcript should pass `maxWidth` from
 * here — the proportion is right even where the constant's offset is not.
 */
export const balloonMaxWidthPercent: Record<Platform, number> = { ios: 0.85, macos: 0.65 };

export function balloonMaxWidth(transcriptWidth: number, platform: Platform, marginInsets = 16): number {
  return (transcriptWidth - marginInsets * 2) * balloonMaxWidthPercent[platform];
}

/**
 * Where a tapback balloon sits against the group's top corner. Measured on text bubbles and carried
 * over: a photo group takes a tapback like any other balloon, and native anchors it to the balloon's
 * frame, which is what this box is. Numbers from `tapback.tsx`'s `balloonSlot` (the corrected pair),
 * not from `message-bubble.tsx`'s older copy. A photo has no measured slot of its own.
 *
 * **The photo-grid scalars do not apply to anything this file draws, and cannot.** Re-read out of the
 * live framework on 2026-09-10 (Catalyst probe, `references/tapback-details.md`), and they are exactly
 * what this comment already claimed: `-[CKUIBehavior messageAcknowledgmentPhotoGridXOffsetScalar]` = 0
 * and `…PhotoGridYOffsetScalar` = 0.2 on iPhone, 0.35 / 0.35 on Mac (`…PhotoCarouselXOffsetScalar` is
 * 0.2 on both). They are fractions of a *photo grid* view's frame — ChatKit's `CKPhotoGrid*` family,
 * with its own `photoGridTapbackPileDelegate` and `photoGridTapbackSnapshotRect` — and **the device
 * never draws one**: sending N photos makes N messages, each a single-photo balloon (see the note at
 * the top of this file and `references/simulator-cases.md` §3.4). A single-photo balloon is a plain
 * image balloon, so what positions its tapback is the transcript balloon slot every other message
 * kind uses, which is the pair below. The scalars stay recorded and unused.
 *
 * That is the answer to "does a photo offset its badge differently from a text bubble": **on iPhone,
 * for the message shapes the device actually produces, no.** A different offset exists in the
 * framework, but only for the grid, and the grid is unreachable here.
 */
export const reactionSlot: Record<Platform, { marginTop: number; top: number; side: number }> = {
  ios: { marginTop: 28, top: -27.39, side: -13.85 },
  macos: { marginTop: 27.4, top: -22.05, side: -11.79 },
};

/**
 * What native offers on an attachment it has not fetched: ChatKit's `TAP_TO_DOWNLOAD` = "Tap to
 * Download" and `CLICK_TO_DOWNLOAD` = "Click to Download", both read back out of the framework
 * bundle. The tile keeps the same copy when the fetch fails, and activating it asks for the photo
 * again.
 *
 * The type size is MEASURED: `-[CKUIBehavior downloadButtonFont]` is `.SFNS-Regular` at **17 pt on
 * both idioms** — the Mac does not shrink it. This used to render 15 on iOS and 13 on macOS, which
 * was a guess and was wrong on both.
 */
const downloadLabel: Record<Platform, string> = { ios: "Tap to Download", macos: "Click to Download" };

/** `-[CKUIBehavior downloadButtonFont]`, both idioms. */
const downloadFontSize = 17;

/**
 * The Live Photo badge, which native draws over the photo itself: `CKImageBalloonView` keeps an
 * `_irisBadgeView` ("iris" is ChatKit's word for a Live Photo — see `isIrisAsset`) alongside a
 * `_monoskiBadgeView` for spatial media, and the image both are built from is
 * `-[CKUIBehavior livePhotoBadgeImage]`, the system symbol `livephoto` in white.
 *
 * MEASURED, by rasterising that `UIImage` at 8x and reading its ink, the way `audio-recorder.tsx`
 * measures the framework's own symbols:
 *
 * | idiom  | image box     | ink box       | centre disc | solid ring   | dashed ring   |
 * |--------|---------------|---------------|-------------|--------------|---------------|
 * | iPhone | 21.5 x 20.5   | 18.5 x 18.5   | r 3.375     | r 6.0-6.875  | r 8.5-9.25    |
 * | Mac    | 28 x 28 (lg)  | 24 x 24       | r 4.375     | r 7.875-8.75 | r 11.0-12.0   |
 *
 * The dashed ring's duty cycle is the measured inked fraction of its circumference (0.33 on iPhone,
 * 0.21 on Mac); the phase of the dashes, and where the badge sits inside the tile, are NOT MEASURED —
 * no capture of a Live Photo message exists. The inset below is judgement.
 */
const livePhotoBadge: Record<Platform, { box: number; ink: number; disc: number; ring: [number, number]; dashed: [number, number]; duty: number; inset: number }> = {
  ios: { box: 21.5, ink: 18.5, disc: 3.375, ring: [6, 6.875], dashed: [8.5, 9.25], duty: 0.33, inset: 8 },
  macos: { box: 28, ink: 24, disc: 4.375, ring: [7.875, 8.75], dashed: [11, 12], duty: 0.21, inset: 8 },
};

/**
 * `livephoto` drawn to the radii above: a filled centre disc, one solid ring and one dashed ring, in
 * a viewBox the size of the symbol's own ink so the caller only has to place the box.
 */
function LivePhotoGlyph({ platform }: { platform: Platform }) {
  const badge = livePhotoBadge[platform];
  const c = badge.ink / 2;
  const ringWidth = badge.ring[1] - badge.ring[0];
  const dashedWidth = badge.dashed[1] - badge.dashed[0];
  const dashedRadius = (badge.dashed[0] + badge.dashed[1]) / 2;
  // 12 dashes around the ring, each covering `duty` of its share of the circumference.
  const period = (2 * Math.PI * dashedRadius) / 12;
  return (
    <svg width={badge.ink} height={badge.ink} viewBox={`0 0 ${badge.ink} ${badge.ink}`} fill="none" aria-hidden="true"
      style={{ filter: "drop-shadow(0 0 2px rgba(0,0,0,0.35))" }}>
      <circle cx={c} cy={c} r={badge.disc} fill="#fff" />
      <circle cx={c} cy={c} r={(badge.ring[0] + badge.ring[1]) / 2} stroke="#fff" strokeWidth={ringWidth} fill="none" />
      <circle cx={c} cy={c} r={dashedRadius} stroke="#fff" strokeWidth={dashedWidth} fill="none"
        strokeLinecap="round" strokeDasharray={`${(period * badge.duty).toFixed(3)} ${(period * (1 - badge.duty)).toFixed(3)}`} />
    </svg>
  );
}

/**
 * Aspect ratios already learned this session, so a photo that has been seen once never opens at the
 * 4:3 placeholder again. A remount (the viewer closing, a list re-render) would otherwise lay the
 * bubble out at the wrong height and snap when the image decodes. Empty during hydration, because
 * nothing can have loaded by then, so the first client render still matches the server's.
 */
const aspectMemo = new Map<string, number>();

type Phase = "ready" | "failed";

/**
 * Average colour of the corner of `image` that the tail meets, so the tail reads as a continuation of
 * the photo rather than a gray stub. The tile is `object-cover`, so the visible corner is not the
 * source's own corner: map the tail's footprint back through the cover crop before reading it.
 * Returns null when the image has not loaded, is not laid out, or taints the canvas (a cross-origin
 * photo), and the caller keeps its fallback fill.
 */
function sampleCorner(image: HTMLImageElement, side: "left" | "right", boxWidth: number, boxHeight: number): string | null {
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (!image.complete || !naturalWidth || !naturalHeight) return null;
  const rect = image.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const cover = Math.max(rect.width / naturalWidth, rect.height / naturalHeight);
  const visibleWidth = Math.min(naturalWidth, rect.width / cover);
  const visibleHeight = Math.min(naturalHeight, rect.height / cover);
  const patchWidth = Math.max(1, Math.min(visibleWidth, boxWidth / cover));
  const patchHeight = Math.max(1, Math.min(visibleHeight, boxHeight / cover));
  const left = (naturalWidth - visibleWidth) / 2;
  const sx = side === "right" ? left + visibleWidth - patchWidth : left;
  const sy = (naturalHeight - visibleHeight) / 2 + visibleHeight - patchHeight;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, sx, sy, patchWidth, patchHeight, 0, 0, 8, 8);
    const data = context.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
    const pixels = data.length / 4;
    return `rgb(${Math.round(r / pixels)}, ${Math.round(g / pixels)}, ${Math.round(b / pixels)})`;
  } catch {
    return null; // a cross-origin photo taints the canvas
  }
}

/**
 * A photo message: one balloon, or a run of them.
 *
* **Several photos are several balloons, one under the other.**
*
* This is what the device does, and it is not a reading of a framework — it was driven. Attaching
* N photos in the picker and tapping Send *once* puts N cells in the transcript, each a single
* photo with its own "Your iMessage, Includes picture" label; verified at N = 1, 3 and 10, and the
* ten-photo send produced exactly ten. Only the last balloon of the run carries a tail, and
* consecutive ones sit about 4 pt apart — which is `gapInGroup`, already measured here at 4.3333,
* the same quantity read twice to within a third of a point. `references/simulator-cases.md` §3.4.
*
* What this replaces was a fan of overlapping cards. That fan is a faithful reproduction of
* `CKGenericPhotoStackBalloonView`'s own geometry — `photoStackCard` still carries its frames, and
* `tests/unit/photo-stack.test.ts` still holds them to three decimals — but **no state reachable on
* the device draws it**, so it had no business being what a photo message looks like.
*
* Recursing rather than laying the run out here is deliberate: every single-photo behaviour — the
* aspect fit, the tail's sampled fill, the loading and failed states, the Live Photo badge, the
* viewer hand-off — is then the *same* code for one photo and for ten, and cannot drift.
 */
export function MessageImages(props: MessageImagesProps) {
  // Called before the branch and on every render, so the two sides can each own their hooks — which
  // is the whole reason this is a dispatcher and not an early return inside one component. A message
  // that gains or loses a second photo would otherwise change the hook order under React.
  const contextPlatform = usePlatform();
  const platform = props.platform ?? contextPlatform;
  return props.images.length > 1 ? <PhotoRun {...props} platform={platform} /> : <PhotoBalloon {...props} platform={platform} />;
}

function PhotoRun({ images, direction = "outgoing", tail = false, maxWidth, maxHeight, loading = false,
  onOpenImage, onOpen, reactions, platform: platformProp, className, style, ...props }: MessageImagesProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const m = bubbleMetrics[platform];
  const last = images.length - 1;
  return (
    <div data-slot="message-images" data-direction={direction} data-count={images.length}
      role="group" aria-label={`${images.length} Photos`}
      className={cn("relative flex flex-col", className)}
      style={{ flexShrink: 0, gap: m.gapInGroup, alignItems: direction === "outgoing" ? "flex-end" : "flex-start", ...style }} {...props}>
      {images.map((image, index) => (
        <PhotoBalloon key={`${image.src}-${index}`} images={[image]} direction={direction}
          tail={tail && index === last} maxWidth={maxWidth} maxHeight={maxHeight} loading={loading}
          platform={platform}
          // The index the caller sees stays the index in the whole message, so a viewer opened from
          // the third balloon still opens on the third photo.
          onOpenImage={onOpenImage && ((_, rect) => onOpenImage(index, rect))}
          onOpen={onOpen && (() => onOpen(index))}
          // The tapback belongs to the message, and the message ends at its last balloon.
          reactions={index === last ? reactions : undefined} />
      ))}
    </div>
  );
}

function PhotoBalloon({
  images, direction = "outgoing", tail = false, maxWidth, maxHeight, loading = false,
  onOpenImage, onOpen, reactions, platform: platformProp, className, style, ...props
}: MessageImagesProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const m = bubbleMetrics[platform];


  const side = direction === "outgoing" ? "right" : "left";
  const width = maxWidth ?? m.maxWidth;
  // Five card slots, all of them photos. The count card does NOT take one: it is an *accessory* item
  // in the layout (`numberOfAccessoryItems`, alongside `numberOfItems`), structurally separate from
  // the photo sprites. Stealing the last slot for it meant a six-photo message showed three photos,
  // and the card it stole was 0.21% of the front card's area — a wedge 1.76 pt wide, on which the
  // "+N Items" label rendered exactly 0 device pixels at 3x. A 3-, 5- and 10-photo message were
  // pixel-identical.
  const counted = images.length > MAX_TILES;
  const tiles = useMemo(() => images.slice(0, MAX_TILES), [images]);
  const overflow = images.length - tiles.length;
  const single = tiles.length === 1;
  const groupKey = tiles.map(image => image.src).join("|");

  // More than one photo is one balloon of a fixed shape, not a square of the text bubble's width: see
  // `photoStackBox`. 375 x 353 on macOS at any window size, 350.625 x 332.625 on iOS. The tiles inside
  // it are whatever the grid makes of that box, and stop being square with it — the box is the measured
  // part, the tiling is not (native draws a stack here, see the note at the top of the file).
  const stack = single ? null : photoStackSize(width, platform);

  // One photo keeps its aspect ratio: the caller's dimensions when it gave any, otherwise the image's
  // own once it has loaded. 4:3 is only the placeholder until then, and only for a photo whose size
  // this session has never seen; declaring `width`/`height` is what keeps the bubble from resizing at
  // all on a cold load.
  const [measured, setMeasured] = useState<{ src: string; aspect: number } | null>(null);
  const first: MessageImage | undefined = tiles[0];
  const firstSrc = first?.src ?? "";
  const declaredAspect = single && first?.width && first.height ? first.width / first.height : null;
  const learnedAspect = single ? (measured?.src === firstSrc ? measured.aspect : aspectMemo.get(firstSrc)) : undefined;
  const aspect = declaredAspect ?? learnedAspect ?? 4 / 3;

  // The clamp is the native one, and it is the SINGLE photo's: a very tall photo stops at 4:3 of its
  // width and a very wide one at 16:9, both cropped by `object-cover`; a portrait photo never grows
  // past `maxHeight`, and when the clamped shape would, the width comes in with it rather than the
  // photo stretching. The ceiling is portrait-only because that is what the sweep says (see
  // `photoBox`): a landscape or square photo at a width past 500 keeps its true fit. A group ignores
  // all of it — its box is `photoStackBox`, which never looks at the photos.
  // One photo is its own balloon and gets the photo balloon's width; a stack keeps `photoStackBox`,
  // which never looks at the photographs at all.
  const fit = photoBalloonSize(aspect, platform, width, maxHeight);
  const groupWidth = stack ? stack.width : fit.width;
  const height = stack ? stack.height : fit.height;

  /**
   * The box's width as actually rendered, which is not `groupWidth` whenever the clamp bites. The
   * cards are derived from it rather than from the constant, so a narrow transcript shrinks the whole
   * balloon instead of clamping the box and letting the cards spill out of the row.
   */
  const gridRef = useRef<HTMLDivElement>(null);
  const [renderedWidth, setRenderedWidth] = useState<number | null>(null);
  /**
   * Each card's photo shape, by `src`, as its `<img>` reports it. `aspectMemo` is the module-level
   * cache that survives a remount, but a `Map` is not something a memo can depend on, so the shapes
   * this mount has actually seen live here as well.
   */
  const [aspects, setAspects] = useState<Record<string, number>>({});

  /**
   * Where each card sits. Index 0 is the front one, the only one whose whole face shows; the four
   * behind it fan toward +x, each `sizeTransform` of the one in front and turned a further
   * `rotation`. Every number comes from `photoStackCard`, which is the framework's own model — see
   * the table above `photoStackLayout` for the frames it has to reproduce.
   */
  const cards = useMemo(() => {
    if (single) return null;
    const natural = stack?.width ?? width;
    const side = renderedWidth && renderedWidth > 0 ? renderedWidth : natural;
    // The box keeps its shape under the clamp (`aspectRatio` on the element), so its height follows
    // its width rather than staying at the unclamped constant.
    const boxHeight = stack ? (side / stack.width) * stack.height : side;
    // One shape for the whole deck, taken from the front photo.
    //
    // Two things had to be true at once. The card is *not* a fixed near-square cut from the box —
    // that made `minAspect`/`maxAspect` dead code and cropped a 4:3 landscape down by 29% of its
    // width. But it is not per-card either: giving each card its own photo's aspect puts a portrait
    // photo behind a landscape one as a taller card sharing the same centre line, so it juts out
    // above *and* below the front card and the deck stops reading as a deck. The layout's own
    // keyframe table carries an `aspectMixFactor` that is 1 at the focused slot, which is the
    // framework saying the same thing: the cards behind are drawn toward the focused item's shape,
    // not each in their own.
    const front = tiles[0];
    const declared = front?.width && front.height ? front.width / front.height : null;
    const learned = front ? aspects[front.src] ?? aspectMemo.get(front.src) : null;
    const shape = declared ?? learned ?? null;
    return Array.from({ length: MAX_TILES }, (_, index) => photoStackCard(index, side, boxHeight, platform, shape));
  }, [single, stack, width, renderedWidth, tiles, platform, aspects]);

  const hang = tailBox.hang * m.tailScale;
  // The tail continues the photo, so it is filled from the tile that touches it: the bottom tile on
  // the tail's side. Three photos put a full-height tile first, so on an incoming message that first

  const [tailFill, setTailFill] = useState<{ key: string; color: string } | null>(null);
  // A tile is on the placeholder until its own <img> says otherwise, so the bubble is never a hole.
  const [phase, setPhase] = useState<Record<string, Phase>>({});
  const [attempt, setAttempt] = useState<Record<string, number>>({});

  // Runs on mount as well as on load: a server-rendered <img> is normally already complete by the
  // time React attaches its handlers, and then `onLoad` never fires at all, the tail stays gray and
  // every tile looks unloaded. It is a layout effect so a photo the browser already has is laid out
  // at its real shape in the same frame, instead of painting 4:3 once and resizing.
  const measure = useCallback(() => {
    const element = gridRef.current;
    if (!element) return;
    const rendered = element.querySelectorAll("img");
    // By tile index, not by position in the list: a tile that failed renders no <img> at all, and
    // counting elements would then sample the wrong photo for the tail.
    const edge = element.querySelector<HTMLImageElement>(`img[data-tile="${TAIL_TILE}"]`);
    // Only ever replace a real colour with a real colour: a half-decoded image reads as null, and
    // dropping back to gray for a frame would flash the tail.
    const sampled = tail && edge ? sampleCorner(edge, side, tailBox.width * m.tailScale, tailBox.height * m.tailScale) : null;
    if (sampled) setTailFill(previous => (previous?.key === groupKey && previous.color === sampled ? previous : { key: groupKey, color: sampled }));
    setPhase(previous => {
      let next = previous;
      rendered.forEach(image => {
        if (!image.complete) return;
        const src = image.getAttribute("data-src") ?? image.src;
        const value: Phase = image.naturalWidth > 0 ? "ready" : "failed";
        if (previous[src] === value) return;
        if (next === previous) next = { ...previous };
        next[src] = value;
      });
      return next;
    });
    const photo = element.querySelector<HTMLImageElement>('img[data-tile="0"]');
    if (single && photo?.naturalWidth && photo.naturalHeight) {
      const value = photo.naturalWidth / photo.naturalHeight;
      aspectMemo.set(firstSrc, value);
      setMeasured(previous => (previous?.src === firstSrc && previous.aspect === value ? previous : { src: firstSrc, aspect: value }));
    }
    // Every card's own photo, not just a single one's. The stack fits each card to the item on it —
    // `-[PXGLayout geometryForSpriteAtIndex:]` answers a *landscape* box when the clamped item aspect
    // is landscape, so a stack that never learns an aspect draws five portrait cards whatever the
    // photographs are. Nothing was learning them: `aspectMemo` was only ever written for a single
    // photo, so a ten-photo stack of 4:3 landscapes rendered as five 0.75 portraits, each centre-
    // cropped to lose 44% of its width.
    setAspects(previous => {
      let next = previous;
      rendered.forEach(image => {
        if (!image.naturalWidth || !image.naturalHeight) return;
        const src = image.getAttribute("data-src") ?? image.src;
        const value = image.naturalWidth / image.naturalHeight;
        aspectMemo.set(src, value);
        // Only a real change is written back: returning a fresh object every time would re-lay the
        // fan forever, since laying it out is what schedules the next measure.
        if (previous[src] === value) return;
        if (next === previous) next = { ...previous };
        next[src] = value;
      });
      return next;
    });
  }, [single, tail, side, m.tailScale, groupKey, firstSrc, setMeasured, setPhase, setTailFill, setAspects]);
  useLayoutEffect(() => { measure(); }, [measure]);

  /**
   * The rendered width of the stack's box, watched rather than assumed. `groupWidth` comes from a
   * constant and `maxWidth: 100%` clamps the box against its row, so in any narrow transcript the two
   * disagree — and the cards, which were laid out in absolute points off the constant, went on
   * spilling out of the row while only the box shrank. Reading it back closes that: at a 140 pt
   * container the front card used to hang 178.63 pt out with the tail 210.63 pt adrift from the photo
   * it continues.
   */
  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!element) { setRenderedWidth(null); return; }
    const apply = () => {
      // CSS width stays in layout coordinates when the app preview is scaled.
      const next = parseFloat(getComputedStyle(element).width);
      // Sub-hundredth changes are layout noise, and taking them would re-run the cards memo forever.
      setRenderedWidth(previous => (previous !== null && Math.abs(previous - next) < 0.01 ? previous : next));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, [single]);

  const retry = useCallback((src: string) => {
    setPhase(previous => { const next = { ...previous }; delete next[src]; return next; });
    setAttempt(previous => ({ ...previous, [src]: (previous[src] ?? 0) + 1 }));
  }, []);

  const countCard = counted ? cards?.[0] : null;
  const open = onOpenImage ?? (onOpen ? (index: number) => onOpen(index) : undefined);
  const busy = loading || tiles.some(image => phase[image.src] === undefined);
  const slot = reactionSlot[platform];
  // No photos is not an empty balloon: without this the group would paint a bare gray square the size
  // of a four-tile grid.
  if (!tiles.length) return null;

  return (
    <div data-slot="message-images" data-direction={direction} data-count={images.length}
      // ChatKit's `attachment.count` reads "%d attachments"; the group is named with the photo noun
      // its own `PHOTO_ATTACHMENT_STATUS_PHOTOS_TITLE_FORMAT` ("%tu Photos") uses. One photo needs no
      // group at all: the tile's own name already says everything.
      role={images.length > 1 ? "group" : undefined}
      aria-label={images.length > 1 ? `${images.length} Photos` : undefined}
      aria-busy={busy || undefined}
      className={cn("relative", className)}
      // `maxWidth: 100%` is the ceiling this group used to be missing entirely. `groupWidth` derives
      // from a constant — `bubbleMetrics[platform].maxWidth` — with nothing tying it to the transcript
      // it is drawn in, so a pane narrower than that (a resized window, an open inspector, a two-pane
      // layout) had the group hang out of its row: at a 140 pt container the macOS group measured
      // 382.5 wide and spilled 242.5 px, which is the defect this line closes. It matters more now
      // that a group is 375 pt on Mac and 350.6 on iOS by `photoStackBox` rather than the balloon's
      // own width. Native's own rule is `balloonMaxWidth` above, and a shell that resizes its
      // transcript should pass that as `maxWidth`; this is the floor under it either way.
      // Keep WebKit's resampling quality stable when a cached photo changes size during opening.
      // Its default animated-resize heuristic otherwise repaints the same paused frame blurred.
      style={{ flexShrink: 0, width: groupWidth, maxWidth: "100%", imageRendering: "optimizeQuality" as CSSProperties["imageRendering"], boxSizing: "border-box", fontFamily: fontStack, marginTop: reactions ? slot.marginTop : undefined, ...style }} {...props}>
      {/* `aspectRatio` rather than a pixel height, so the box keeps its shape when the clamp above
          bites: at full width it resolves to exactly `height`, and under the clamp the grid shortens
          with its width instead of holding a tall box over narrow tiles. */}
      {/* A stack, not a grid: the cards are placed in this box rather than flowed through it, and the
          box itself paints nothing — the front card is what the balloon looks like, so the corner and
          the tail belong to it and not to a container clipping four tiles. A single photo keeps the
          old shape, where the box *is* the balloon. */}
      <div ref={gridRef} data-slot={single ? "image-grid" : "photo-stack"} style={single
        ? { display: "block", width: "100%", aspectRatio: `${groupWidth} / ${height}`, borderRadius: m.radius, overflow: "hidden", clipPath: tail ? bodyClipPath(side, m.tailScale, tailSeamOverlap[platform]) : undefined, background: "var(--im-gray-top)" }
        // `isolation: isolate` is load-bearing, not tidiness: the cards carry a `zIndex` so the front
        // one paints last, and without a stacking context here those numbers escape to the nearest
        // ancestor that has one - which put the whole stack on top of the open photo viewer, a card
        // floating over the full-screen photo it had just been tapped to open.
        : { position: "relative", isolation: "isolate", width: "100%", aspectRatio: `${groupWidth} / ${height}` }}>
        {tiles.map((image, index) => {
          const state = phase[image.src];
          // Two ways into the same affordance: the transfer was never fetched (`pending`), or it was
          // and it did not arrive. Native offers the download either way, so the tile does too.
          const failed = image.pending === true || state === "failed";
          const name = image.alt?.trim() || "Photo";
          // "Photo, 2 of 5" follows ChatKit's own `messages.attachment.stack.view.format`
          // ("attachment %1$d of %2$d"); the counted tile has to say what its "+N" opens.
          const position = images.length > 1 ? `${name}, ${index + 1} of ${images.length}` : name;
          // "Live Photo" is the noun VoiceOver reads for an iris asset, and it is the only thing the
          // badge says, so the name has to carry it or the badge is invisible without sight.
          const named = image.livePhoto ? `Live Photo. ${position}` : position;
          const label = failed ? `${named}. ${downloadLabel[platform]}.` : named;
          // A tile that cannot be fetched offers the fetch again, the way native's undownloaded
          // attachment does. Otherwise it opens the viewer, handing over its own box so the viewer can
          // grow out of this tile.
          const activate: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined = failed
            ? () => retry(image.src)
            : open
              ? event => open(index, event.currentTarget.getBoundingClientRect())
              : undefined;
          // A button is a control for the pointer and the keyboard both, for free. With nothing to
          // open it would be a dead tab stop that reads out "dimmed", so the tile becomes a named
          // image instead: the photo keeps its accessible name either way.
          const card = cards?.[index];
          const shell = {
            "data-slot": "photo-tile", "data-index": index,
            // The shape the card was fitted to, so a test can read what the fan decided rather than
            // inferring it from a rotated bounding box.
            "data-aspect": card ? (card.width / card.height).toFixed(4) : undefined,
            "data-state": failed ? "failed" : state === "ready" ? "ready" : "loading",
            "aria-label": label,
            className: cn("block overflow-hidden p-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0088ff]",
              card ? "absolute" : "relative h-full w-full"),
            style: card
              ? {
                  // Painted back to front, so the front card is on top and takes the pointer.
                  zIndex: MAX_TILES - index,
                  left: card.left, top: card.top, width: card.width, height: card.height,
                  transform: `rotate(${card.rotate}deg) scale(${card.scale})`,
                  transformOrigin: "50% 50%",
                  borderRadius: photoStackLayout.radius,
                  // Only the front card carries the balloon's tail; the ones behind are plain cards.
                  clipPath: index === 0 && tail ? bodyClipPath(side, m.tailScale, tailSeamOverlap[platform]) : undefined,
                  // The placeholder fill goes as soon as the photograph is there. It is not tidiness:
                  // a card's edge lands on a fraction (the front one's trailing edge at x 370.875),
                  // and the browser antialiases the clip against everything the card paints, so the
                  // light grey underneath the photo bleeds into that last third of a device pixel —
                  // measured at 3x as a column of (148,167,182) between the photo's (124,151,172) and
                  // the card behind's (114,125,140). Same family as `tailSeamOverlap`: two layers
                  // must not share a fractional edge. The oversteps on the <img> close it from the
                  // photo's side; this closes it from the card's.
                  background: state === "ready" ? undefined : "var(--im-gray-top)",
                  boxShadow: index === 0 ? undefined : "0 0 0 0.5px rgba(0,0,0,0.06)",
                }
              : undefined,
          } as const;
          const inner = (
            <>
              {failed ? (
                // The placeholder the grid already paints, plus native's own copy for a photo it does
                // not have. `downloadFontSize` is `-[CKUIBehavior downloadButtonFont]`, 17 on both;
                // the weight and the line height are not measured.
                <span data-slot="photo-failed" aria-hidden="true"
                  className="absolute inset-0 flex items-center justify-center px-[8px] text-center"
                  style={{ fontSize: downloadFontSize, lineHeight: 1.2, color: "var(--im-incoming-text)" }}>
                  {downloadLabel[platform]}
                </span>
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img key={attempt[image.src] ?? 0} src={image.src} data-src={image.src} data-tile={index} alt="" loading="lazy" decoding="async"
                  onLoad={measure} onError={measure}
                  className={cn("object-cover", card ? "absolute" : "h-full w-full")}
                  style={card
                    // A card's box lands on a fraction — the front one at x 67.375 — and WebKit
                    // rounds the card's own background and the image inside it to different device
                    // pixels there, leaving one column of the placeholder grey down the leading edge.
                    // At 3x it measures (177, 204, 221) against (168, 199, 219) beside it, which is
                    // the photo blended about 15% with #e9e9eb. Chromium does not do it, which is
                    // exactly the shape of `tailSeamOverlap`: two layers must not share a fractional
                    // edge. The image oversteps its clip by half a pixel on every side, so the clip
                    // is what defines the edge and nothing behind it can show. Half a pixel of a
                    // 286 pt crop is not a visible change to the photograph.
                    // `maxWidth: none` is what makes the overstep above actually happen. Tailwind's
                    // preflight carries `img { max-width: 100% }`, which clamped the width straight
                    // back to the card's and left the half pixel unpainted on the trailing edge —
                    // measured at 3x as a column of rgb(233,233,235), the placeholder's own grey,
                    // down the right of every card in the fan. The height was never clamped, so only
                    // one of the two edges this was written to close was ever closed.
                    ? { inset: -0.5, width: "calc(100% + 1px)", maxWidth: "none", height: "calc(100% + 1px)", opacity: loading ? 0 : 1 }
                    // Give a single photo its own composited layer. Chromium otherwise sometimes
                    // leaves a 256px raster tile blank beneath a translucent viewer/composer.
                    : { opacity: loading ? 0 : 1, transform: "translateZ(0)" }} />
              )}
              {/* The per-depth overlay. `overlayAlpha` in the layout's keyframe table is 0.1 per step
                  of depth — 0, 0.1, 0.2, 0.3, 0.4 — and it is a large part of why a real stack reads
                  as depth rather than as four flat slivers of photograph. NOT MEASURED: what colour
                  it paints. It is not in the sprite style (`f[1..4]` are 0,0,1,1 on every sprite), so
                  the item effect view draws it and this is black at the measured alpha, which is the
                  reading that makes a card behind recede. */}
              {card && card.scrim > 0 && (
                <span data-slot="photo-card-scrim" aria-hidden="true" className="pointer-events-none absolute inset-0"
                  style={{ background: `rgba(0,0,0,${card.scrim})` }} />
              )}
              {/* Native puts the badge on the photo, not on the balloon, so a Live Photo in a group
                  gets one per tile. Hidden while the tile is still on the placeholder: a badge over a
                  gray square announces a photo that is not there yet. */}
              {image.livePhoto && !failed && !loading && state === "ready" && (
                <span data-slot="live-photo-badge" aria-hidden="true" className="pointer-events-none absolute"
                  style={{ top: livePhotoBadge[platform].inset, left: livePhotoBadge[platform].inset }}>
                  <LivePhotoGlyph platform={platform} />
                </span>
              )}

            </>
          );
          return activate
            ? <button key={image.src + index} type="button" onClick={activate} {...shell}>{inner}</button>
            : <div key={image.src + index} role="img" {...shell}>{inner}</div>;
        })}
        {/* "+N Items", when there are more photos than the five the stack draws.

            What is measured: `PXMessagesStackAdditionalItemsView` is a `UIBlurEffect` behind a centred
            SF Bold 17 label in systemBlue, `_localizedTitleForAdditionalItemsCount:` produces the
            string, and the card is an *accessory* item — `numberOfAccessoryItems`, separate from the
            photo sprites — so it does not take a photo's place in the fan.

            What is NOT measured, and this is the honest part: WHERE it sits.
            `-[PXMessagesStackView setAdditionalItemsCount:]` raises on a layout with no data source,
            so its frame could not be read. What this draws is therefore a placement, not a
            measurement — a pill on the front card, in the bottom corner away from the tail so it
            collides with neither the tail nor the fan. It replaces a version that put the count in
            the deepest fan slot, where it rendered *zero* device pixels at 3x: the front card covered
            the label completely, a wedge 1.76 pt wide was all the card ever showed, and three, five
            and ten photos came out pixel-identical. An unmeasured position that can be read beats a
            measured-looking one that cannot.

            The material follows the page colour rather than a hardcoded light fill, since which
            `UIBlurEffect` style it uses is unmeasured too; `--im-stack-more` overrides it. */}
        {counted && countCard && (
          <button type="button" data-slot="photo-stack-more" aria-label={`Show ${overflow} more photo${overflow === 1 ? "" : "s"}.`}
            onClick={open ? event => open(tiles.length, event.currentTarget.getBoundingClientRect()) : undefined}
            className="absolute flex items-center justify-center overflow-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0088ff]"
            style={{
              zIndex: MAX_TILES + 1,
              [side === "right" ? "left" : "right"]: countCard.left + countCardInset,
              top: countCard.top + countCard.height - countCardInset - countCardHeight,
              height: countCardHeight, paddingInline: 12,
              borderRadius: countCardHeight / 2,
              background: "var(--im-stack-more, color-mix(in srgb, var(--im-bg) 82%, transparent))",
              backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
              boxShadow: "0 0 0 0.5px rgba(0,0,0,0.06)",
              color: "var(--im-stack-more-label, #0088ff)", fontSize: 17, fontWeight: 700, letterSpacing: 0, whiteSpace: "nowrap",
            }}>
            {photoStackLayout.more(overflow)}
          </button>
        )}
      </div>
      {/* On the front card's bottom corner, not the box's: a stack's box is wider and taller than the
          card it holds (the margin rule leaves room for the cards behind to peek into), so a tail
          pinned to the box would float away from the photo it is supposed to continue. */}
      {tail && (
        <div aria-hidden="true" data-slot="tail" className="pointer-events-none absolute"
          style={{
            [side]: cards ? (stack ? stack.width : width) - (cards[0].left + cards[0].width) : 0,
            bottom: cards ? (stack ? stack.height : height) - (cards[0].top + cards[0].height) - hang : -hang,
            width: tailBox.width * m.tailScale, height: tailBox.height * m.tailScale + hang,
            clipPath: `path("${tailPath(side, m.tailScale)}")`,
            background: tailFill?.key === groupKey ? tailFill.color : "var(--im-gray-bottom)",
          }}>
          {/* On a stack the tail is a corner of the front card, so it can carry the photograph itself
              rather than one colour averaged out of that corner. The same photo is laid out at the
              card's size and pushed back by the card's own offset, so the pixels line up across the
              seam; the flat fill stays behind it for the 6.8 pt that hangs below the card, where
              there is no photo to continue. A single photo uses the same continuation below, sized to its rendered box. */}
          {/* Continue the actual photograph through the cutout. A sampled flat fill over this
              region hides the photo's texture; the fallback belongs only below its bottom edge.
              This follows the existing outline, without changing the measured tail geometry. */}
          {single && firstSrc && !loading && phase[firstSrc] === "ready" && (
            // Use the same image renderer as the body. WebKit snaps a CSS background one pixel
            // differently here, leaving a visible texture seam along the tail cutout.
            // eslint-disable-next-line @next/next/no-img-element
            <img data-slot="photo-tail-image" src={firstSrc} alt="" aria-hidden="true" className="absolute max-w-none object-cover" style={{
              width: renderedWidth ?? groupWidth,
              height: (renderedWidth ?? groupWidth) * height / groupWidth,
              [side]: 0,
              top: -((renderedWidth ?? groupWidth) * height / groupWidth - tailBox.height * m.tailScale),
            }} />
          )}
          {cards && firstSrc && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={firstSrc} alt="" aria-hidden="true" className="absolute max-w-none object-cover"
              style={{
                width: cards[0].width, height: cards[0].height,
                // The tail's own edge on `side` is the card's edge, so the photo lines up there with
                // no offset; vertically the tail starts one tail-height above the card's bottom.
                [side]: 0,
                top: -(cards[0].height - tailBox.height * m.tailScale),
              }} />
          )}
        </div>
      )}
      {/* Outside the grid on purpose: the grid clips to the balloon's outline, and a balloon that laps
          the photo's rounded corner would lose its own edge to that clip. */}
      {reactions && (
        <div data-slot="reactions" className="absolute z-10" style={{ top: slot.top, [direction === "outgoing" ? "left" : "right"]: slot.side }}>{reactions}</div>
      )}
    </div>
  );
}

/** Override the sampled tail colour, e.g. when the image is cross-origin and cannot be read back. */
export function photoTailFill(color: string): CSSProperties {
  return { ["--im-gray-bottom" as string]: color } as CSSProperties;
}
