"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/message-ui/avatar";
import { IosMicIcon } from "@/components/message-ui/ios-composer";
import { useBubbleScreenSpace } from "@/components/message-ui/use-screen-space";

/**
 * iOS 26 Messages search: what the conversation list becomes when the search field takes focus, and
 * the result sections that fill the screen once there is a query.
 *
 * ## Where the numbers come from
 *
 * **Measured from a capture.** Two captures of this screen were taken on 2026-09-08 on the same
 * iPhone 17 Pro / iOS 26.0 simulator as the rest of `references/ios/captures`, by pressing **⌘F** in
 * Messages with a hardware keyboard attached (no pointer events; the state cannot be reached any
 * other way from a script):
 *
 * - `references/ios/captures/search-active-light.png` - focused, empty query, light.
 * - `references/ios/captures/search-noresults-dark.png` - query "Detail", no matches, dark.
 *
 * They settle the layout, and they overturn what this file used to draw:
 *
 * - **The field does not move.** Diffing `search-active-light.png` against `list-light.png` over the
 *   bottom bar returns a difference box that starts at x 224 px (the caret) - every pixel of the pill
 *   left of it, the magnifier, the placeholder, the mic, the pill's shadow and the 12pt gap to the
 *   circle beside it are byte-identical. The pill stays 286 wide at x 28-314, y 798-846. There is no
 *   rise to the top of the screen, no widening, and **no Cancel button**.
 * - **The compose circle becomes a close button** in place: the same Ø48 glass circle centred
 *   (350, 822), now holding an ✕ whose ink box is exactly 17.0 x 17.0 centred (349.833, 822.5) with a
 *   ~2.0pt diagonal stroke in the compose glyph's own ink colour.
 * - **The conversation list is simply replaced**, with no dim: every pixel above the bar in
 *   `search-active-light.png` is the page background (`searchControllerObscuresConversationList` is
 *   YES on the Phone behaviour). The 20% black scrim this file used to paint does not exist.
 * - **The caret** is 2.0 x 22.0 at x 74.667, y 811-833 (centre 822.0) in the measured link blue, drawn
 *   over the placeholder's leading edge; the placeholder itself does not move or fade.
 * - **The mic survives focus** and is swapped for a Ø17.0 clear disc only once there is text. The disc
 *   is centred (284.5, 821.833) - the mic ink's own centre to within 0.17 - filled with the
 *   placeholder colour, with a knocked-out ✕ whose ink box is 7.2pt across and ~1.65pt thick.
 * - **Typed text** starts at the placeholder's own origin and is the placeholder's weight (both stems
 *   measure 5 device px at 3x), in the label colour, not a lighter one.
 * - **Nothing is shown before a query.** `search-active-light.png` is blank above the bar, so the
 *   default empty state really is nothing.
 * - **"No Results"** is UIKit's search content-unavailable view, not a ChatKit one: a magnifier whose
 *   ink is 45.33 x 46.0 at y 375.67-421.67, "No Results" (cap top 445.33, cap height 16.0, ink
 *   107.67 wide) and "Check the spelling or try a new search." (ink 473.0-486.33, 263.0 wide), all
 *   centred on x 201. The block's ink centre is y 431.0 and the results area runs 62 to 798, whose
 *   centre is 430.0 - so the block is centred in the results area, which is also what pins
 *   `resultsTop` and the results area's bottom edge. Only the title string is ChatKit's
 *   (`SEARCH_RESULTS_INDEXING_TITLE`); the subtitle is not in `ChatKit.loctable` at all.
 *
 * Everything the field and the rows share with the conversation list is still the conversation list's
 * measurement (`list-light.png` / `list-dark.png`, SPEC.md "Conversation list"): the 48pt pill inset
 * 28 with radius 24, the magnifier, the 86.6667 row, the Ø45 avatar at x 26, the 17pt semibold name at
 * x 83, the 15pt time, the chevron at 376, the 15/20 preview, the separator from x 83 to 386, the
 * glass fills and shadows, and the #0088ff / #0091ff tint.
 *
 * **Measured motion** (`references/ios/motion/search-open.mov`, `search-close.mov`, recorded with
 * `simctl io recordVideo`; the simulator writes a frame only when the screen changes, so every frame
 * carries its own timestamp). Both were traced by summing the blue channel excess of the two avatars
 * over a fixed column, which is proportional to the list's alpha, and by following the avatars' ink
 * box, which gives their translation:
 *
 * - **Opening takes 267 ms.** The list fades out where it stands and slides *up*; its diameter never
 *   changes, so there is no scale. Alpha runs 1.000, 0.973, 0.955, 0.904, 0.844, 0.773, 0.681, 0.586,
 *   0.488, 0.401, 0.312, 0.230, 0.155, 0.103, 0.053, 0.034, 0.000 on an even 16.7 ms grid - a
 *   symmetric S, half gone at 131 ms. The translation accelerates: 0, 2.00, 5.17, 9.33, 15.33, 22.67,
 *   31.33, 40.67, 51.33, 61.33, 71.00 pt at the same times, still accelerating when the list gets too
 *   faint to follow at 172 ms. The bar does not move at all; only the trailing circle's glyph changes.
 * - **Closing takes 292 ms and is not the opening reversed.** The search surface is gone inside one
 *   recorded frame (under 3.3 ms) and the list appears at alpha 0.858, 106.67 pt high, then settles:
 *   translation 0, 0.031, 0.119, 0.275, 0.431, 0.619, 0.794, 0.913, 0.988, 1.000 of the travel and
 *   alpha 0.858 -> 1.000, both ease-in-out over the same 292 ms.
 *
 * Both curves are carried as keyframe tables (`iosSearchMotion`) rather than as an easing name,
 * because they are samples, not a fitted curve. The list is a sibling component this file does not
 * own, so the surface reproduces the measured *visibility* by painting the page colour at
 * `1 - listAlpha` (the composite over the same background colour is the same pixels), and the
 * translation is applied only when the caller hands over the list's scrolling layer as `listRef`.
 *
 * **Read out of the framework.** No capture of a search *result* exists and none can be taken: the
 * simulator's two conversations hold no messages and its Spotlight index is empty, so every query
 * returns "No Results". The sections are therefore built from ChatKit 26.5, read at runtime off
 * `[[CKUIBehaviorPhone alloc] init]` in a Mac Catalyst probe that dlopens
 * `/System/iOSSupport/System/Library/PrivateFrameworks/ChatKit.framework/ChatKit`. Each value names
 * its selector on the constant it feeds. Section titles, "See All" and "No Results" are the
 * framework's own English strings from `ChatKit.loctable`.
 *
 * Three structural facts also come from the runtime rather than guesswork:
 *
 * - `+[CKConversationSearchResultCell conversationListCellClass]` returns
 *   `CKConversationSearchResultEmbeddedCell`, a `CKConversationListStandardCell` subclass, and
 *   `-[CKUIBehavior searchMessageCellHeightForDisplayScale:]` returns 86.66667 at scale 3, 86.5 at 2
 *   and 87 at 1 - the conversation list's own row pitch. **Careful:** that selector branches on the
 *   live `UIDevice` idiom, not on the behaviour class, so a probe that applies the documented `.mac`
 *   swizzle gets 84.0 at every scale. Unswizzled (Catalyst reports the phone idiom) it gives the
 *   iPhone numbers above, which are the ones this file uses.
 * - `-[CKMessageSearchResultCell _annotatedResultStringForResult:searchText:]` passes
 *   `searchMessagesBalloonFont` as **both** the primary and the annotated font and only swaps the
 *   colour, so a message match is recoloured, never bolded. Its pre-trim,
 *   `ck_trimmedStringWithPreferredLength:anchoredAroundSubstring:` at 200 characters, is
 *   `trimAroundMatch` below. That pre-trim alone leaves the match off the end of a one-line balloon,
 *   so the balloon additionally anchors its *visible* window on the match - see `Snippet`.
 * - `CKLinkSearchResultCell` holds an `LPLinkView` and an `LPLinkMetadata`, so a link result is a
 *   LinkPresentation card, not a thumbnail with two captions under it.
 *
 * **Judgement, not measured.** Called out again on each constant: how the framework's own spacings
 * compose into a section (which constant is the gap under a header and which is the gap under a
 * section); that Photos, Links and Documents lay out as horizontal strips; that
 * `searchCellPreferredWidth` is the strip cell's width; that results scroll under the floating bar;
 * and the clear button's cross arm length. Do not quote any of those as measured.
 */

/** Section kinds, named after ChatKit's own controllers (`CKPhotosSearchController` and friends). */
export type IosSearchSectionKind = "conversations" | "messages" | "photos" | "links" | "documents";

export type IosSearchConversationResult = {
  id: string;
  name: string;
  initials?: string;
  photo?: string;
  /** The matching line. The part of it that matches the query is recoloured, not bolded. */
  preview: string;
  time: string;
};

export type IosSearchMessageResult = {
  id: string;
  /** Who sent it. */
  name: string;
  initials?: string;
  /** The chat it is in, shown ahead of the sender. */
  conversation?: string;
  text: string;
  time: string;
  /** Your own message: the balloon takes the outgoing fill and the match turns pure white. */
  fromMe?: boolean;
};

export type IosSearchPhotoResult = { id: string; src?: string; name: string; time: string };

export type IosSearchLinkResult = { id: string; title: string; domain: string; time: string; src?: string };

export type IosSearchDocumentResult = { id: string; title: string; time: string; src?: string };

export type IosSearchResult =
  | IosSearchConversationResult
  | IosSearchMessageResult
  | IosSearchPhotoResult
  | IosSearchLinkResult
  | IosSearchDocumentResult;

export type IosSearchSection =
  | { kind: "conversations"; title?: string; results: IosSearchConversationResult[] }
  | { kind: "messages"; title?: string; results: IosSearchMessageResult[] }
  | { kind: "photos"; title?: string; results: IosSearchPhotoResult[] }
  | { kind: "links"; title?: string; results: IosSearchLinkResult[] }
  | { kind: "documents"; title?: string; results: IosSearchDocumentResult[] };

/**
 * Every number the screen draws with, and where each one came from. "ChatKit" means it was read off
 * `-[CKUIBehavior …]` through the Phone behaviour; "measured" names the capture it was measured in.
 */
export const iosSearchMetrics = {
  /** The screen these were measured on. Points equal CSS px. */
  screen: { width: 402, height: 874 },
  field: {
    /** Measured, `list-light.png` and unchanged in `search-active-light.png`: 48 tall, radius 24. */
    height: 48,
    inset: 28,
    radius: 24,
    /** Measured: the bar sits 28 above the screen's bottom edge, so the pill spans y 798-846. */
    bottomInset: 28,
    /** Measured: the 12pt gap between the pill and the circle beside it. */
    gap: 12,
    /** Measured: the trailing glass circle is Ø48 centred (350, 822). */
    button: 48,
    /** Measured: magnifier, placeholder and mic offsets inside the pill (identical in both states). */
    glyphLeft: 19,
    glyphTop: 14,
    textLeft: 46.8,
    textTop: 15.5,
    micRight: 23.3333,
    micTop: 14.6667,
    micWidth: 12.6667,
    micHeight: 18.3333,
    /**
     * Measured, `search-noresults-dark.png`: the clear disc is Ø17.0 centred (284.5, 821.833), i.e.
     * 21.0 in from the pill's trailing edge and 15.3333 below its top. Its knocked-out cross ink is
     * 7.2pt across at ~1.65pt thick; the arm length inside that box is judgement.
     */
    clearSize: 17,
    clearRight: 21,
    clearTop: 15.3333,
    clearCross: 1.65,
    /** Measured, `search-active-light.png`: 2.0 x 22.0 at x 74.667, y 811-833. */
    caretWidth: 2,
    caretHeight: 22,
    caretLeft: 46.6667,
    caretTop: 13,
    /**
     * Measured, `search-active-light.png`: the ✕ ink box is 17.0 x 17.0 centred (349.833, 822.5) in
     * the Ø48 circle at (326, 798), so it starts 15.333 in and 16.0 down. Diagonal stroke 2.0
     * (a 9px horizontal cut at 3x is 8.6px of ink, 6.08px across the stroke). `closeGlyphLeft` carries
     * 15.6667 rather than 15.3333: Chrome snaps an SVG layer's origin down to the nearest CSS pixel,
     * so 15.3333 renders the ink box one device pixel left of the capture's and 15.6667 lands on it.
     */
    closeGlyph: 17,
    closeGlyphLeft: 15.6667,
    closeGlyphTop: 16,
    closeStroke: 2,
  },
  /** ChatKit `-[CKUIBehavior additionalSearchResultTopPadding]`, and what the "No Results" block's measured centre confirms. */
  resultsTopPadding: 8,
  header: {
    /** ChatKit `searchHeaderHeight`. */
    height: 44,
    /** ChatKit `searchHeaderFont`: SF Semibold 20, line 23.5547, cap 14.0918. */
    fontSize: 20,
    lineHeight: 23.5547,
    weight: 600,
    /** ChatKit `searchHeaderButtonFont`: SF Regular 17, line 20.0215. */
    buttonFontSize: 17,
    buttonLineHeight: 20.0215,
    /** ChatKit `searchSectionMarginInsets` = {0, 16, 0, 16}, the same 16 as `searchLeadingAndTrailingMaxPadding`. */
    margin: 16,
    /** ChatKit `searchSectionHeadersPinToBounds` is YES, so headers stick. */
    pinned: true,
    /** ChatKit `searchResultsTitleHeaderBottomPadding`: the gap under a title header. */
    bottomPadding: 12,
  },
  /**
   * ChatKit `searchMessageCellHeightForDisplayScale:` - 86.66667 at scale 3, 86.5 at 2, 87 at 1 -
   * which at 3x is the conversation list's measured row pitch, and
   * `+[CKConversationSearchResultCell conversationListCellClass]` hands the conversation section a
   * `CKConversationListStandardCell` subclass. So both row kinds are one measured row.
   */
  row: {
    height: 86.6667,
    /** Measured, `list-light.png`. */
    avatar: 45,
    avatarLeft: 26,
    avatarTop: 20,
    textLeft: 83,
    nameTop: 14,
    nameSize: 17,
    nameWeight: 600,
    timeSize: 15,
    timeRight: 37.1167,
    timeTop: 15,
    chevronLeft: 376,
    chevronTop: 15,
    previewTop: 33,
    previewSize: 15,
    previewLine: 20,
    separatorLeft: 83,
    separatorRight: 16,
  },
  /** ChatKit `searchConversationSectionInsets` = {20, 0, 20, 0}: above the first row and below the last. */
  conversationSection: { top: 20, bottom: 20 },
  message: {
    /** ChatKit `searchMessagesAvatarSize` = {28, 28}. */
    avatar: 28,
    /** ChatKit `searchMessagesTopSpacing` / `searchMessagesBottomSpacing`. */
    topSpacing: 12,
    bottomSpacing: 18,
    /** ChatKit `searchMessagesConversationToSenderSpacing`. */
    conversationToSender: 4,
    /** ChatKit `searchMessagesSenderToBalloonSpacing`. */
    senderToBalloon: 8,
    /** ChatKit `searchMessagesBalloonToChevronSpacing`. */
    balloonToChevron: 12,
    /**
     * ChatKit `searchMessagesHorizontalBalloonMargin`. Applied as the balloon's width ceiling, where
     * at 402pt it never binds: the track between x 83 and the chevron is 281 wide, well under the
     * 330 this allows. It is kept because it is the only framework constant that governs balloon
     * width, and it does bind on a wider screen.
     */
    horizontalBalloonMargin: 72,
    /** ChatKit `searchMessagesBalloonFont` (SF Regular 17) and its 20.0215 line box. */
    balloonFontSize: 17,
    balloonLine: 20.0215,
    /** ChatKit `searchMessagesSenderFont` / `searchMessagesDateFont` (SF Regular 12), line 14.1328. */
    labelFontSize: 12,
    labelLine: 14.1328,
    /** ChatKit `searchMessagesDMConversationFont` / `…GroupConversationFont` are SF **Medium** 12. */
    conversationWeight: 500,
    /** ChatKit `searchMessagesMaxSummaryLength`: the pre-trim length, not the visible one. */
    maxSummaryLength: 200,
    /** Measured bubble padding (tokens.ts `bubbleMetrics.ios.paddingX`). */
    balloonPaddingX: 13.85,
    /** Measured bubble radius, clamped to a capsule by the balloon's own height. */
    balloonRadius: 19,
    /** ChatKit `searchMessagesFromMeUnannotatedLabelColor` is white at 0.6. */
    fromMeUnannotated: "rgba(255,255,255,0.6)",
  },
  /**
   * ChatKit `searchCellPreferredWidth` = 160 is the only cell-size constant the framework exposes for
   * these sections, and `searchLinksFractionalWidthScale` 1.2 / `searchLinksFractionalHeightScale`
   * 0.85 read as fractions *of it*, which gives a 192 x 136 landscape link card - the shape an
   * `LPLinkView` actually is. Reading them as multiples of a photo tile instead gave a card taller
   * than it is wide. No capture exists, so the strip layout itself stays judgement.
   */
  cellWidth: 160,
  photos: {
    /** ChatKit `searchPhotosInterItemSpacing`. */
    gap: 10,
    /**
     * ChatKit `searchPhotosCellCornerRadius` is 0 on the Phone behaviour. `CKUIBehaviorMac` overrides
     * it to 8, which is what makes 0 read as a real value rather than an unset default.
     */
    radius: 0,
  },
  links: {
    /** ChatKit `searchLinksInterItemSpacing` and `searchLinksCellCornerRadius` (Mac overrides to 8). */
    gap: 10,
    radius: 10,
    /** ChatKit `searchLinksFractionalWidthScale` / `searchLinksFractionalHeightScale`, on `searchCellPreferredWidth`. */
    widthScale: 1.2,
    heightScale: 0.85,
    /** ChatKit `searchResultLabelBoldFont` / `searchResultLabelFont`: SF Semibold and Regular 12. */
    labelFontSize: 12,
    labelLine: 14.1328,
    /**
     * UNMEASURED. `CKLinkSearchResultCell` hosts an `LPLinkView`, whose small form puts a glass caption
     * bar over the foot of the image, but nothing in ChatKit sizes that bar and no capture of one
     * exists. 44 is two 14.1328 lines plus the framework's own 16pt section margin less its 4pt inset,
     * which is a shape, not a measurement.
     */
    captionHeight: 44,
    captionPadding: 12,
  },
  documents: {
    /** ChatKit `searchAttachmentsInterItemSpacing`, `searchAttachmentsCellCornerRadius`. */
    gap: 10,
    radius: 10,
    /** ChatKit `searchAttachmentsTitleTopPadding` and `searchAttachmentsCellDatePadding`. */
    titleTop: 12,
    dateTop: 4,
    labelFontSize: 12,
    labelLine: 14.1328,
  },
  /**
   * ChatKit `searchConversationSectionInsets.bottom`, generalised to every section as the gap before
   * the next header. It is the framework's only "bottom of a section" value; the generalisation is
   * judgement.
   */
  sectionGap: 20,
  /** ChatKit `searchDefaultMaxResults`: how many rows a section shows before "See All". */
  maxResults: 4,
  /** ChatKit `searchDetailsResultsInsets` / `searchDetailsSectionMarginInsets`, for the See All screen. */
  details: {
    resultsInsets: { top: 12, leading: 16, bottom: 16, trailing: 16 },
    sectionMargin: 16,
    seeAllTrailingMargin: 0,
  },
  empty: {
    /**
     * Measured, `search-noresults-dark.png`: the magnifier's ink is 45.3333 x 46.0, "No Results" has a
     * 16.0 cap height (22pt SF, whose cap is 15.501, plus a third of a point of antialiasing on each
     * side) and its ink bottom sits 11.6667 above the subtitle's ink top, which starts 23.6667 below
     * the magnifier's ink bottom. `searchIndexingTitleFont` is SF 22 and `searchIndexingSubtitleFont`
     * SF 15, which is what those measurements land on.
     */
    glyph: 45.3333,
    glyphHeight: 46,
    glyphToTitle: 20.6667,
    titleFontSize: 22,
    titleWeight: 700,
    titleToSubtitle: 5,
    /**
     * The block is centred by its layout box, whose line boxes carry more leading below the last ink
     * than above the first, so its ink centre lands 1.1667 higher than the capture's. Measured in the
     * lab against `search-noresults-dark.png`, not invented.
     */
    blockNudge: 1.1667,
    subtitleFontSize: 15,
  },
} as const;

/**
 * The open and close transitions, as the frames measured them. Offsets are `t / duration`; the tables
 * are samples off `references/ios/motion/search-open.mov` and `search-close.mov`, not a fitted easing,
 * so they are played with `easing: "linear"` between points.
 */
export const iosSearchMotion = {
  open: {
    duration: 267,
    /** 1 − the list's measured alpha: what has to be painted over it to leave the same pixels. */
    surface: [
      { offset: 0, opacity: 0 }, { offset: 0.0626, opacity: 0.027 }, { offset: 0.1249, opacity: 0.045 },
      { offset: 0.1939, opacity: 0.096 }, { offset: 0.2561, opacity: 0.156 }, { offset: 0.3187, opacity: 0.227 },
      { offset: 0.375, opacity: 0.319 }, { offset: 0.4376, opacity: 0.414 }, { offset: 0.4998, opacity: 0.512 },
      { offset: 0.5624, opacity: 0.599 }, { offset: 0.6251, opacity: 0.688 }, { offset: 0.6862, opacity: 0.77 },
      { offset: 0.75, opacity: 0.845 }, { offset: 0.8126, opacity: 0.897 }, { offset: 0.8748, opacity: 0.947 },
      { offset: 0.9374, opacity: 0.966 }, { offset: 1, opacity: 1 },
    ],
    /**
     * The list's measured rise. Sampled to 73.33 pt at 172 ms; from there it is under 30% opacity and
     * cannot be followed, so the tail continues the `dy ∝ t^1.673` fit those samples give. Marked
     * unmeasured past offset 0.644.
     */
    list: [
      { offset: 0, translate: 0 }, { offset: 0.0626, translate: -2 }, { offset: 0.1249, translate: -5.17 },
      { offset: 0.1939, translate: -9.33 }, { offset: 0.2561, translate: -15.33 }, { offset: 0.3187, translate: -22.67 },
      { offset: 0.375, translate: -31.33 }, { offset: 0.4376, translate: -40.67 }, { offset: 0.4998, translate: -51.33 },
      { offset: 0.5624, translate: -61.33 }, { offset: 0.6251, translate: -71 }, { offset: 0.6437, translate: -73.33 },
      { offset: 0.6862, translate: -81.6 }, { offset: 0.75, translate: -94.6 }, { offset: 0.8126, translate: -108.2 },
      { offset: 0.8748, translate: -122.5 }, { offset: 0.9374, translate: -137.5 }, { offset: 1, translate: -153.2 },
    ],
  },
  close: {
    duration: 292,
    /**
     * The search surface is gone inside one recorded frame (3.3 ms of 292 = offset 0.0113); after that
     * the list is only finishing a fade from 0.858, so the surface's residue runs 0.142 -> 0.
     */
    surface: [
      { offset: 0, opacity: 1 }, { offset: 0.0113, opacity: 0.142 }, { offset: 0.1483, opacity: 0.138 },
      { offset: 0.2682, opacity: 0.129 }, { offset: 0.3880, opacity: 0.106 }, { offset: 0.4853, opacity: 0.086 },
      { offset: 0.5935, opacity: 0.057 }, { offset: 0.7133, opacity: 0.032 }, { offset: 0.8219, opacity: 0.018 },
      { offset: 0.9418, opacity: 0.015 }, { offset: 1, opacity: 0 },
    ],
    /** The list drops back 106.67 pt on an ease-in-out the samples describe directly. */
    list: [
      { offset: 0, translate: -106.67 }, { offset: 0.1483, translate: -103.33 }, { offset: 0.2682, translate: -94 },
      { offset: 0.3880, translate: -77.33 }, { offset: 0.4853, translate: -60.67 }, { offset: 0.5935, translate: -40.67 },
      { offset: 0.7133, translate: -22 }, { offset: 0.8219, translate: -9.33 }, { offset: 0.9418, translate: -1.33 },
      { offset: 1, translate: 0 },
    ],
  },
  /**
   * The trailing circle's glyph. Measured only as total ink inside the circle: the compose glyph is
   * gone by 75 ms (offset 0.281) and the ✕ is in by 137 ms (offset 0.513), after which the ink falls
   * back to its resting value by 267 ms - native plays an SF Symbol replace whose overshoot this
   * crossfade does not model.
   */
  glyph: { out: 0.281, in: 0.513 },
} as const;

/** ChatKit's own English section titles, out of `ChatKit.loctable`. */
export const iosSearchSectionTitles: Record<IosSearchSectionKind, string> = {
  // SEARCH_CONVERSATIONS_TITLE. The framework calls this section Conversations, not Contacts.
  conversations: "Conversations",
  messages: "Messages", // SEARCH_MESSAGES_TITLE
  photos: "Photos", // SEARCH_PHOTOS_TITLE
  links: "Links", // SEARCH_LINKS_TITLE
  documents: "Documents", // SEARCH_ATTACHMENTS_TITLE
};

/**
 * The section titles ChatKit ships that this kit does not draw, kept so a caller can see what is
 * missing rather than guess at the names: SEARCH_LOCATIONS_TITLE, SEARCH_PINS_TITLE,
 * SEARCH_WALLET_TITLE, SEARCH_COLLABORATION_TITLE, SEARCH_SCREENSHOTS_TITLE. Each has its own
 * inter-item spacing (all 10) and no other metrics.
 */
export const iosSearchUnmodelledSectionTitles = ["Locations", "Pins", "Wallet", "Collaboration", "Screenshots"] as const;

/** ChatKit strings: SEARCH, SEARCH_SHOW_MORE, SEARCH_RESULTS_INDEXING_TITLE. The subtitle is UIKit's. */
export const iosSearchStrings = {
  placeholder: "Search",
  seeAll: "See All",
  close: "Close",
  noResults: "No Results",
  noResultsDetail: "Check the spelling or try a new search.",
} as const;

/** ChatKit's See All destination titles (SEARCH_RESULTS_TITLE, CONVERSATION_SEARCH_RESULTS_TITLE, SEARCH_PHOTOS_ALL_TITLE). */
export const iosSearchDetailsTitle = (query: string, kind: IosSearchSectionKind): string =>
  kind === "conversations" ? `Conversations with “${query}”` : `“${query}” in ${iosSearchSectionTitles[kind]}`;

/** `-[CKUIBehavior searchMessageCellHeightForDisplayScale:]`, which branches on the device scale. */
export function iosSearchRowHeight(displayScale: number): number {
  if (displayScale >= 3) return 86.6667;
  if (displayScale >= 2) return 86.5;
  return 87;
}

export type IosSearchProps = Omit<ComponentProps<"div">, "onSelect" | "onChange"> & {
  /** The query. Uncontrolled when omitted. */
  query?: string;
  defaultQuery?: string;
  onQueryChange?: (query: string) => void;
  sections?: IosSearchSection[];
  onSelect?: (result: IosSearchResult, kind: IosSearchSectionKind) => void;
  onSeeAll?: (kind: IosSearchSectionKind) => void;
  /** The ✕ button, and Escape, leave search. */
  onCancel?: () => void;
  /** False plays the exit and then calls `onExited`. */
  open?: boolean;
  onExited?: () => void;
  /** Seek the transition to this fraction (0..1) instead of playing it, which is what the harness does. */
  progress?: number;
  /** Space above the results for the status bar. */
  topInset?: number;
  /**
   * The conversation list's scrolling layer. Given one, the measured rise and fall is applied to it,
   * which is the half of the transition a sibling component cannot do for itself.
   */
  listRef?: RefObject<HTMLElement | null>;
  /** Rows per section before "See All" appears. ChatKit's own default is 4. */
  maxResults?: number;
  /** The row pitch's display scale; 3 on the measured iPhone. */
  displayScale?: number;
  placeholder?: string;
  /** The ✕ button's accessible name. */
  closeLabel?: string;
  /** Shown before anything is typed. The capture is blank there, so the default is nothing. */
  emptyState?: ReactNode;
  noResultsTitle?: string;
  /** Second line under "No Results". */
  noResultsDetail?: string;
};

const font = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "Helvetica Neue", Helvetica, Arial, sans-serif';

/**
 * Light values are the conversation list's measured tokens; dark values are its measured dark set.
 * `--ios-search-field-fill` is the pill's own composited interior, measured #ffffff in
 * `search-active-light.png` and #191919 in `search-noresults-dark.png`; the clear button's cross is
 * knocked out of the disc in exactly that colour. The balloon fills defer to the kit's palette
 * (`tokens.ts`, applied by the shell as `--im-*`) so the blue stays one screen-space gradient rather
 * than a second copy of the same two endpoints.
 */
const vars =
  "[--ios-search-bg:#ffffff] [--ios-search-label:#000000] [--ios-search-secondary:#8a8a8e] [--ios-search-chevron:#c5c5c7] [--ios-search-separator:#e8e8e8] " +
  "[--ios-search-glass:rgba(255,255,255,0.9)] [--ios-search-rim:none] [--ios-search-shadow:0_6px_36px_4px_rgba(0,0,0,0.065)] [--ios-search-shadow-round:0_5px_20px_6px_rgba(0,0,0,0.055)] " +
  "[--ios-search-field:#8a8a8e] [--ios-search-field-fill:#ffffff] [--ios-search-glyph:#1a1919] " +
  "[--ios-search-tint:#0088ff] [--ios-search-incoming:#e9e9eb] [--ios-search-incoming-text:#000000] [--ios-search-tile:#e9e9eb] " +
  "dark:[--ios-search-bg:#000000] dark:[--ios-search-label:#ffffff] dark:[--ios-search-secondary:#8d8d93] dark:[--ios-search-chevron:#464649] dark:[--ios-search-separator:#2a2a2c] " +
  "dark:[--ios-search-glass:rgba(28,28,28,0.9)] dark:[--ios-search-rim:inset_0_0_0_1px_rgba(255,255,255,0.09)] dark:[--ios-search-shadow:none] dark:[--ios-search-shadow-round:none] " +
  "dark:[--ios-search-field:#97979d] dark:[--ios-search-field-fill:#191919] dark:[--ios-search-glyph:#f4f3f4] " +
  "dark:[--ios-search-tint:#0091ff] dark:[--ios-search-incoming:#262629] dark:[--ios-search-incoming-text:#ffffff] dark:[--ios-search-tile:#1c1c1e]";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * The measured tables again, read straight rather than played, so the very first committed frame is
 * already the frame the timeline would draw. Without this the server renders the surface at its base
 * opacity, the screen paints finished, and the animation snaps it back several frames later - which is
 * exactly the flash this screen used to open with.
 */
function sampleTrack<K extends string>(frames: ReadonlyArray<{ offset: number } & Record<K, number>>, key: K, at: number): number {
  const t = clamp01(at);
  for (let i = 1; i < frames.length; i++) {
    const previous = frames[i - 1];
    const next = frames[i];
    if (t > next.offset) continue;
    const span = next.offset - previous.offset;
    const fraction = span === 0 ? 1 : (t - previous.offset) / span;
    return previous[key] + (next[key] - previous[key]) * fraction;
  }
  return frames[frames.length - 1][key];
}

/** `useLayoutEffect` on the client so a posed frame is committed before the browser paints it. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function initialsOf(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0] ?? "").join("").toUpperCase();
}

/**
 * Where the query lands in a piece of text. Falls back to each word when the whole phrase misses, and
 * merges overlaps so the renderer never has to drop a range it cannot draw.
 */
export function matchRanges(text: string, query: string): Array<[number, number]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const find = (term: string) => {
    const found: Array<[number, number]> = [];
    for (let at = haystack.indexOf(term); at !== -1; at = haystack.indexOf(term, at + term.length)) found.push([at, at + term.length]);
    return found;
  };
  const whole = find(needle);
  const raw = whole.length > 0 ? whole : needle.split(/\s+/).filter(Boolean).flatMap(find);
  const sorted = raw.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * ChatKit's `ck_trimmedStringWithPreferredLength:anchoredAroundSubstring:`: a snippet longer than
 * `max` is cut down to a window centred on the match, with an ellipsis on whichever side was cut.
 * This is native's *pre*-trim at 200 characters; it is not what keeps the match on screen, because a
 * one-line balloon shows about thirty. `Snippet` does that part.
 */
export function trimAroundMatch(text: string, query: string, max = iosSearchMetrics.message.maxSummaryLength): string {
  if (text.length <= max) return text;
  const first = matchRanges(text, query)[0];
  const anchor = first ? first[0] : 0;
  const start = Math.max(0, Math.min(text.length - max, anchor - Math.floor((max - (first ? first[1] - first[0] : 0)) / 2)));
  const end = Math.min(text.length, start + max);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** Splits text into the run before the first match, the match, and the run after it. */
export function splitAroundMatch(text: string, query: string): { before: string; match: string; after: string } {
  const first = matchRanges(text, query)[0];
  if (!first) return { before: text, match: "", after: "" };
  return { before: text.slice(0, first[0]), match: text.slice(first[0], first[1]), after: text.slice(first[1]) };
}

/**
 * The annotated snippet inside a balloon. Same font throughout, only the colour changes, which is
 * what `-[CKMessageSearchResultCell _annotatedResultStringForResult:searchText:]` does.
 *
 * The balloon is one line and the framework's 200-character pre-trim leaves the match well past its
 * right edge, so the visible window has to be anchored on the match too. Three flex children do that
 * without measuring anything: the run before the match may shrink and truncates **at its start**
 * (`direction: rtl` with `unicode-bidi: plaintext`, so Latin text still reads left to right but the
 * ellipsis lands on the left), the match itself never shrinks, and the run after it truncates at its
 * end as usual.
 */
function Snippet({ text, query, match }: { text: string; query: string; match: string }) {
  const parts = splitAroundMatch(text, query);
  // `white-space: pre` on both runs, because each flex item starts its own line box and would
  // otherwise drop the space that sits against the match.
  const run: CSSProperties = { whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 1 };
  if (!parts.match) return <span style={run}>{text}</span>;
  return (
    <>
      {parts.before && (
        <span data-slot="before" style={{ ...run, direction: "rtl" }}>
          {/* The run reads left to right inside a right-to-left box, so the ellipsis lands at its
              start; the isolate keeps the bidi algorithm from moving the run's own edge punctuation. */}
          <bdi dir="ltr">{parts.before}</bdi>
        </span>
      )}
      <span data-slot="match" className="shrink-0 whitespace-pre" style={{ color: match }}>{parts.match}</span>
      {parts.after && <span data-slot="after" style={run}>{parts.after}</span>}
    </>
  );
}

/** The same recolouring for a wrapping label, where every match is annotated and nothing is anchored. */
function Highlight({ text, query, match }: { text: string; query: string; match: string }) {
  const ranges = matchRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], index) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<span key={`${start}-${index}`} data-slot="match" style={{ color: match }}>{text.slice(start, end)}</span>);
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** The measured list chevron, reused byte for byte. */
function Chevron({ style }: { style?: CSSProperties }) {
  return (
    <svg aria-hidden="true" data-slot="chevron" className="absolute" style={style} width="11" height="16" viewBox="-2 -2 11 16" fill="none" stroke="var(--ios-search-chevron)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 1 6 6 1 11" />
    </svg>
  );
}

/** The measured list separator, from x 83 to 386 at the row's bottom edge. Never under a section's last row. */
function RowSeparator() {
  const m = iosSearchMetrics.row;
  return <span aria-hidden="true" data-slot="separator" className="absolute" style={{ left: m.separatorLeft, right: m.separatorRight, bottom: 0, height: 1, transform: "translateY(-0.3333px)", background: "var(--ios-search-separator)" }} />;
}

/** The list's glass, byte for byte: one shadow layer under one fill layer, clipped toward its neighbour. */
function GlassLayers({ round = false, clip }: { round?: boolean; clip?: "left" | "right" }) {
  return (
    <>
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 rounded-[inherit]" style={{ boxShadow: round ? "var(--ios-search-shadow-round)" : "var(--ios-search-shadow)", clipPath: clip ? `inset(-60px ${clip === "right" ? "-6px" : "-60px"} -60px ${clip === "left" ? "-6px" : "-60px"})` : undefined }} />
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit]" style={{ background: "var(--ios-search-glass)", boxShadow: "var(--ios-search-rim)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }} />
    </>
  );
}

/**
 * The same trick `ios-conversation-list` uses: a `lineHeight: 1` box around a 17 px SF name is
 * shorter than the font's own ascent + descent, so `truncate`'s `overflow: hidden` shaves the
 * bottom off every descender. Grow the clip box with padding and take it back off `top` so the
 * text does not move - `overflow: hidden` clips at the padding box.
 */
const NAME_BLEED = 3;

function ConversationRow({ result, query, last, onSelect }: { result: IosSearchConversationResult; query: string; last: boolean; onSelect?: () => void }) {
  const m = iosSearchMetrics.row;
  return (
    <button type="button" onClick={onSelect} aria-label={`${result.name}, ${result.time}, ${result.preview}`}
      className="absolute inset-0 w-full text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500">
      <Avatar aria-hidden="true" size={m.avatar} src={result.photo} initials={result.initials ?? initialsOf(result.name)} className="absolute" style={{ left: m.avatarLeft, top: m.avatarTop }} />
      <span aria-hidden="true" data-slot="name" className="absolute truncate" style={{ left: m.textLeft, right: 96, top: m.nameTop - NAME_BLEED, paddingBlock: NAME_BLEED, transform: "translateY(0.3333px)", fontSize: m.nameSize, lineHeight: 1, fontWeight: m.nameWeight, letterSpacing: 0, color: "var(--ios-search-label)" }}>
        {result.name}
      </span>
      <span aria-hidden="true" data-slot="time" className="absolute whitespace-nowrap" style={{ right: m.timeRight, top: m.timeTop, transform: "translateY(0.3333px)", fontSize: m.timeSize, lineHeight: 1, letterSpacing: 0, color: "var(--ios-search-secondary)" }}>
        {result.time}
      </span>
      <Chevron style={{ left: m.chevronLeft, top: m.chevronTop, transform: "translateX(0.3333px)" }} />
      {/* Two lines, so a match can sit on either; the balloon's anchoring is not needed and native's
          conversation cell does not do it either. Whether native bolds a conversation match is
          untested: `CKConversationSearchResultEmbeddedCell` takes a separate `annotatedFont`, unlike
          the message cell, and no capture shows one. */}
      <span aria-hidden="true" data-slot="preview" className="absolute overflow-hidden" style={{ left: m.textLeft, right: 34, top: m.previewTop, transform: "translateY(-0.3333px)", fontSize: m.previewSize, lineHeight: `${m.previewLine}px`, letterSpacing: 0, color: "var(--ios-search-secondary)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" } as CSSProperties}>
        <Highlight text={result.preview} query={query} match="var(--ios-search-label)" />
      </span>
      {!last && <RowSeparator />}
    </button>
  );
}

function MessageRow({ result, query, last, height, onSelect }: { result: IosSearchMessageResult; query: string; last: boolean; height: number; onSelect?: () => void }) {
  const row = iosSearchMetrics.row;
  const m = iosSearchMetrics.message;
  const snippet = trimAroundMatch(result.text, query);
  // Every spacing here is a framework value; the balloon's own vertical padding is what the row has
  // left once they are taken out, so it is derived rather than invented.
  const balloonTop = m.topSpacing + m.labelLine + m.senderToBalloon;
  const balloonHeight = height - balloonTop - m.bottomSpacing;
  const label = [result.conversation, result.name].filter(Boolean).join(", ");
  return (
    <button type="button" onClick={onSelect} aria-label={`${label}, ${result.time}, ${snippet}`}
      className="absolute inset-0 w-full text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500">
      {/* Ø28 centred in the measured 26-71 avatar gutter so the text column still starts at x 83. */}
      <Avatar aria-hidden="true" size={m.avatar} initials={result.initials ?? initialsOf(result.name)} className="absolute" style={{ left: row.avatarLeft + (row.avatar - m.avatar) / 2, top: m.topSpacing }} />
      <span aria-hidden="true" data-slot="message-heading" className="absolute flex items-baseline overflow-hidden whitespace-nowrap" style={{ left: row.textLeft, right: row.timeRight + 40, top: m.topSpacing, height: m.labelLine, gap: m.conversationToSender, fontSize: m.labelFontSize, lineHeight: `${m.labelLine}px`, letterSpacing: 0 }}>
        {result.conversation && <span data-slot="conversation" className="shrink-0 truncate" style={{ fontWeight: m.conversationWeight, color: "var(--ios-search-label)" }}>{result.conversation}</span>}
        <span data-slot="sender" className="truncate" style={{ color: "var(--ios-search-secondary)" }}>{result.name}</span>
      </span>
      <span aria-hidden="true" data-slot="time" className="absolute whitespace-nowrap" style={{ right: row.timeRight, top: m.topSpacing, fontSize: m.labelFontSize, lineHeight: `${m.labelLine}px`, letterSpacing: 0, color: "var(--ios-search-secondary)" }}>
        {result.time}
      </span>
      {/*
        The track carries the geometry so the balloon inside it can hug its own text and still stop
        short: an absolutely positioned box cannot take `left`, `right` and a shrink-to-fit width at
        once. The chevron sits at the row's trailing edge and the framework's 12pt balloon-to-chevron
        gap becomes the track's right inset.
        `data-slot="message-bubble"` and the inner `data-slot="bubble"` are what `useBubbleScreenSpace`
        looks for, so an outgoing balloon takes the kit's one screen-space gradient instead of a second
        copy of it squeezed into 34pt.
      */}
      <span aria-hidden="true" data-slot="balloon-track" className="absolute flex items-center"
        style={{ left: row.textLeft, right: iosSearchMetrics.screen.width - row.chevronLeft + m.balloonToChevron, top: balloonTop, height: balloonHeight }}>
        <span data-slot="message-bubble" data-direction={result.fromMe ? "outgoing" : "incoming"} className="flex h-full min-w-0 items-center"
          style={{ maxWidth: `min(100%, ${iosSearchMetrics.screen.width - m.horizontalBalloonMargin}px)` }}>
          <span data-slot="bubble" className="flex h-full min-w-0 items-center overflow-hidden"
            style={{
              paddingLeft: m.balloonPaddingX,
              paddingRight: m.balloonPaddingX,
              borderRadius: Math.min(m.balloonRadius, balloonHeight / 2),
              backgroundColor: result.fromMe ? "var(--im-blue-bottom, #3682f7)" : "var(--ios-search-incoming)",
              backgroundImage: result.fromMe ? "linear-gradient(var(--im-blue-top, #77c7f5), var(--im-blue-bottom, #3682f7))" : undefined,
              backgroundSize: result.fromMe ? "100% var(--im-screen-h, 874px)" : undefined,
              backgroundRepeat: "no-repeat",
              backgroundPosition: result.fromMe ? "0 calc(100% + (var(--im-screen-h, 874px) - var(--bubble-bottom, calc(var(--im-screen-h, 874px) * 0.55))))" : undefined,
              fontSize: m.balloonFontSize,
              lineHeight: `${m.balloonLine}px`,
              letterSpacing: 0,
              color: result.fromMe ? m.fromMeUnannotated : "var(--ios-search-secondary)",
            }}>
            <Snippet text={snippet} query={query} match={result.fromMe ? "#ffffff" : "var(--ios-search-label)"} />
          </span>
        </span>
      </span>
      <Chevron style={{ left: row.chevronLeft, top: balloonTop + balloonHeight / 2 - 8, transform: "translateX(0.3333px)" }} />
      {!last && <RowSeparator />}
    </button>
  );
}

function PhotoTile({ result, onSelect }: { result: IosSearchPhotoResult; onSelect?: () => void }) {
  const m = iosSearchMetrics.photos;
  const size = iosSearchMetrics.cellWidth;
  return (
    <button type="button" onClick={onSelect} aria-label={`Photo from ${result.name}, ${result.time}`}
      className="relative block shrink-0 overflow-hidden focus-visible:outline-2 focus-visible:outline-blue-500"
      style={{ width: size, height: size, borderRadius: m.radius, background: "var(--ios-search-tile)" }}>
      {result.src && (
        // eslint-disable-next-line @next/next/no-img-element -- registry components stay framework-neutral
        <img src={result.src} alt="" className="size-full object-cover" draggable={false} />
      )}
    </button>
  );
}

/**
 * `CKLinkSearchResultCell` hosts an `LPLinkView`, whose small form is one image with a caption bar
 * over its foot. The card is `searchCellPreferredWidth` scaled by the framework's own fractional
 * scales: 192 x 136.
 */
function LinkCard({ result, query, onSelect }: { result: IosSearchLinkResult; query: string; onSelect?: () => void }) {
  const m = iosSearchMetrics.links;
  const width = iosSearchMetrics.cellWidth * m.widthScale;
  const height = iosSearchMetrics.cellWidth * m.heightScale;
  return (
    <button type="button" onClick={onSelect} aria-label={`${result.title}, ${result.domain}, ${result.time}`}
      className="relative block shrink-0 overflow-hidden text-left focus-visible:outline-2 focus-visible:outline-blue-500"
      style={{ width, height, borderRadius: m.radius, background: "var(--ios-search-tile)" }}>
      {result.src && (
        // eslint-disable-next-line @next/next/no-img-element -- registry components stay framework-neutral
        <img src={result.src} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
      )}
      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 flex flex-col justify-center" style={{ height: m.captionHeight, padding: `0 ${m.captionPadding}px`, background: "var(--ios-search-glass)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}>
        <span className="block truncate" style={{ fontSize: m.labelFontSize, lineHeight: `${m.labelLine}px`, fontWeight: 600, letterSpacing: 0, color: "var(--ios-search-label)" }}>
          <Highlight text={result.title} query={query} match="var(--ios-search-tint)" />
        </span>
        <span className="block truncate" style={{ fontSize: m.labelFontSize, lineHeight: `${m.labelLine}px`, letterSpacing: 0, color: "var(--ios-search-secondary)" }}>
          {result.domain}
        </span>
      </span>
    </button>
  );
}

function DocumentCard({ result, query, onSelect }: { result: IosSearchDocumentResult; query: string; onSelect?: () => void }) {
  const m = iosSearchMetrics.documents;
  const size = iosSearchMetrics.cellWidth;
  return (
    <button type="button" onClick={onSelect} aria-label={`${result.title}, ${result.time}`}
      className="relative block shrink-0 text-left focus-visible:outline-2 focus-visible:outline-blue-500" style={{ width: size }}>
      <span aria-hidden="true" className="block overflow-hidden" style={{ height: size, borderRadius: m.radius, background: "var(--ios-search-tile)" }}>
        {result.src && (
          // eslint-disable-next-line @next/next/no-img-element -- registry components stay framework-neutral
          <img src={result.src} alt="" className="size-full object-cover" draggable={false} />
        )}
      </span>
      <span aria-hidden="true" className="block truncate" style={{ marginTop: m.titleTop, fontSize: m.labelFontSize, lineHeight: `${m.labelLine}px`, fontWeight: 600, letterSpacing: 0, color: "var(--ios-search-label)" }}>
        <Highlight text={result.title} query={query} match="var(--ios-search-tint)" />
      </span>
      <span aria-hidden="true" className="block truncate" style={{ marginTop: m.dateTop, fontSize: m.labelFontSize, lineHeight: `${m.labelLine}px`, letterSpacing: 0, color: "var(--ios-search-secondary)" }}>
        {result.time}
      </span>
    </button>
  );
}

function SectionHeader({ id, title, kind, showSeeAll, onSeeAll }: { id: string; title: string; kind: IosSearchSectionKind; showSeeAll: boolean; onSeeAll?: (kind: IosSearchSectionKind) => void }) {
  const m = iosSearchMetrics.header;
  return (
    <div data-slot="section-header" className="sticky top-0 z-10 flex items-center justify-between gap-3" style={{ height: m.height, paddingLeft: m.margin, paddingRight: m.margin + iosSearchMetrics.details.seeAllTrailingMargin, background: "var(--ios-search-bg)" }}>
      <h2 id={id} className="m-0 min-w-0 truncate" style={{ fontSize: m.fontSize, lineHeight: `${m.lineHeight}px`, fontWeight: m.weight, letterSpacing: 0, color: "var(--ios-search-label)" }}>
        {title}
      </h2>
      {showSeeAll && onSeeAll && (
        <button type="button" data-slot="see-all" onClick={() => onSeeAll(kind)} aria-label={`${iosSearchStrings.seeAll} ${title}`}
          className="shrink-0 rounded focus-visible:outline-2 focus-visible:outline-blue-500"
          style={{ fontSize: m.buttonFontSize, lineHeight: `${m.buttonLineHeight}px`, letterSpacing: 0, color: "var(--ios-search-tint)" }}>
          {iosSearchStrings.seeAll}
        </button>
      )}
    </div>
  );
}

/**
 * The magnifier UIKit draws above "No Results", measured off `search-noresults-dark.png`: the ink box
 * is 45.3333 x 46.0; the ring's outer diameter is 37.3333 with a 4.0 stroke, so its centre line has
 * radius 16.6667 about (18.6667, 18.6667) inside that box; the handle is a 45° stroke 5.45 wide
 * (a horizontal cut through it measures 7.7) whose round cap ends the ink at the box's corner.
 */
function EmptyGlyph() {
  const m = iosSearchMetrics.empty;
  return (
    <svg aria-hidden="true" data-slot="empty-glyph" width={m.glyph} height={m.glyphHeight} viewBox={`0 0 ${m.glyph} ${m.glyphHeight}`} fill="none" stroke="var(--ios-search-secondary)" strokeLinecap="round">
      <circle cx="18.6667" cy="18.6667" r="16.6667" strokeWidth="4" />
      <path d="M30.46 30.45 43.4 44.07" strokeWidth="5.45" />
    </svg>
  );
}

export function IosSearch({
  query: queryProp,
  defaultQuery = "",
  onQueryChange,
  sections = [],
  onSelect,
  onSeeAll,
  onCancel,
  open = true,
  onExited,
  progress,
  topInset = 54,
  listRef,
  maxResults = iosSearchMetrics.maxResults,
  displayScale = 3,
  placeholder = iosSearchStrings.placeholder,
  closeLabel = iosSearchStrings.close,
  emptyState = null,
  noResultsTitle = iosSearchStrings.noResults,
  noResultsDetail = iosSearchStrings.noResultsDetail,
  className,
  style,
  ...props
}: IosSearchProps) {
  const m = iosSearchMetrics;
  const id = useId();
  const [internalQuery, setInternalQuery] = useState(defaultQuery);
  const query = queryProp ?? internalQuery;
  const setQuery = (next: string) => {
    if (queryProp === undefined) setInternalQuery(next);
    onQueryChange?.(next);
  };

  const root = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const composeGlyph = useRef<SVGSVGElement>(null);
  const closeGlyph = useRef<SVGSVGElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const exited = useRef(false);
  // Kept in a ref so a caller passing a fresh closure does not restart the timeline: an inline arrow
  // has a new identity on every render, and a dependency on it would tear a finished exit down and
  // start it again from the top.
  const exitedCallback = useRef(onExited);
  useEffect(() => {
    exitedCallback.current = onExited;
  });

  // An outgoing balloon is filled by the kit's one screen-space gradient, so it needs the same
  // `--bubble-bottom` bookkeeping every other bubble gets, against this screen's own frame.
  useBubbleScreenSpace(results, root);

  const rowHeight = iosSearchRowHeight(displayScale);
  const fieldTop = m.screen.height - m.field.bottomInset - m.field.height;
  const resultsTop = topInset + m.resultsTopPadding;

  // Which table is playing, and where it starts, both derived during render: the closing direction is
  // read off `open` (never off an effect, which would miss the exit's frames), and the surface carries
  // its own first frame inline so the server and the first client paint already draw it.
  const closing = !open;
  const phase = closing ? iosSearchMotion.close : iosSearchMotion.open;
  const posed = progress === undefined ? 0 : clamp01(progress);
  const surfaceOpacity = sampleTrack(phase.surface, "opacity", posed);
  // The same two glyph ramps the timeline plays, read at `posed`, so whichever glyph belongs to this
  // frame is already the one the first paint shows.
  const { out, in: back } = iosSearchMotion.glyph;
  const leavingOpacity = posed >= out ? 0 : 1 - posed / out;
  const arrivingOpacity = posed <= out ? 0 : posed >= back ? 1 : (posed - out) / (back - out);
  const composeOpacity = closing ? arrivingOpacity : leavingOpacity;
  const closeOpacity = closing ? leavingOpacity : arrivingOpacity;

  /** Escape leaves search, wherever focus happens to be. */
  useEffect(() => {
    if (!open || !onCancel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  /**
   * Opening for real takes the caret; a scrubbed frame must not, or the harness moves focus.
   *
   * A text field is the one surface here that keeps the focus on a control rather than parking it on
   * its container, and the one that needs no `focusVisible: false` either. Both engines match
   * `:focus-visible` on a text input however it was focused - by tap, by click or by Tab - so there
   * is nothing a modality heuristic could get right or wrong. What keeps the ring off the capture is
   * that the field draws none at all: `outline-none` below and no `focus-visible:outline` beside it,
   * because in a text field the caret *is* the focus indicator, and iOS draws nothing around this
   * one. The rows and the trailing circle do carry rings, and should: they are not text.
   */
  useEffect(() => {
    if (!open || progress !== undefined) return;
    input.current?.focus({ preventScroll: true });
  }, [open, progress]);

  /**
   * One timeline over the surface, the two glyphs in the trailing circle and — when the caller hands
   * it over — the conversation list's scrolling layer. Opening and closing run **different measured
   * keyframe tables**, because the recordings say they are different animations: the open is a 267 ms
   * symmetric fade with an accelerating rise, the close a 292 ms ease-in-out fall that begins with the
   * surface already gone. The direction is read off `open` during render rather than in an effect that
   * would skip the exit's frames.
   */
  useBeforePaint(() => {
    if (open) exited.current = false;
    const duration = phase.duration;
    const finish = () => {
      if (exited.current) return;
      exited.current = true;
      exitedCallback.current?.();
    };
    // The compose glyph leaves over the first 28.1% and the ✕ arrives between 28.1% and 51.3%, which
    // is where the recording's ink bottoms out and peaks. Closing plays the same handover the other
    // way round rather than time-reversing it, so both directions start with the glyph that is there.
    const leaves: Keyframe[] = [{ opacity: 1, offset: 0 }, { opacity: 0, offset: iosSearchMotion.glyph.out }, { opacity: 0, offset: 1 }];
    const arrives: Keyframe[] = [{ opacity: 0, offset: 0 }, { opacity: 0, offset: iosSearchMotion.glyph.out }, { opacity: 1, offset: iosSearchMotion.glyph.in }, { opacity: 1, offset: 1 }];
    const tracks: Array<[Element | null, Keyframe[]]> = [
      [surface.current, phase.surface.map(frame => ({ opacity: frame.opacity, offset: frame.offset }))],
      [listRef?.current ?? null, phase.list.map(frame => ({ transform: `translateY(${frame.translate}px)`, offset: frame.offset }))],
      [composeGlyph.current, closing ? arrives : leaves],
      [closeGlyph.current, closing ? leaves : arrives],
    ];
    const animations = tracks
      .filter((track): track is [Element, Keyframe[]] => track[0] !== null)
      .map(([node, frames]) => node.animate(frames, { duration, easing: "linear", fill: "both" }));
    const stop = () => { for (const animation of animations) animation.cancel(); };
    const seek = (to: number) => {
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = to;
      }
    };
    // Scrubbing is inspection, not a dismissal: a seeked frame poses the screen and reports nothing.
    if (progress !== undefined) {
      seek(clamp01(progress) * duration);
      return stop;
    }
    // `prefers-reduced-motion` gets the last frame rather than no animation at all, so the same one
    // timeline still owns every value and nothing is left at its authored default.
    if (reducedMotion()) {
      seek(duration);
      if (!closing) return stop;
      const frame = requestAnimationFrame(finish);
      return () => { cancelAnimationFrame(frame); stop(); };
    }
    if (!closing) return stop;
    const first = animations[0];
    first?.addEventListener("finish", finish);
    return () => { first?.removeEventListener("finish", finish); stop(); };
  }, [open, closing, phase, progress, listRef]);

  const typed = query.trim().length > 0;
  const shown = sections.map(section => ({ section, visible: section.results.slice(0, maxResults) })).filter(entry => entry.visible.length > 0);
  const total = sections.reduce((count, section) => count + section.results.length, 0);

  const rowSection = (section: IosSearchSection, visible: IosSearchResult[], headingId: string) => {
    const insets = section.kind === "conversations" ? m.conversationSection : { top: 0, bottom: 0 };
    return (
      <ul role="list" aria-labelledby={headingId} className="relative m-0 list-none p-0"
        style={{ height: visible.length * rowHeight + insets.top + insets.bottom, paddingTop: insets.top }}>
        {visible.map((result, index) => (
          <li key={result.id} role="listitem" className="absolute left-0 right-0" style={{ top: insets.top, height: rowHeight, transform: `translateY(${index * rowHeight}px)` }}>
            {section.kind === "conversations"
              ? <ConversationRow result={result as IosSearchConversationResult} query={query} last={index === visible.length - 1} onSelect={() => onSelect?.(result, section.kind)} />
              : <MessageRow result={result as IosSearchMessageResult} query={query} height={rowHeight} last={index === visible.length - 1} onSelect={() => onSelect?.(result, section.kind)} />}
          </li>
        ))}
      </ul>
    );
  };

  const strip = (gap: number, children: ReactNode, headingId: string) => (
    <ul role="list" aria-labelledby={headingId} className="m-0 flex list-none overflow-x-auto p-0"
      style={{ gap, paddingLeft: m.header.margin, paddingRight: m.header.margin }}>
      {children}
    </ul>
  );

  return (
    <div ref={root} data-slot="ios-search" data-state={open ? "open" : "closed"} className={cn("absolute inset-0 isolate select-none overflow-hidden", vars, className)}
      style={{ fontFamily: font, ...style }} {...props}>
      {/*
        The page under the search, painted at 1 − the list's measured alpha. Native puts this surface
        *behind* the list and fades the list out on top of it; over the same background colour the two
        composites are the same pixels, and this way the list stays a sibling the shell owns.
      */}
      <div ref={surface} data-slot="surface" className="absolute inset-0" style={{ background: "var(--ios-search-bg)", opacity: surfaceOpacity }}>
        <div ref={results} data-slot="results" className="absolute overflow-y-auto"
          style={{ left: 0, right: 0, top: resultsTop, bottom: 0, paddingBottom: m.screen.height - fieldTop + m.resultsTopPadding }}>
          {!typed && emptyState}
          {typed && total === 0 && (
            // Centred in the results area, which the measured ink centre (431.0) matches to a point
            // against the area's own centre (430.0) between `resultsTop` and the bar.
            <div data-slot="no-results" role="status" className="flex flex-col items-center px-8 text-center"
              style={{ height: fieldTop - resultsTop, justifyContent: "center", transform: `translateY(${m.empty.blockNudge}px)` }}>
              <EmptyGlyph />
              <p className="m-0" style={{ marginTop: m.empty.glyphToTitle, fontSize: m.empty.titleFontSize, lineHeight: 1, fontWeight: m.empty.titleWeight, letterSpacing: 0, color: "var(--ios-search-label)" }}>{noResultsTitle}</p>
              {noResultsDetail && <p className="m-0" style={{ marginTop: m.empty.titleToSubtitle, fontSize: m.empty.subtitleFontSize, lineHeight: 1.2, letterSpacing: 0, color: "var(--ios-search-secondary)" }}>{noResultsDetail}</p>}
            </div>
          )}
          {typed && shown.map(({ section, visible }) => {
            const title = section.title ?? iosSearchSectionTitles[section.kind];
            const headingId = `${id}-${section.kind}`;
            const seeAll = section.results.length > visible.length;
            return (
              <section key={section.kind} data-slot="section" data-kind={section.kind} aria-labelledby={headingId} className="relative" style={{ paddingBottom: m.sectionGap }}>
                <SectionHeader id={headingId} title={title} kind={section.kind} showSeeAll={seeAll} onSeeAll={onSeeAll} />
                {/* `searchResultsTitleHeaderBottomPadding` is the gap under the title header, which is
                    where its name puts it; it used to be applied under the strip instead. */}
                <div style={{ paddingTop: m.header.bottomPadding }}>
                  {(section.kind === "conversations" || section.kind === "messages") && rowSection(section, visible, headingId)}
                  {section.kind === "photos" && strip(m.photos.gap, visible.map(result => (
                    <li key={result.id} role="listitem" className="shrink-0">
                      <PhotoTile result={result as IosSearchPhotoResult} onSelect={() => onSelect?.(result, section.kind)} />
                    </li>
                  )), headingId)}
                  {section.kind === "links" && strip(m.links.gap, visible.map(result => (
                    <li key={result.id} role="listitem" className="shrink-0">
                      <LinkCard result={result as IosSearchLinkResult} query={query} onSelect={() => onSelect?.(result, section.kind)} />
                    </li>
                  )), headingId)}
                  {section.kind === "documents" && strip(m.documents.gap, visible.map(result => (
                    <li key={result.id} role="listitem" className="shrink-0">
                      <DocumentCard result={result as IosSearchDocumentResult} query={query} onSelect={() => onSelect?.(result, section.kind)} />
                    </li>
                  )), headingId)}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {/* The bar never moves, never resizes and is the list's own bar: same 28 insets, same 48 height,
          same 12pt gap, same glass. Only the trailing circle's glyph and the pill's own right-hand
          control change. */}
      <div data-slot="field-row" role="search" className="absolute z-20 flex items-end"
        style={{ left: m.field.inset, right: m.field.inset, bottom: m.field.bottomInset, height: m.field.height }}>
        <div data-slot="field" className="relative h-full min-w-0 flex-1 rounded-full">
          <GlassLayers clip="right" />
          <svg aria-hidden="true" className="absolute" style={{ left: m.field.glyphLeft, top: m.field.glyphTop }} width="18.3333" height="18.6667" viewBox="-1 -1 18.3333 18.6667" fill="none" stroke="var(--ios-search-field)" strokeLinecap="round">
            <circle cx="6.745" cy="7.219" r="5.883" strokeWidth="1.725" />
            <path d="M11.4 12.01 15.17 15.78" strokeWidth="2.467" />
          </svg>
          {!typed && (
            <span aria-hidden="true" data-slot="placeholder" className="absolute" style={{ left: m.field.textLeft, top: m.field.textTop, transform: "translateY(0.3333px)", fontSize: 17, lineHeight: 1, fontWeight: 500, letterSpacing: 0, color: "var(--ios-search-field)" }}>
              {placeholder}
            </span>
          )}
          {/* The caret measures 2.0 x 22.0; Chrome draws a 1px caret and its width cannot be set, so the
              input carries the measured 22pt line box and the colour, and the extra point of width is a
              known miss. */}
          <input
            ref={input}
            type="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            aria-label={placeholder}
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="absolute border-0 bg-transparent p-0 outline-none select-text [&::-webkit-search-cancel-button]:appearance-none"
            style={{
              left: m.field.textLeft,
              right: m.field.clearRight + m.field.clearSize + 8,
              top: m.field.caretTop,
              height: m.field.caretHeight,
              fontFamily: font,
              fontSize: 17,
              lineHeight: `${m.field.caretHeight}px`,
              // Measured: the typed "Detail" and the "Search" placeholder have the same 5-device-pixel
              // stems at 3x, so typed text is the placeholder's weight, in the label colour.
              fontWeight: 500,
              letterSpacing: 0,
              color: "var(--ios-search-label)",
              caretColor: "var(--ios-search-tint)",
            }}
          />
          {typed && (
            <button type="button" data-slot="clear" aria-label="Clear search" onClick={() => { setQuery(""); input.current?.focus(); }}
              className="absolute flex items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-blue-500"
              style={{ right: m.field.clearRight, top: m.field.clearTop, width: m.field.clearSize, height: m.field.clearSize, background: "var(--ios-search-field)" }}>
              <svg aria-hidden="true" width={m.field.clearSize} height={m.field.clearSize} viewBox="0 0 17 17" fill="none" stroke="var(--ios-search-field-fill)" strokeWidth={m.field.clearCross} strokeLinecap="round">
                <path d="M5.5 5.5 11.5 11.5M11.5 5.5 5.5 11.5" />
              </svg>
            </button>
          )}
          {!typed && (
            <span aria-hidden="true" data-slot="mic" className="absolute" style={{ right: m.field.micRight, top: m.field.micTop, color: "var(--ios-search-field)", display: "flex" }}>
              <IosMicIcon width={m.field.micWidth} height={m.field.micHeight} />
            </span>
          )}
        </div>
        {/* The compose circle in its close state. Both glyphs are drawn so the timeline can crossfade
            them in place, which is what the recording shows the circle doing. */}
        <button type="button" data-slot="close" aria-label={closeLabel} onClick={onCancel}
          className="relative shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-blue-500"
          style={{ marginLeft: m.field.gap, width: m.field.button, height: m.field.button }}>
          <GlassLayers round clip="left" />
          <svg ref={composeGlyph} aria-hidden="true" data-slot="compose-glyph" className="absolute" style={{ left: 14, top: 13, opacity: composeOpacity }} width="21.3333" height="24" viewBox="0 -2.3333 21.3333 24" fill="none" stroke="var(--ios-search-glyph)" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 0.9167H4.1167A3.2 3.2 0 0 0 0.9167 4.1167V14.8833A3.2 3.2 0 0 0 4.1167 18.0833H14.8833A3.2 3.2 0 0 0 18.0833 14.8833V4" strokeWidth="1.8333" />
            <path d="M8.427 10.623 17.45 1.6" strokeWidth="2.1" />
            <circle cx="20" cy="-1" r="0.6" strokeWidth="1.4" />
          </svg>
          <svg ref={closeGlyph} aria-hidden="true" data-slot="close-glyph" className="absolute" style={{ left: m.field.closeGlyphLeft, top: m.field.closeGlyphTop, opacity: closeOpacity }} width={m.field.closeGlyph} height={m.field.closeGlyph} viewBox="0 0 17 17" fill="none" stroke="var(--ios-search-glyph)" strokeWidth={m.field.closeStroke} strokeLinecap="round">
            <path d="M1 1 16 16M16 1 1 16" />
          </svg>
        </button>
      </div>
    </div>
  );
}
