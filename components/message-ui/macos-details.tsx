"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/message-ui/avatar";

/**
 * macOS 26 conversation details: the inspector column on the trailing edge of the Messages window.
 *
 * ### The source
 *
 * **This file is now fitted to a capture.** `references/macos/details-pane.md` records every number
 * below and describes the source: a private screenshot of the user's own macOS 26 Messages, 960 × 640
 * pt, `Conversation ▸ Show Details` open on a group. The capture is **not in this repo and must not
 * be** — it is a real conversation with real people in it. Nothing from it beyond geometry and flat
 * colour has been copied anywhere.
 *
 * Two things about that capture bound every number here, and both are recorded in the reference:
 *
 * 1. **It survives only as a 1x, 960 × 640 downscale of the 2x original.** So 1 px = 1 pt and no
 *    reading is finer than about ±0.5 pt. Sizes below are the fitted integers; the raw pixel spans
 *    are in the reference.
 * 2. **It is dark only, and its pane is a translucent material** that samples the desktop behind the
 *    window: the fill drifts from #1c1f23 at the divider to #1b1b1b at the window edge, following the
 *    wallpaper. `--mdt-panel` is the median of that drift, and it is a flat stand-in for a material
 *    this kit cannot reproduce. **Every light value in `vars` is derived, not captured** — there is
 *    no light capture of this pane anywhere — and each one says where it came from.
 *
 * ### What the capture overturned
 *
 * The previous version of this file had no capture and built the pane out of `CKUIBehaviorMac`
 * selectors plus SPEC's measurement of the *sidebar*. Four of its structural choices are wrong:
 *
 * | It drew | The capture shows |
 * |---|---|
 * | a floating panel inset 8 with a 22 pt continuous corner and a drop shadow | a **flush column**, x 660–959, square, no shadow, with a **1 pt divider** on its leading edge at x 660 |
 * | the transcript squeezed and the sidebar left alone | the **sidebar collapsed** — the transcript runs from x 0 — and the transcript keeps its full width beside the column |
 * | Ø 37 contact photo, Ø 72 group pancake, name 13 bold | **one Ø 60 circle**, centred, name **23 bold** under it |
 * | Ø 32 quick actions 12 apart, one `info.circle` in the top-right | **Ø 36 discs 16 apart**, and a top-left Ø 36 close button with an **"Edit"** capsule opposite |
 *
 * The tab strip is real and reads **Info · Backgrounds · Photos · Links · Location**, it scrolls, and
 * it bleeds to the pane's trailing edge. The Info tab's body is a **Find My map card**, then a card of
 * location actions in destructive red and accent yellow, then a **row of Ø 70 participant faces** with
 * an Add button.
 *
 * ### What is still framework, not capture
 *
 * The capture shows one tab of one conversation, unscrolled. Everything under the participant row —
 * the contact handles, the photo/link/document previews, the Hide Alerts / Send Read Receipts / Shared
 * With You checkboxes, Leave / Block / Delete — is below the fold in it, so its **order and metrics are
 * unchanged from the framework reading** and are collected in `macDetailsUnmeasured` and the tables
 * below. Those readings came from a `clang -target arm64-apple-ios26.0-macabi` probe that dlopens
 * ChatKit and `CommunicationDetails`, swizzles `-[UIDevice userInterfaceIdiom]` to 5 so
 * `+[CKUIBehavior sharedBehaviors]` vends `CKUIBehaviorMac`, and reads:
 *
 * | Value | Selector |
 * |---|---|
 * | column 300 wide, resizable 280–400 | `defaultInspectorColumnWidth`, `min…`, `max…` — **300 is now also measured** |
 * | content inset 16 | `searchDetailsLeadingAndTrailingMaxPadding` — **also measured** |
 * | map 196 tall | `detailsViewMapHeight` — **also measured (197 ± 1)** |
 * | photo grid gap 10, tile radius 8 | `searchPhotosInterItemSpacingDetailsView`, `searchPhotosCellZKWAndDetailsCornerRadius` |
 * | link / document row radius 8, row height 40, option row 44 | `searchLinksCellCornerRadius`, `detailsContactCellMinimumHeight`, `+[CKDetailsChatOptionsCell estimatedHeight]` |
 * | 16 × 16 checkboxes | `CKDetailsChatOptionsCheckboxCell`; a Mac-idiom `UISwitch` reports style 1, 16 × 16 |
 * | section heading 13 Regular | `searchDetailsHeaderFont` |
 *
 * Three of those — 300, 16 and 196 — the capture independently reproduces, which is the cross-check
 * that the probe was reading genuine Mac values.
 *
 * ### Glyphs
 *
 * `detailsViewPhoneImage` / `detailsViewFaceTimeVideoImage` / `detailsViewMessagesImage` are
 * `phone.fill`, `video.fill` and `message.fill`, and a point-size sweep pins all three to 17 pt
 * (17 pt is the only size where their ink boxes are simultaneously {15.5, 15.5}, {20.5, 13.5} and
 * {19.5, 16}). Each path below is traced off a 16x render on the alpha-0.5 isoline, and each `viewBox`
 * *is* the ink box. The capture measures the painted ink at **14 × 14 (phone)** and **17 × 12 (video,
 * envelope)** inside the Ø 36 disc, i.e. the framework's 17 pt art scaled to ≈ 0.83, so
 * `macDetailsMetrics.actionGlyph` scales them rather than redrawing them.
 *
 * ### The presentation is still UNMEASURED
 *
 * Nothing records this pane in motion and no `*duration*` selector on `CKUIBehaviorMac` is inspector-
 * or details-named. `macDetailsMotion` is a choice, not a reading.
 *
 * Copy is `ChatKit.loctable` / `CommunicationDetails.loctable` verbatim: "Info" (`CONTACT_INFO_SHORT`),
 * "Photos", "Links", "Documents" (`SEARCH_ATTACHMENTS_TITLE`), "Hide Alerts", "Send Read Receipts",
 * "Shared With You", "Create New Contact", "Add to Existing Contact", "Block Contact", "Delete
 * Conversation…", "Leave this Conversation", "Call" / "FaceTime" / "Mail" / "Message". "Backgrounds",
 * "Location", "Edit" and "Add" are read off the capture.
 */

const font = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "Helvetica Neue", Helvetica, Arial, sans-serif';

/**
 * Everything the capture settles. Pixel spans are window coordinates in the 960 × 640 capture, where
 * 1 px = 1 pt; see `references/macos/details-pane.md` for the raw scans.
 */
export const macDetailsMetrics = {
  /** Measured: the column runs x 660–959 in a 960 pt window. `defaultInspectorColumnWidth` agrees. */
  width: 300,
  minWidth: 280,
  maxWidth: 400,
  /**
   * Measured **0**. The pane is flush to the window's trailing edge and to its top and bottom; the
   * previous 8 pt float and its 2 pt gap were the *sidebar's* shape borrowed onto this surface. The
   * two fields stay so a consumer's `window − inset − width` arithmetic keeps working; they are now
   * both zero because the capture says so.
   */
  inset: 0,
  gapToPane: 0,
  /** Measured: a 1 pt hairline on the column's leading edge, x 660, running the full 640. */
  divider: 1,
  /** Measured: opening the pane collapses the conversation list rather than squeezing the transcript.
   *  In the capture the transcript starts at x 0 and the traffic lights sit over it. */
  collapsesSidebar: true,
  /** Measured: cards run x 676–943, i.e. 268 = 300 − 2 × 16. `searchDetailsLeadingAndTrailingMaxPadding` agrees. */
  contentInset: 16,
  /** Measured: the close button starts 8 in from the divider and "Edit" ends 8 in from the window edge. */
  headerInset: 8,
  /** Measured: close ring x 669–704 × y 8–43, "Edit" capsule x 913–951 × y 8–43. */
  headerButton: 36,
  headerButtonTop: 8,
  headerEditWidth: 39,
  /** Measured: one circle, x 780–839 × y 26–85, centred in the column. No group pancake. */
  avatar: 60,
  avatarTop: 26,
  /** Measured: the three discs occupy x 740–879 × y 124–159 — Ø 36 on a 52 pitch, so 16 between. */
  action: 36,
  actionGap: 16,
  /** Measured: painted ink 14 × 14 (phone) against the framework's 17 pt ink box of 15.5, so 0.9;
   *  video and envelope measure 17 × 12 against 20.5 × 13.5, so 0.83. One scale for all three. */
  actionGlyph: 0.85,
  /** Measured: the selected capsule is x 676–714 × y 176–201 — 26 tall, a capsule, 9 each side of
   *  the label's advance, 2 between capsules. The strip scrolls and is clipped by the window edge. */
  tabHeight: 26,
  tabPaddingInline: 9,
  tabGap: 2,
  /** Measured: tab strip bottom 201 → map card top 217; map bottom 413 → action card top 429 (15);
   *  action card bottom 521 → participant faces top 538 (16). One 16 everywhere, ±1. */
  sectionGap: 16,
  /** Measured: the tab strip's box ends at 202 and the map card starts at 217. */
  bodyTop: 15,
  /** Measured: the label baseline sits 17.5 above the window's bottom edge. */
  bodyBottom: 17,
  /** Measured: the map card is 268 × 197. `detailsViewMapHeight` says 196. */
  mapHeight: 196,
  /** Measured: both cards' corners reach full width 10–11 rows in, which fits a 14–16 pt corner on
   *  the anti-aliased edge; 16 is the value that also matches the card's own 16 pt content inset. */
  cardRadius: 16,
  /** Measured: the two-row action card is 93 tall with its separator at its midpoint, so 46.5 a row. */
  cardRowHeight: 46,
  /** Measured: the separator inside the card runs x 692–927, i.e. 16 in from each card edge. */
  separatorInset: 16,
  /** Measured: faces are Ø 70 on a 95.5 pitch, first centre 54 from the column's leading edge — three
   *  76 pt cells with 20 between them exactly fill the 268 content column. */
  personSize: 70,
  personCell: 76,
  personGap: 20,
  /** Measured: face bottom 607 → label cap top 614. */
  personLabelGap: 7,
  /** Measured: the "Open in Find My" capsule is ≈ 112 × 24 at (694, 235), i.e. 18 in from the card's
   *  top-left corner. The title block under it sits at the pane's own 16 pt content inset instead
   *  (ink starts at 693, the card's leading edge being 676). Pins on the map are Ø 40 ± 1. */
  mapButtonHeight: 24,
  mapInset: 18,
  mapPin: 40,
  font: {
    /**
     * **Fitted to ink advances, not to cap heights.** Every size below is the one whose rendered
     * advance in this kit's font stack reproduces the capture's measured ink width for that exact
     * string. The capture's cap heights read 8–12% larger than those sizes imply, because it is a
     * LANCZOS downscale of a 2x original and the blur widens every ink extent by roughly half a pixel
     * at each end; an advance measured over 11–24 glyphs carries that same half pixel once, so it is
     * the far tighter estimator — and it is the one a pixel diff sees. `references/macos/details-pane.md`
     * lists the ink width, the target advance and the fitted advance for every string.
     */
    name: 22,
    nameWeight: 700,
    /** "Backgrounds" ink 67 → 11/400 (advance 68.45); the selected "Info" ink 20 → 11/600 (21.13).
     *  With 9 pt of padding and 2 pt between capsules this reproduces the strip's four measured ink
     *  runs — 686, 727, 815, 872 — to within 1 pt. */
    tab: 11,
    tabWeight: 400,
    tabSelectedWeight: 600,
    /** "Stop Sharing My Location" ink 153 → 13/400 (155.27); "Send My Current Location" 156 → 157.70. */
    row: 13,
    rowWeight: 400,
    /** The first name under a face: ink 17 ("Ben") and 18 ("Add") → 10/600 (19.20 / 19.98). */
    person: 10,
    personWeight: 600,
    /** On the map card: title ink 48 → 11/500 (49.55), subtitle ink 45 → 11/400 (45.64). */
    mapTitle: 11,
    mapTitleWeight: 500,
    /** "Open in Find My" ink 87 → 11.5/500 (89.84). */
    mapButton: 11.5,
    /** "Edit" ink 21 → 12.5/400 (22.61). */
    edit: 12.5,
    /** `searchDetailsHeaderFont`, .SFNS-Regular 13, for the below-the-fold sections. */
    heading: 13,
    headingWeight: 400,
    /** The below-the-fold list rows, unchanged from the framework reading. */
    body: 13,
    subtitle: 11.5,
  },
} as const;

/**
 * Every number this file draws that the capture does not reach. The capture shows the Info tab
 * unscrolled, so everything under the participant row is here, together with the tab strip's own
 * type weight and the two colour tokens that can only live in CSS variables (`--mdt-hover`, 6% black /
 * 8% white, and `--mdt-scrim`, overlay mode only).
 */
export const macDetailsUnmeasured = {
  /** Space under a section heading before its content, and a heading's own space above. */
  headingAbove: 16,
  headingToContent: 8,
  headingLeading: -2,
  /** Horizontal padding inside a hoverable row, so its hover fill clears the text. */
  rowPadding: 6,
  /** `searchDetailsSectionMarginInsets` t10 b10, for the below-the-fold sections. */
  sectionMargin: 10,
  /** `detailsContactCellMinimumHeight` 40 and `+[CKDetailsChatOptionsCell estimatedHeight]` 44. */
  rowHeight: 40,
  optionHeight: 44,
  /** `detailsCellLabelPadding`: a details cell's glyph-to-label gap. */
  rowGap: 12,
  /** `searchPhotosInterItemSpacingDetailsView` / `…CornerRadius`, `searchLinksCellCornerRadius`. */
  photoGap: 10,
  photoRadius: 8,
  listRadius: 8,
  /** `-[UISwitch intrinsicContentSize]` under the Mac idiom, where `style` resolves to checkbox. */
  checkbox: 16,
  checkboxRadius: 3.5,
  /**
   * What a control does under the mouse. The capture is one resting frame, so neither the hover nor
   * the press is in it, and the framework has nothing to say either: `-[CKUIThemeMac
   * detailsSelectedCellColor]` read at idiom 5 is **#ffc726 / #ffc600**, a find-highlight yellow —
   * NOT the phone's #dcdcdc / #464646 row fill, which is what the same selector returns at idiom 0.
   * Assuming the two idioms agree is exactly the mistake that has already cost one wrong commit here.
   *
   * So both steps are choices, and they are one rule rather than nine numbers: a fill deepens from
   * `--mdt-hover` to `--mdt-press` (6%/8% → 12%/16%, the same colour at twice the alpha), and a
   * control that dims instead loses 0.15 more of its opacity than hovering already took — which is
   * the ladder the file's photo tiles already shipped (1 → 0.90 → 0.75).
   */
  pressDim: 0.15,
  /** Columns in the photo grid; nothing says how many the 300 column runs. */
  photoColumns: 3,
  previewPhotoRows: 2,
  previewRows: 3,
  /** The below-the-fold avatar in a participant *list* row (`detailsAvatarDiameter`). The capture's
   *  Ø 70 faces are the horizontal row, which is a different control. */
  listAvatar: 37,
  /** The top-edge blur band (`PlatformTopEdgeBlurView`) that appears once the body scrolls. */
  scrollEdgeBlur: 12,
} as const;

/**
 * UNMEASURED. No capture records this pane in motion and a scan of all 28 `*duration*` selectors on
 * `CKUIBehaviorMac` turns up nothing details- or inspector-named. The slide runs 300 ms on the curve
 * `ios-details.tsx` uses; the way out is 250; nothing staggers, because an AppKit inspector column
 * slides as one piece.
 */
export const macDetailsMotion = {
  enter: 300,
  exit: 250,
  dim: 220,
  ease: "cubic-bezier(0.32, 0.72, 0, 1)",
  exitEase: "cubic-bezier(0.4, 0, 1, 1)",
} as const;

/**
 * **Dark is measured; light is derived.** Every dark value below is a median or a peak read off the
 * capture after converting it out of the display's ICC profile into sRGB — that conversion is what
 * turns the raw #ffd044 of the accent row into #ffd600, which is `systemYellow` (dark) exactly, and it
 * is the check that the conversion is right.
 *
 * | Token | Dark, measured | Light, derived from |
 * |---|---|---|
 * | `--mdt-panel` | **#1b1c1d**, the median of a material that drifts #1c1f23 → #1b1b1b across the column | SPEC's measured light sidebar panel |
 * | `--mdt-ground` | **#1e1e1e**, the transcript beside it | `_transcriptBackgroundColor` light |
 * | `--mdt-divider` | **#34383c** — the hairline reads #353b41 over a material reading #1c1e21, so +25/+28/+31 on the flat panel | SPEC's measured light row separator |
 * | `--mdt-fill` | **#37383c**, shared by the action discs, both cards and the Add circle | the same delta inverted |
 * | `--mdt-tab-fill` | **#3e3f42**, the selected tab capsule | a raised white capsule, as macOS segmented controls are |
 * | `--mdt-glass` / `--mdt-glass-rim` | **#191c1d** inside a 1 pt **#2e3033** rim — the header buttons are *darker* than the pane | inverted |
 * | `--mdt-separator` | **#4e5055**, inside the action card | SPEC's light row separator |
 * | `--mdt-red` | **#ff5b65**. Note this is **not** `systemRed` dark (#ff453a); the capture is measurably lighter and the same method recovers `systemYellow` exactly, so the reading stands | `systemRed` light |
 * | `--mdt-yellow` | **#ffd600** = `systemYellow` dark | `systemYellow` light |
 * | `--mdt-label` | white; a 23 px stem reads 227/255, which is `labelColor` dark (white at 85%) over this ground | `labelColor` light |
 * | `--mdt-secondary` | white at 68%: the unselected tab peaks at #a8a9aa on a 1x downscale, which under-reads a thin stroke, so this is a floor, not an equality | `CKUIThemeMac` |
 * | `--mdt-tertiary` | **#747577**, the disabled Mail glyph | `CKUIThemeMac` |
 *
 * `--mdt-tint`, `--mdt-hover`, `--mdt-scrim` and `--mdt-tile` are unmeasured on this surface:
 * `--mdt-tint` and `--mdt-tile` are `CKUIThemeMac`'s and SPEC's incoming-bubble fill respectively, and
 * the other two are choices.
 */
const vars =
  "[--mdt-panel:#fafafa] [--mdt-ground:#ffffff] [--mdt-divider:#e1e1e1] [--mdt-fill:#ececec] " +
  "[--mdt-tab-fill:#ffffff] [--mdt-glass:rgba(0,0,0,0.035)] [--mdt-glass-rim:rgba(0,0,0,0.13)] " +
  "[--mdt-separator:#e1e1e1] [--mdt-red:#ff3b30] [--mdt-yellow:#e5a900] " +
  "[--mdt-label:rgba(0,0,0,0.8471)] [--mdt-secondary:rgba(0,0,0,0.5490)] [--mdt-tertiary:rgba(0,0,0,0.2588)] " +
  "[--mdt-tint:#0088ff] [--mdt-hover:rgba(0,0,0,0.06)] [--mdt-press:rgba(0,0,0,0.12)] [--mdt-tile:#e9e9eb] [--mdt-scrim:rgba(0,0,0,0.10)] [--mdt-knob:#ffffff] " +
  "dark:[--mdt-panel:#1b1c1d] dark:[--mdt-ground:#1e1e1e] dark:[--mdt-divider:#34383c] dark:[--mdt-fill:#37383c] " +
  "dark:[--mdt-tab-fill:#3e3f42] dark:[--mdt-glass:#191c1d] dark:[--mdt-glass-rim:#2e3033] " +
  "dark:[--mdt-separator:#4e5055] dark:[--mdt-red:#ff5b65] dark:[--mdt-yellow:#ffd600] " +
  "dark:[--mdt-label:rgba(255,255,255,0.9)] dark:[--mdt-secondary:rgba(255,255,255,0.68)] dark:[--mdt-tertiary:#747577] " +
  "dark:[--mdt-tint:#0091ff] dark:[--mdt-hover:rgba(255,255,255,0.08)] dark:[--mdt-press:rgba(255,255,255,0.16)] dark:[--mdt-tile:#3b3b3d] dark:[--mdt-scrim:rgba(0,0,0,0.28)]";

/** The focus ring the rest of the macOS chrome uses (`macos-header.tsx`, `macos-composer.tsx`). */
const focusRing = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-[#3478f6]";

/**
 * Hover and press, driven by pointer events rather than by `:hover` / `:active`.
 *
 * Both halves are here for a reason the capture cannot show and a screenshot test would not catch.
 *
 * **Press** cannot be `:active`: it does not latch under a synthetic touch at all, it stays on when
 * the button lifts outside the control, and it cannot be given up when the pointer drags away, which
 * is what a real press has to do.
 *
 * **Hover** cannot stay a `hover:` class on any control whose resting fill is an inline `style`,
 * which on this pane is the close ring, the "Edit" capsule, the tab capsules and the checkbox. An
 * inline `background` beats a class unconditionally, so `hover:bg-[var(--mdt-hover)]` on those four
 * was dead the day it was written: driving the close button with `page.mouse` measured
 * rgba(0,0,0,0.035) at rest and rgba(0,0,0,0.035) hovered. They now compose instead of competing —
 * `background` stays the control's own fill and the hover or press fill goes on `background-image`
 * as a flat gradient over it, which is what a translucent overlay is meant to do anyway.
 *
 * Nothing here focuses anything: a programmatic focus taken while a pointer is still held matches
 * `:focus-visible` in both engines and would draw a ring on top of the press (`tapback-bar.tsx` and
 * `audio-recorder.tsx` document the same trap). The native focus a click already takes does not.
 */
function usePressed(enabled = true) {
  const [pressed, setPressed] = useState(false);
  const [hovering, setHovering] = useState(false);
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
    onPointerEnter: () => setHovering(true),
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      origin.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      setPressed(true);
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const from = origin.current;
      if (!from || from.id !== event.pointerId) return;
      // 10 pt, `UIScrollView`'s own pan threshold. UNMEASURED on this surface.
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > 10) release();
    },
    onPointerUp: release,
    onPointerCancel: release,
    onPointerLeave: () => { release(); setHovering(false); },
  } : {};
  const on = enabled && pressed;
  return { pressed: on, hovering: enabled && hovering, pressAttr: on ? ("" as const) : undefined, handlers };
}

/**
 * The hover or press fill as a flat `background-image`, so it composites over whatever the control's
 * own `background` already is instead of replacing it. `undefined` at rest.
 */
function overlay(hovering: boolean, pressed: boolean): string | undefined {
  const token = pressed ? "var(--mdt-press)" : hovering ? "var(--mdt-hover)" : null;
  return token ? `linear-gradient(${token}, ${token})` : undefined;
}

/**
 * The opacity a control that dims rather than fills holds while it is pressed, given the opacity its
 * own `hover:` class already takes. `undefined` while it is not pressed, so the class still rules —
 * an inline `opacity` only overrides the class when it is actually set.
 */
function pressDim(hover: number, pressed: boolean): number | undefined {
  return pressed ? hover - macDetailsUnmeasured.pressDim : undefined;
}

/** Info and Backgrounds always exist; the rest appear with their content. Order is the capture's. */
export type MacDetailsTab = "info" | "backgrounds" | "photos" | "links" | "location" | "documents";

/** `CommunicationDetails.loctable`: Call / FaceTime / Mail / Message are its four action titles. */
export type MacDetailsAction = {
  id: string;
  /** The button's accessible name and tooltip. The discs carry no visible label. */
  label: string;
  icon: "phone" | "video" | "message" | "mail";
  disabled?: boolean;
  onPress?: () => void;
};

export type MacDetailsPhoto = {
  id: string;
  /** Photo URL. Without one the tile paints `fill`, so the pane renders with no assets. */
  src?: string;
  fill?: string;
  alt?: string;
  onOpen?: () => void;
};

export type MacDetailsLink = { id: string; title: string; host: string; onOpen?: () => void };
export type MacDetailsAttachment = { id: string; name: string; meta?: string; onOpen?: () => void };

/** A handle on the contact card: "phone" / "+1 (555) 010-0100". */
export type MacDetailsHandle = { id: string; label: string; value: string; onPress?: () => void };

export type MacDetailsParticipant = { id: string; name: string; initials?: string; photo?: string; subtitle?: string };

/** One row of the location card. The capture shows a destructive row over an accent row. */
export type MacDetailsLocationAction = {
  id: string;
  label: string;
  tone?: "red" | "yellow" | "tint";
  onPress?: () => void;
};

/** A face dropped on the map card, positioned as a fraction of the card in each axis. */
export type MacDetailsMapPin = MacDetailsParticipant & { x: number; y: number };

export type MacDetailsProps = Omit<ComponentProps<"div">, "children" | "onChange"> & {
  name: string;
  initials?: string;
  /** Contact photo URL, or a whole avatar node. */
  photo?: string;
  avatar?: ReactNode;
  /** The faces in the row under the cards, and the fallback for the map's pins. */
  participants?: MacDetailsParticipant[];
  /** A handle or a participant count under the name. The capture's header has none. */
  subtitle?: string;

  actions?: MacDetailsAction[];
  /** The "Edit" capsule opposite the close button. Omit it and the capsule is not drawn. */
  onEdit?: () => void;
  /** Adds the trailing "Add" circle to the participant row. */
  onAddParticipant?: () => void;

  /** The Find My card. `map` is the map surface itself — the component draws only the card, the
   *  "Open in Find My" capsule, the pins and the title block over it. */
  map?: ReactNode;
  mapTitle?: string;
  mapSubtitle?: string;
  mapPins?: MacDetailsMapPin[];
  onOpenFindMy?: () => void;
  /** The card of location actions under the map. */
  locationActions?: MacDetailsLocationAction[];

  /** Tiles for the Backgrounds tab. Non-empty puts "Backgrounds" in the strip. */
  backgrounds?: MacDetailsPhoto[];
  photos?: MacDetailsPhoto[];
  links?: MacDetailsLink[];
  attachments?: MacDetailsAttachment[];

  /** Below the fold in the capture; each row appears only when its handler does. */
  handles?: MacDetailsHandle[];
  onCreateContact?: () => void;
  onAddToContact?: () => void;
  /**
   * The three option rows. Each row is drawn only when its `on…Change` handler is given, and each
   * value is **controlled only when it is passed**: hand over the handler alone and the checkbox
   * keeps its own state, so it works whether or not the consumer stores the answer.
   */
  hideAlerts?: boolean;
  defaultHideAlerts?: boolean;
  onHideAlertsChange?: (next: boolean) => void;
  readReceipts?: boolean;
  defaultReadReceipts?: boolean;
  onReadReceiptsChange?: (next: boolean) => void;
  sharedWithYou?: boolean;
  defaultSharedWithYou?: boolean;
  onSharedWithYouChange?: (next: boolean) => void;
  onLeave?: () => void;
  onBlock?: () => void;
  onDelete?: () => void;

  /** Closes the pane. Escape from inside the panel does the same. */
  onClose?: () => void;

  /** Also lists the participants as rows under the cards, the way the pre-capture pane did. The face
   *  row above them is drawn from `participants` either way. */
  defaultParticipantsOpen?: boolean;

  tab?: MacDetailsTab;
  defaultTab?: MacDetailsTab;
  onTabChange?: (next: MacDetailsTab) => void;

  /**
   * The conversation the pane opens beside. In the capture the window answers `Show Details` by
   * **collapsing the sidebar**, so the transcript keeps its width; this component owns only the
   * column, and `push` insets whatever it is given by the column's width. A shell that wants the
   * measured behaviour drops its sidebar as well — see `macDetailsMetrics.collapsesSidebar`.
   */
  conversation?: ReactNode;
  mode?: "push" | "overlay";
  width?: number;
  defaultWidth?: number;
  onWidthChange?: (next: number) => void;
  resizable?: boolean;

  /** Seek the presentation instead of playing it: while `open`, 0 is closed and 1 is settled. */
  progress?: number;
  /** False plays the dismissal; `onExited` fires when it is over. */
  open?: boolean;
  onExited?: () => void;
};

function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function clamp(value: number, low: number, high: number) { return Math.max(low, Math.min(high, value)); }
function stop(animation: Animation) { try { animation.cancel(); } catch { /* already gone */ } }

type Pose = Record<string, string>;
type Layer = { el: HTMLElement; from: Pose; to: Pose; duration: number; delay: number; easing: string };

/** Every layer of the presentation, as the pose it holds while closed and the pose it settles on. */
function detailsLayers(panel: HTMLElement, pane: HTMLElement | null, scrim: HTMLElement | null, travel: number, push: number): Layer[] {
  const m = macDetailsMotion;
  const layers: Layer[] = [];
  const add = (el: HTMLElement | null, from: Pose, to: Pose, duration: number, delay = 0, easing: string = m.ease) => {
    if (el) layers.push({ el, from, to, duration, delay, easing });
  };
  add(panel, { translate: `${travel}px 0px` }, { translate: "0px 0px" }, m.enter);
  add(pane, { right: "0px" }, { right: `${push}px` }, m.enter);
  add(scrim, { opacity: "0" }, { opacity: "1" }, m.dim, 0, "ease-out");
  return layers;
}

/** What an element holds right now, so a dismissal can start from a half-played entrance. */
function poseNow(el: HTMLElement, shape: Pose): Pose {
  const style = getComputedStyle(el);
  const pose: Pose = {};
  for (const key of Object.keys(shape)) pose[key] = style.getPropertyValue(key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)) || shape[key];
  return pose;
}

/** Web Animations, not a rAF loop and not a transition, so `document.getAnimations()` can seek a frame. */
function runLayers(layers: Layer[], phase: "enter" | "exit"): Animation[] {
  const m = macDetailsMotion;
  return layers.map(({ el, from, to, duration, delay, easing }) => phase === "enter"
    ? el.animate([from, to], { duration, delay, easing, fill: "both" })
    : el.animate([poseNow(el, from), from], { duration: m.exit, easing: m.exitEase, fill: "both" }));
}

/**
 * The quick actions' glyphs at the ink boxes traced off the framework's own 16x renders — each
 * `viewBox` *is* the ink box — scaled by `macDetailsMetrics.actionGlyph` to the ink the capture
 * paints inside the Ø 36 disc.
 */
function ActionGlyph({ icon }: { icon: MacDetailsAction["icon"] }) {
  const k = macDetailsMetrics.actionGlyph;
  if (icon === "phone") {
    return (
      <svg aria-hidden="true" width={15.5 * k} height={15.5 * k} viewBox="2 1 15.5 15.5" fill="currentColor">
        <path d="M4.500,0.989 L3.562,1.416 L2.673,2.250 L2.101,3.438 L1.970,4.562 L2.164,5.938 L2.664,7.312 L3.486,8.812 L4.615,10.375 L6.188,12.114 L7.625,13.453 L9.375,14.772 L11.125,15.757 L12.750,16.328 L14.000,16.468 L15.188,16.275 L16.250,15.706 L17.144,14.688 L17.460,13.875 L17.343,13.250 L16.750,12.661 L14.500,11.056 L13.938,10.784 L13.125,10.850 L11.312,11.821 L10.812,11.837 L10.188,11.522 L9.250,10.833 L7.482,9.062 L6.728,8.000 L6.524,7.438 L7.647,5.312 L7.639,4.500 L7.331,3.875 L5.443,1.312 L4.938,0.990Z" />
      </svg>
    );
  }
  if (icon === "video") {
    return (
      <svg aria-hidden="true" width={20.5 * k} height={13.5 * k} viewBox="2.5 1 20.5 13.5" fill="currentColor">
        <path d="M4.688,1.000 L3.812,1.243 L3.177,1.688 L2.734,2.312 L2.481,3.250 L2.476,12.125 L2.668,13.000 L3.037,13.625 L3.812,14.211 L5.062,14.467 L14.438,14.461 L15.312,14.269 L15.938,13.907 L16.570,13.062 L16.791,11.875 L16.782,3.250 L16.637,2.500 L16.267,1.812 L15.500,1.221 L14.500,0.976Z" />
        <path d="M21.812,2.242 L21.438,2.345 L20.938,2.674 L17.953,5.250 L17.930,10.125 L20.938,12.764 L21.438,13.092 L21.875,13.201 L22.250,13.147 L22.605,12.938 L22.959,12.250 L22.969,3.438 L22.899,2.938 L22.668,2.562 L22.250,2.290Z" />
      </svg>
    );
  }
  if (icon === "message") {
    return (
      <svg aria-hidden="true" width={19.5 * k} height={16 * k} viewBox="1.5 1 19.5 16" fill="currentColor">
        <path d="M10.312,1.000 L7.750,1.427 L6.375,1.919 L5.375,2.429 L4.375,3.105 L3.348,4.062 L2.667,4.938 L2.168,5.812 L1.609,7.500 L1.475,9.375 L1.601,10.438 L1.858,11.375 L3.148,13.875 L3.322,14.562 L3.141,15.562 L2.420,16.500 L2.428,16.688 L2.625,16.897 L3.438,16.955 L4.500,16.769 L5.500,16.395 L6.188,15.980 L8.188,16.639 L10.438,16.953 L12.688,16.894 L14.625,16.525 L16.438,15.840 L18.062,14.828 L19.403,13.500 L20.267,12.125 L20.634,11.188 L20.893,10.062 L20.968,9.000 L20.893,7.875 L20.635,6.750 L20.268,5.812 L19.145,4.125 L18.438,3.420 L17.438,2.663 L16.312,2.037 L15.250,1.606 L12.750,1.050Z" />
      </svg>
    );
  }
  // `envelope.fill` at the same 17 pt: image 24.5 × 16.5, ink 20.5 × 14.5 from (2, 1).
  return (
    <svg aria-hidden="true" width={20.5 * k} height={14.5 * k} viewBox="2 1 20.5 14.5" fill="currentColor">
      <path d="M9.375,8.737 L2.986,15.062 L3.125,15.204 L3.625,15.387 L4.312,15.468 L20.062,15.469 L20.812,15.386 L21.441,15.125 L15.062,8.737 L13.375,10.091 L12.875,10.331 L12.188,10.438 L11.562,10.331 L11.062,10.091Z" />
      <path d="M4.125,0.991 L3.375,1.166 L2.951,1.438 L11.500,8.894 L12.188,9.153 L12.625,9.073 L12.938,8.889 L21.478,1.438 L20.875,1.103 L20.062,0.972Z" />
      <path d="M2.188,2.408 L2.036,2.812 L1.969,3.625 L1.971,13.062 L2.188,14.081 L8.459,7.875Z" />
      <path d="M22.250,2.408 L15.978,7.875 L22.250,14.081 L22.398,13.625 L22.469,12.812 L22.466,3.375 L22.389,2.750Z" />
    </svg>
  );
}

/** The close button's `xmark`. Measured ink 14 × 14 inside the Ø 36 button, stroke ≈ 1.7. */
function CloseGlyph() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M1 1 13 13M13 1 1 13" />
    </svg>
  );
}

/** The Add circle's `plus`. Measured: a 26 × 27 cross on a 2 pt stroke, centred in the Ø 70 circle. */
function PlusGlyph() {
  return (
    <svg aria-hidden="true" width="26" height="26" viewBox="0 0 26 26" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M13 0.5V25.5M0.5 13H25.5" />
    </svg>
  );
}

/**
 * macOS 26 checkbox, the control `CKDetailsChatOptionsCheckboxCell` and
 * `CKDetailsSharedWithYouCheckboxCell` put on their rows. Its 16 × 16 box is the framework's; the
 * corner and the tick are drawn, not measured.
 */
export type MacCheckboxProps = Omit<ComponentProps<"button">, "onChange" | "defaultChecked"> & {
  /**
   * Controlled state. **Omit it and the checkbox keeps its own.** It used to default to `false`,
   * which made every uncontrolled instance a checkbox that could not be checked —
   * `aria-checked="false"` before the click and `aria-checked="false"` after it.
   */
  checked?: boolean;
  /** Where an uncontrolled checkbox starts. Ignored while `checked` is given. */
  defaultChecked?: boolean;
  onChange?: (next: boolean) => void;
  label?: string;
};

export function MacCheckbox({ checked, defaultChecked = false, onChange, label, className, style, ...rest }: MacCheckboxProps) {
  const size = macDetailsUnmeasured.checkbox;
  const [own, setOwn] = useState(defaultChecked);
  const on = checked ?? own;
  const { pressed, hovering, pressAttr, handlers } = usePressed();
  return (
    <button
      type="button"
      data-slot="mac-checkbox"
      data-pressed={pressAttr}
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      onClick={() => { if (checked === undefined) setOwn(!on); onChange?.(!on); }}
      className={cn("relative shrink-0 transition-[background-color,background-image] motion-reduce:transition-none", focusRing, className)}
      style={{
        width: size, height: size,
        borderRadius: macDetailsUnmeasured.checkboxRadius,
        // The overlay goes over the box's own fill either way, so a checked box darkens under the
        // pointer instead of swapping its tint for a grey, which would read as unchecking it.
        backgroundColor: on ? "var(--mdt-tint)" : "var(--mdt-fill)",
        backgroundImage: overlay(hovering, pressed),
        boxShadow: on ? "none" : "inset 0 0 0 1px var(--mdt-tertiary)",
        ...style,
      }}
      {...handlers}
      {...rest}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" width={size} height={size} className="block" fill="none"
        stroke="var(--mdt-knob)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{ opacity: on ? 1 : 0 }}>
        <path d="M4.2 8.4 6.9 11.1 11.9 5.2" />
      </svg>
    </button>
  );
}

/** The heading's trailing "See All …". A text button, so it dims under the mouse rather than filling. */
function SeeAll({ label, onAction }: { label: string; onAction?: () => void }) {
  const { pressed, pressAttr, handlers } = usePressed();
  const m = macDetailsMetrics;
  return (
    <button type="button" data-slot="see-all" data-pressed={pressAttr} onClick={onAction}
      className={cn("rounded-[4px] bg-transparent p-0 text-[var(--mdt-tint)] transition-opacity hover:underline motion-reduce:transition-none", focusRing)}
      style={{ fontSize: m.font.heading, lineHeight: "16px", letterSpacing: 0, opacity: pressDim(1, pressed) }}
      {...handlers}>
      {label}
    </button>
  );
}

/** `CKDetailsSearchResultsTitleHeaderCell`, with its "See All …" trailing button. */
function SectionHeading({ id, title, action, onAction }: { id: string; title: string; action?: string; onAction?: () => void }) {
  const m = macDetailsMetrics;
  const u = macDetailsUnmeasured;
  return (
    <div className="flex items-baseline justify-between"
      style={{ paddingTop: u.headingAbove, marginInlineStart: u.headingLeading, marginBottom: u.headingToContent }}>
      <h3 id={id} className="m-0 text-[var(--mdt-label)]"
        style={{ fontSize: m.font.heading, fontWeight: m.font.headingWeight, lineHeight: "16px", letterSpacing: 0 }}>{title}</h3>
      {action ? <SeeAll label={action} onAction={onAction} /> : null}
    </div>
  );
}

/** A document glyph for the attachment rows. Drawn, not measured. */
function DocumentGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 22" width="16" height="19.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2.7 1.7h7.4l5.2 5.2v13.4a1 1 0 0 1-1 1H2.7a1 1 0 0 1-1-1V2.7a1 1 0 0 1 1-1Z" />
      <path d="M10.1 1.9v5.1h5.1" />
    </svg>
  );
}

/** A globe for the link rows. Drawn, not measured. */
function LinkGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 22 22" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="11" cy="11" r="9.3" />
      <ellipse cx="11" cy="11" rx="4" ry="9.3" />
      <path d="M2 8.2h18M2 13.8h18" />
    </svg>
  );
}

type RowProps = {
  onPress?: () => void;
  glyph?: ReactNode;
  title: string;
  meta?: string;
  metaFirst?: boolean;
  tone?: "label" | "tint" | "red";
  height?: number;
  trailing?: ReactNode;
  slot?: string;
};

/** One row of a below-the-fold details list. Every number is `macDetailsUnmeasured`'s. */
function Row({ onPress, glyph, title, meta, metaFirst = false, tone = "label", height, trailing, slot }: RowProps) {
  const m = macDetailsMetrics;
  const u = macDetailsUnmeasured;
  const colour = tone === "red" ? "var(--mdt-red)" : tone === "tint" ? "var(--mdt-tint)" : "var(--mdt-label)";
  const titleLine = <span key="title" className="truncate" style={{ color: colour, fontSize: m.font.body, lineHeight: "16px", letterSpacing: 0 }}>{title}</span>;
  const metaLine = meta
    ? <span key="meta" className="truncate text-[var(--mdt-secondary)]" style={{ fontSize: m.font.subtitle, lineHeight: "14px", letterSpacing: 0 }}>{meta}</span>
    : null;
  const body = (
    <>
      {glyph ? <span aria-hidden="true" className="flex shrink-0 text-[var(--mdt-tertiary)]">{glyph}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col text-left">
        {metaFirst ? [metaLine, titleLine] : [titleLine, metaLine]}
      </span>
      {trailing}
    </>
  );
  const style: CSSProperties = {
    minHeight: height ?? u.rowHeight,
    borderRadius: u.listRadius,
    gap: u.rowGap,
    paddingInline: u.rowPadding,
  };
  if (!onPress) return <div data-slot={slot} className="flex w-full items-center" style={style}>{body}</div>;
  return <PressableRow slot={slot} onPress={onPress} style={style}>{body}</PressableRow>;
}

/** A row that navigates: it fills to `--mdt-hover` under the mouse and to `--mdt-press` while held. */
function PressableRow({ slot, onPress, style, children }: { slot?: string; onPress: () => void; style: CSSProperties; children: ReactNode }) {
  const { pressed, hovering, pressAttr, handlers } = usePressed();
  return (
    <button type="button" data-slot={slot} data-pressed={pressAttr} onClick={onPress}
      className={cn("flex w-full items-center bg-transparent p-0 transition-[background-image] motion-reduce:transition-none", focusRing)}
      style={{ ...style, backgroundImage: overlay(hovering, pressed) }}
      {...handlers}>
      {children}
    </button>
  );
}

/** A group of below-the-fold rows separated by the measured separator. */
function RowGroup({ children, label }: { children: ReactNode[]; label?: string }) {
  const rows = children.filter(Boolean);
  return (
    <div role="group" aria-label={label} className="flex flex-col">
      {rows.map((row, index) => (
        <div key={index} style={index === 0 ? undefined : {
          borderTop: "1px solid var(--mdt-separator)",
          marginInlineStart: macDetailsUnmeasured.rowPadding,
        }}>
          {row}
        </div>
      ))}
    </div>
  );
}

/**
 * A tile of a photo grid. It dims: 0.90 hovered (unchanged) and `pressDim` further while held, which
 * is the ladder the tiles already shipped, now driven by a pointer so it is readable and cannot
 * stick on when the button lifts off the tile.
 */
function PhotoTile({ item, size, label }: { item: MacDetailsPhoto; size: number; label: string }) {
  const { pressed, pressAttr, handlers } = usePressed();
  return (
    <button type="button" data-slot="details-photo" data-pressed={pressAttr} onClick={item.onOpen} aria-label={label}
      className={cn("relative block overflow-hidden p-0 transition-opacity hover:opacity-90 motion-reduce:transition-none", focusRing)}
      style={{
        width: size, height: size, borderRadius: macDetailsUnmeasured.photoRadius,
        background: item.src ? "var(--mdt-tile)" : (item.fill ?? "var(--mdt-tile)"),
        opacity: pressDim(0.9, pressed),
      }}
      {...handlers}>
      {/* eslint-disable-next-line @next/next/no-img-element -- registry components stay framework-neutral */}
      {item.src ? <img src={item.src} alt="" aria-hidden="true" draggable={false} className="absolute inset-0 size-full object-cover" /> : null}
    </button>
  );
}

/**
 * The map card's "Open in Find My" capsule. Measured: it reads #4d5463 over a map that reads ≈
 * #505a6b right beside it, i.e. it lifts what is behind it by only ~3–8% — it is a blur, not a
 * scrim. A blur of a map this kit does not have cannot be reproduced, so this is `backdrop-filter`
 * plus that measured lift. Hover and press deepen that lift; both steps are `macDetailsUnmeasured`.
 */
function FindMyButton({ onPress }: { onPress: () => void }) {
  const m = macDetailsMetrics;
  const { pressed, hovering, pressAttr, handlers } = usePressed();
  return (
    <button type="button" data-slot="details-find-my" data-pressed={pressAttr} onClick={onPress}
      className={cn("absolute flex items-center backdrop-blur-[18px] transition-[background-image] motion-reduce:transition-none", focusRing)}
      style={{
        left: m.mapInset, top: m.mapInset,
        height: m.mapButtonHeight, borderRadius: m.mapButtonHeight / 2,
        paddingInline: 12, color: "var(--mdt-knob)",
        fontSize: m.font.mapButton, fontWeight: 500, letterSpacing: 0,
        backgroundColor: "color-mix(in srgb, var(--mdt-label) 8%, transparent)",
        // The capsule sits on a map, not on the panel, so it lifts what is behind it with its own
        // label colour rather than with `--mdt-hover`; the two steps are the same choice.
        backgroundImage: pressed ? "linear-gradient(color-mix(in srgb, var(--mdt-label) 14%, transparent), color-mix(in srgb, var(--mdt-label) 14%, transparent))"
          : hovering ? "linear-gradient(color-mix(in srgb, var(--mdt-label) 7%, transparent), color-mix(in srgb, var(--mdt-label) 7%, transparent))"
            : undefined,
      }}
      {...handlers}>
      Open in Find My
    </button>
  );
}

/** A row of the location card: the same fill ladder every other row uses. */
function LocationActionRow({ item }: { item: MacDetailsLocationAction }) {
  const m = macDetailsMetrics;
  const { pressed, hovering, pressAttr, handlers } = usePressed();
  return (
    <button type="button" data-slot="details-location-action" data-pressed={pressAttr} data-action={item.id} onClick={item.onPress}
      className={cn("flex w-full items-center bg-transparent text-left transition-[background-image] motion-reduce:transition-none", focusRing)}
      style={{
        height: m.cardRowHeight, paddingInline: m.separatorInset,
        // The label is centred on the row, but `-apple-system`'s line box lands 2 pt higher in
        // Chromium than native's does, so the content box is pushed down by that much. This is
        // a font-metric correction, not a metric: the capture's rows are plainly centred
        // (cap band 447.7–457.7 in a row spanning 429.5–475.5).
        paddingTop: 4,
        color: item.tone === "yellow" ? "var(--mdt-yellow)" : item.tone === "tint" ? "var(--mdt-tint)" : "var(--mdt-red)",
        fontSize: m.font.row, fontWeight: m.font.rowWeight, letterSpacing: 0,
        backgroundImage: overlay(hovering, pressed),
      }}
      {...handlers}>
      {item.label}
    </button>
  );
}

/** The trailing "Add" circle of the face row. A filled disc, so it dims rather than filling. */
function AddPersonButton({ size, onPress }: { size: number; onPress?: () => void }) {
  const { pressed, pressAttr, handlers } = usePressed();
  return (
    <button type="button" data-slot="details-add-person" data-pressed={pressAttr} aria-label="Add" onClick={onPress}
      className={cn("flex items-center justify-center rounded-full p-0 text-[var(--mdt-label)] transition-opacity hover:opacity-80 motion-reduce:transition-none", focusRing)}
      style={{ width: size, height: size, background: "var(--mdt-fill)", opacity: pressDim(0.8, pressed) }}
      {...handlers}>
      <PlusGlyph />
    </button>
  );
}

/**
 * One of the header's Ø 36 quick-action discs. `disabled` really is `disabled` here (unlike the
 * phone's `aria-disabled` circles), so an unavailable action neither dims nor takes the pointer.
 */
function ActionDisc({ action, size }: { action: MacDetailsAction; size: number }) {
  const { pressed, pressAttr, handlers } = usePressed(!action.disabled);
  return (
    <button type="button" data-slot="details-action" data-pressed={pressAttr} data-action={action.id}
      aria-label={action.label} title={action.label} disabled={action.disabled} onClick={action.onPress}
      className={cn("flex items-center justify-center rounded-full p-0 text-[var(--mdt-label)] transition-opacity motion-reduce:transition-none",
        "enabled:hover:opacity-80 disabled:text-[var(--mdt-tertiary)]", focusRing)}
      style={{ width: size, height: size, background: "var(--mdt-fill)", opacity: pressDim(0.8, pressed) }}
      {...handlers}>
      <ActionGlyph icon={action.icon} />
    </button>
  );
}

/** The strip's own titles, in the capture's order. */
const tabTitles: Record<MacDetailsTab, string> = {
  info: "Info",
  backgrounds: "Backgrounds",
  photos: "Photos",
  links: "Links",
  location: "Location",
  documents: "Documents",
};

/**
 * One capsule of the tab strip. The selected one is the measured `--mdt-tab-fill`; an unselected one
 * had nothing but a text colour, so a click landed on a control that never acknowledged it. It now
 * takes the same `--mdt-hover` / `--mdt-press` fills every other unselected control on this pane
 * takes, and the selected one darkens under a press instead (its own fill is already the light one).
 */
function Tab({ tab, selected, id, controls, onSelect }: { tab: MacDetailsTab; selected: boolean; id: string; controls: string; onSelect: () => void }) {
  const m = macDetailsMetrics;
  const { pressed, hovering, pressAttr, handlers } = usePressed();
  return (
    <button type="button" role="tab" data-slot="details-tab" data-tab={tab} data-pressed={pressAttr}
      aria-selected={selected} aria-controls={controls} id={id}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn("shrink-0 transition-[background-image,color] motion-reduce:transition-none", focusRing,
        selected ? "text-[var(--mdt-label)]" : "text-[var(--mdt-secondary)] hover:text-[var(--mdt-label)]")}
      style={{
        height: m.tabHeight, paddingInline: m.tabPaddingInline, borderRadius: m.tabHeight / 2,
        fontSize: m.font.tab, fontWeight: selected ? m.font.tabSelectedWeight : m.font.tabWeight,
        lineHeight: `${m.tabHeight}px`, letterSpacing: 0,
        // The selected capsule's measured fill is the background; the overlay darkens it, so the
        // selected tab acknowledges a press too instead of being the one dead control in the strip.
        backgroundColor: selected ? "var(--mdt-tab-fill)" : "transparent",
        backgroundImage: overlay(hovering, pressed),
      }}
      {...handlers}>
      {tabTitles[tab]}
    </button>
  );
}

/** The two header chrome buttons: the close ring and the "Edit" capsule. Same fill ladder. */
function HeaderButton({ slot, label, title, onPress, style, children }: { slot: string; label?: string; title?: string; onPress?: () => void; style: CSSProperties; children: ReactNode }) {
  const { pressed, hovering, pressAttr, handlers } = usePressed();
  return (
    <button type="button" data-slot={slot} data-pressed={pressAttr} aria-label={label} title={title} onClick={onPress}
      className={cn("absolute flex items-center justify-center p-0 text-[var(--mdt-label)] transition-[background-image] motion-reduce:transition-none", focusRing)}
      style={{
        backgroundColor: "var(--mdt-glass)", boxShadow: "inset 0 0 0 1px var(--mdt-glass-rim)",
        backgroundImage: overlay(hovering, pressed),
        ...style,
      }}
      {...handlers}>
      {children}
    </button>
  );
}

export function MacDetails({
  name, initials, photo, avatar, participants, subtitle,
  actions = [], onEdit, onAddParticipant,
  map, mapTitle, mapSubtitle, mapPins, onOpenFindMy, locationActions = [],
  backgrounds = [], photos = [], links = [], attachments = [],
  handles = [], onCreateContact, onAddToContact,
  // No `= false` on any of these: that default is what made every one of them a checkbox that could
  // not be checked. `undefined` has to reach `MacCheckbox` for it to keep its own state.
  hideAlerts, defaultHideAlerts, onHideAlertsChange,
  readReceipts, defaultReadReceipts, onReadReceiptsChange,
  sharedWithYou, defaultSharedWithYou, onSharedWithYouChange,
  onLeave, onBlock, onDelete, onClose,
  defaultParticipantsOpen = false,
  tab, defaultTab = "info", onTabChange,
  conversation, mode = "push",
  width, defaultWidth = macDetailsMetrics.width, onWidthChange, resizable = true,
  progress, open = true, onExited, className, style, ...props
}: MacDetailsProps) {
  const m = macDetailsMetrics;
  const u = macDetailsUnmeasured;
  const titleId = useId();

  const panel = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const timeline = useRef<Animation[] | null>(null);
  const exited = useRef(onExited);
  const opener = useRef<Element | null>(null);
  useEffect(() => { exited.current = onExited; }, [onExited]);

  const [selfWidth, setSelfWidth] = useState(clamp(defaultWidth, m.minWidth, m.maxWidth));
  const columnWidth = clamp(width ?? selfWidth, m.minWidth, m.maxWidth);
  const setWidth = useCallback((next: number) => {
    const value = clamp(Math.round(next), macDetailsMetrics.minWidth, macDetailsMetrics.maxWidth);
    timeline.current?.forEach(stop);
    timeline.current = null;
    setSelfWidth(value);
    onWidthChange?.(value);
  }, [onWidthChange]);

  const [selfTab, setSelfTab] = useState<MacDetailsTab>(defaultTab);
  const selectTab = (next: MacDetailsTab) => { setSelfTab(next); onTabChange?.(next); };

  const [seenOpen, setSeenOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  if (seenOpen !== open) { setSeenOpen(open); setClosing(!open); }

  // `PlatformTopEdgeBlurView`: the header grows a blurred edge once the body scrolls past it.
  const [scrolled, setScrolled] = useState(false);

  const inert = !open && !closing;
  // The column is flush, so its travel and the conversation's inset are both just its width.
  const travel = columnWidth;
  const push = columnWidth;

  const build = (phase: "enter" | "exit"): Animation[] | null => {
    const node = panel.current;
    if (!node) return null;
    return runLayers(detailsLayers(node, mode === "push" ? pane.current : null, scrim.current, travel, push), phase);
  };
  const land = (list: Animation[]) => {
    if (timeline.current !== list) return;
    list.forEach(stop);
    timeline.current = null;
  };

  useEffect(() => () => { timeline.current?.forEach(stop); timeline.current = null; }, []);

  useLayoutEffect(() => {
    if (prefersReducedMotion()) return;
    const previous = timeline.current;
    const next = build(open ? "enter" : "exit");
    previous?.forEach(stop);
    timeline.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  useLayoutEffect(() => {
    if (prefersReducedMotion()) { if (!open && closing) exited.current?.(); return; }
    const list = timeline.current ?? build(open ? "enter" : "exit");
    if (!list) return;
    timeline.current = list;
    const total = open ? macDetailsMotion.enter : macDetailsMotion.exit;
    const seek = (time: number) => list.forEach(animation => { animation.pause(); try { animation.currentTime = time; } catch { /* no timeline yet */ } });
    if (progress !== undefined) {
      const time = clamp(progress, 0, 1) * total;
      seek(time);
      if (open && time >= total) land(list);
      return;
    }
    if (!open && !closing) { seek(total); return; }
    let dropped = false;
    list.forEach(animation => animation.play());
    Promise.allSettled(list.map(animation => animation.finished)).then(() => {
      if (dropped) return;
      if (open) land(list);
      else if (closing && timeline.current === list) exited.current?.();
    });
    return () => { dropped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, progress, closing, mode]);

  useEffect(() => {
    if (progress !== undefined) return;
    if (open) {
      const node = panel.current;
      if (!node || node.contains(document.activeElement)) return;
      opener.current = document.activeElement;
      node.focus({ preventScroll: true });
      return;
    }
    const previous = opener.current as HTMLElement | null;
    opener.current = null;
    if (previous && typeof previous.focus === "function" && previous.isConnected) previous.focus({ preventScroll: true });
  }, [open, progress]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || !onClose) return;
    event.preventDefault();
    onClose();
  };

  const drag = useRef<{ x: number; width: number } | null>(null);
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: event.clientX, width: columnWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setWidth(drag.current.width - (event.clientX - drag.current.x));
  };
  const onHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onHandleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowLeft") { event.preventDefault(); setWidth(columnWidth + step); }
    if (event.key === "ArrowRight") { event.preventDefault(); setWidth(columnWidth - step); }
    if (event.key === "Home") { event.preventDefault(); setWidth(macDetailsMetrics.maxWidth); }
    if (event.key === "End") { event.preventDefault(); setWidth(macDetailsMetrics.minWidth); }
  };

  const contentWidth = columnWidth - m.contentInset * 2;
  const tile = (contentWidth - u.photoGap * (u.photoColumns - 1)) / u.photoColumns;
  const people = participants ?? [];
  const hasMap = Boolean(map || mapTitle || mapPins?.length);

  // The capture's order: Info, Backgrounds, Photos, Links, Location. Documents is the framework's
  // fifth tab and keeps its place at the end, where the strip has already run off the pane.
  const tabs: MacDetailsTab[] = ["info",
    ...(backgrounds.length ? ["backgrounds" as const] : []),
    ...(photos.length ? ["photos" as const] : []),
    ...(links.length ? ["links" as const] : []),
    ...(hasMap ? ["location" as const] : []),
    ...(attachments.length ? ["documents" as const] : []),
  ];
  const wanted = tab ?? selfTab;
  const active: MacDetailsTab = tabs.includes(wanted) ? wanted : "info";

  const previewPhotos = photos.slice(0, u.photoColumns * u.previewPhotoRows);
  const previewLinks = links.slice(0, u.previewRows);
  const previewFiles = attachments.slice(0, u.previewRows);

  const photoGrid = (items: MacDetailsPhoto[]) => (
    <ul className="m-0 grid list-none p-0" style={{ gridTemplateColumns: `repeat(${u.photoColumns}, ${tile}px)`, gap: u.photoGap }}>
      {items.map((item, index) => (
        <li key={item.id} className="m-0 p-0">
          <PhotoTile item={item} size={tile} label={item.alt ?? `Shared photo ${index + 1}`} />
        </li>
      ))}
    </ul>
  );

  const linkRows = (items: MacDetailsLink[]) => (
    <div className="flex flex-col">
      {items.map(item => (
        <Row key={item.id} slot="details-link" onPress={item.onOpen} glyph={<LinkGlyph />} title={item.title} meta={item.host} />
      ))}
    </div>
  );

  const fileRows = (items: MacDetailsAttachment[]) => (
    <div className="flex flex-col">
      {items.map(item => (
        <Row key={item.id} slot="details-attachment" onPress={item.onOpen} glyph={<DocumentGlyph />} title={item.name} meta={item.meta} />
      ))}
    </div>
  );

  const sectionStyle: CSSProperties = { paddingTop: u.sectionMargin, paddingBottom: u.sectionMargin };
  const sectionId = (kind: string) => `${titleId}-${kind}`;

  /**
   * The Find My card. 268 × 196 with a 16 corner; the "Open in Find My" capsule sits 18 in from the
   * top-left, the pins ride the map, and the title block sits 18 in from the bottom-left.
   */
  const mapCard = (
    <section data-slot="details-map" aria-label={mapTitle ?? "Location"}
      className="relative overflow-hidden"
      style={{ height: m.mapHeight, borderRadius: m.cardRadius, background: "var(--mdt-fill)" }}>
      {map ? <div aria-hidden="true" className="absolute inset-0">{map}</div> : null}
      {(mapPins ?? []).map(pin => (
        <span key={pin.id} className="absolute" role="img" aria-label={pin.name}
          style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%`, translate: "-50% -50%" }}>
          <Avatar size={m.mapPin} initials={pin.initials} src={pin.photo} name={pin.name} aria-hidden="true" />
        </span>
      ))}
      {onOpenFindMy ? <FindMyButton onPress={onOpenFindMy} /> : null}
      {mapTitle || mapSubtitle ? (
        <div className="absolute flex flex-col" style={{ left: m.contentInset, bottom: m.mapInset - 2, gap: 1 }}>
          {mapTitle ? <span style={{ color: "var(--mdt-knob)", fontSize: m.font.mapTitle, fontWeight: m.font.mapTitleWeight, lineHeight: "15px", letterSpacing: 0 }}>{mapTitle}</span> : null}
          {mapSubtitle ? <span style={{ color: "color-mix(in srgb, var(--mdt-knob) 65%, transparent)", fontSize: m.font.mapTitle, fontWeight: 400, lineHeight: "15px", letterSpacing: 0 }}>{mapSubtitle}</span> : null}
        </div>
      ) : null}
    </section>
  );

  /** The location card: 46 pt rows, a separator 16 in from each edge, text 16 in from the leading edge. */
  const locationCard = (
    <section data-slot="details-location-actions" aria-label="Location"
      className="flex flex-col overflow-hidden"
      style={{ borderRadius: m.cardRadius, background: "var(--mdt-fill)" }}>
      {locationActions.map((item, index) => (
        <div key={item.id} className="contents">
          {index === 0 ? null : (
            <div aria-hidden="true" data-slot="details-card-separator"
              style={{ height: 1, marginInline: m.separatorInset, background: "var(--mdt-separator)" }} />
          )}
          <LocationActionRow item={item} />
        </div>
      ))}
    </section>
  );

  /** The face row: three 76 pt cells with 20 between them exactly fill the 268 content column. */
  const faceRow = (
    <section data-slot="details-people" aria-label="Participants" className="flex" style={{ gap: m.personGap }}>
      {[...people.map(person => ({ person: person as MacDetailsParticipant | undefined, add: false })), ...(onAddParticipant ? [{ person: undefined, add: true }] : [])].map(cell => (
        <div key={cell.person?.id ?? "add"} className="flex min-w-0 flex-col items-center" style={{ width: m.personCell }}>
          {cell.add ? (
            <AddPersonButton size={m.personSize} onPress={onAddParticipant} />
          ) : (
            <Avatar size={m.personSize} initials={cell.person?.initials} src={cell.person?.photo} name={cell.person?.name ?? ""} aria-hidden="true" />
          )}
          <span className="w-full truncate text-center text-[var(--mdt-label)]"
            style={{ marginTop: m.personLabelGap - 3, fontSize: m.font.person, fontWeight: m.font.personWeight, lineHeight: "13px", letterSpacing: 0 }}>
            {cell.add ? "Add" : cell.person?.name.split(" ")[0]}
          </span>
        </div>
      ))}
    </section>
  );

  return (
    <div
      data-slot="mac-details"
      className={cn("relative isolate size-full overflow-hidden bg-[var(--mdt-ground)] text-[var(--mdt-label)]", vars, className)}
      style={{ fontFamily: font, WebkitFontSmoothing: "antialiased", ...style }}
      {...props}
    >
      {conversation ? (
        <div
          ref={pane}
          data-slot="details-conversation"
          inert={mode === "overlay" && !inert ? true : undefined}
          className="absolute inset-y-0 left-0"
          style={{ right: inert || mode !== "push" ? 0 : push }}
        >
          {conversation}
        </div>
      ) : null}

      {mode === "overlay" && conversation ? (
        <div ref={scrim} aria-hidden="true" data-slot="details-scrim" className="absolute inset-0 bg-[var(--mdt-scrim)]"
          style={{ opacity: inert ? 0 : 1 }} />
      ) : null}

      {/* The column: flush to the trailing edge, top and bottom, square, no shadow — measured. Its
          leading edge carries the 1 pt divider and nothing else. */}
      <div
        ref={panel}
        data-slot="details-panel"
        role="complementary"
        aria-label="Conversation details"
        tabIndex={-1}
        inert={inert ? true : undefined}
        onKeyDown={onPanelKeyDown}
        className="absolute inset-y-0 right-0 flex flex-col bg-[var(--mdt-panel)] outline-none"
        style={{
          width: columnWidth,
          translate: inert ? `${travel}px 0px` : undefined,
        }}
      >
        {/* The divider is painted ON the column's leading edge, not as a border: the capture measures
            every content inset from x 660, the same column the hairline occupies. A border would push
            the whole body one point trailing. */}
        <div aria-hidden="true" data-slot="details-divider" className="pointer-events-none absolute inset-y-0 left-0 z-20"
          style={{ width: m.divider, background: "var(--mdt-divider)" }} />
        {/* `Header.HeaderView`: the avatar, the name, the quick actions and the tab strip, pinned over
            a scrolling body. The two chrome buttons overlap the avatar's band rather than sitting
            above it — measured: their ring is y 8–43 while the avatar starts at 26. */}
        <div data-slot="details-header" className="relative z-10 shrink-0" style={{ paddingTop: m.avatarTop }}>
          {onClose ? (
            <HeaderButton slot="details-close" label="Hide Details" title="Hide Details" onPress={onClose}
              style={{ width: m.headerButton, height: m.headerButton, top: m.headerButtonTop, left: m.headerInset, borderRadius: "50%" }}>
              <CloseGlyph />
            </HeaderButton>
          ) : null}
          {onEdit ? (
            <HeaderButton slot="details-edit" onPress={onEdit}
              style={{
                minWidth: m.headerEditWidth, height: m.headerButton, top: m.headerButtonTop, right: m.headerInset,
                paddingInline: 8, borderRadius: m.headerButton / 2,
                fontSize: m.font.edit, fontWeight: 400, letterSpacing: 0,
              }}>
              Edit
            </HeaderButton>
          ) : null}

          <div className="flex flex-col items-center" style={{ paddingInline: m.contentInset }}>
            {avatar
              ? <span className="flex">{avatar}</span>
              : <Avatar size={m.avatar} initials={initials} src={photo} name={name} />}
            <h2 id={titleId} className="m-0 text-center text-[var(--mdt-label)]"
              style={{ fontSize: m.font.name, fontWeight: m.font.nameWeight, lineHeight: "28px", letterSpacing: 0 }}>
              {name}
            </h2>
            {subtitle ? (
              <p className="m-0 text-center text-[var(--mdt-secondary)]"
                style={{ fontSize: m.font.subtitle, lineHeight: "14px", letterSpacing: 0 }}>{subtitle}</p>
            ) : null}

            {/* `QuickActionsContainerView`: Ø 36 discs, 16 apart, no labels. */}
            {actions.length ? (
              <div role="group" aria-labelledby={titleId} className="flex" style={{ marginTop: 10, gap: m.actionGap }}>
                {actions.map(action => <ActionDisc key={action.id} action={action} size={m.action} />)}
              </div>
            ) : null}
          </div>

          {/* `DetailsTabBarView` / `SegmentedTabControl`: capsules 26 tall, 2 apart, the strip starting
              16 in and running off the pane's trailing edge, which is where it scrolls. */}
          {tabs.length > 1 ? (
            <div role="tablist" aria-label="Details" data-slot="details-tabs"
              className="mac-details-tabs flex overflow-x-auto"
              style={{ marginTop: m.sectionGap, gap: m.tabGap, paddingInlineStart: m.contentInset, paddingInlineEnd: m.contentInset }}>
              <style>{".mac-details-tabs{scrollbar-width:none}.mac-details-tabs::-webkit-scrollbar{display:none}"}</style>
              {tabs.map(key => (
                <Tab key={key} tab={key} selected={active === key} id={`${titleId}-tab-${key}`} controls={sectionId(key)} onSelect={() => selectTab(key)} />
              ))}
            </div>
          ) : null}

          {/* `PlatformTopEdgeBlurView`. */}
          <div aria-hidden="true" data-slot="details-scroll-edge"
            className="pointer-events-none absolute inset-x-0 transition-opacity duration-150 motion-reduce:transition-none"
            style={{
              top: "100%", height: u.scrollEdgeBlur, opacity: scrolled ? 1 : 0,
              background: "linear-gradient(to bottom, var(--mdt-panel), transparent)",
            }} />
        </div>

        <div data-slot="details-scroll" className="min-h-0 flex-1 overflow-y-auto"
          onScroll={event => setScrolled(event.currentTarget.scrollTop > 0)}
          style={{ paddingInline: m.contentInset, paddingTop: m.bodyTop, paddingBottom: m.bodyBottom }}>

          {active === "info" ? (
            <div role="tabpanel" id={sectionId("info")} aria-labelledby={tabs.length > 1 ? `${titleId}-tab-info` : undefined} tabIndex={-1}
              className="flex flex-col outline-none" style={{ gap: m.sectionGap }}>
              {hasMap ? mapCard : null}
              {locationActions.length ? locationCard : null}
              {people.length || onAddParticipant ? faceRow : null}

              {/* Everything below here is under the fold in the capture: its order and its metrics are
                  the framework's, not a measurement. */}
              {defaultParticipantsOpen && people.length > 1 ? (
                <section data-slot="details-section" aria-labelledby={sectionId("participants-heading")} style={sectionStyle} id={sectionId("participants")}>
                  {/* `DETAILS_VIEW_GROUP_COUNT_TEXT`: "%lu PERSON" / "%lu PEOPLE", verbatim. */}
                  <SectionHeading id={sectionId("participants-heading")} title={`${people.length} ${people.length === 1 ? "PERSON" : "PEOPLE"}`} />
                  <RowGroup label="Participants">
                    {people.map(person => (
                      <Row key={person.id} slot="details-participant" title={person.name} meta={person.subtitle}
                        glyph={<Avatar size={u.listAvatar} initials={person.initials} src={person.photo} name={person.name} />} />
                    ))}
                  </RowGroup>
                </section>
              ) : null}

              {handles.length ? (
                <section data-slot="details-section" style={sectionStyle}>
                  <RowGroup label="Contact">
                    {handles.map(handle => (
                      <Row key={handle.id} slot="details-handle" onPress={handle.onPress}
                        title={handle.value} meta={handle.label} metaFirst
                        height={u.optionHeight} tone={handle.onPress ? "tint" : "label"} />
                    ))}
                  </RowGroup>
                </section>
              ) : null}

              {onCreateContact || onAddToContact ? (
                <section data-slot="details-section" style={sectionStyle}>
                  <RowGroup label="Contact actions">
                    {onCreateContact ? <Row slot="details-create-contact" onPress={onCreateContact} title="Create New Contact" tone="tint" /> : null}
                    {onAddToContact ? <Row slot="details-add-contact" onPress={onAddToContact} title="Add to Existing Contact" tone="tint" /> : null}
                  </RowGroup>
                </section>
              ) : null}

              {previewPhotos.length ? (
                <section data-slot="details-section" aria-labelledby={sectionId("photos-heading")} style={sectionStyle}>
                  <SectionHeading id={sectionId("photos-heading")} title="Photos"
                    action={photos.length > previewPhotos.length ? "See All Photos" : undefined}
                    onAction={() => selectTab("photos")} />
                  {photoGrid(previewPhotos)}
                </section>
              ) : null}

              {previewLinks.length ? (
                <section data-slot="details-section" aria-labelledby={sectionId("links-heading")} style={sectionStyle}>
                  <SectionHeading id={sectionId("links-heading")} title="Links"
                    action={links.length > previewLinks.length ? "See All Links" : undefined}
                    onAction={() => selectTab("links")} />
                  {linkRows(previewLinks)}
                </section>
              ) : null}

              {previewFiles.length ? (
                <section data-slot="details-section" aria-labelledby={sectionId("files-heading")} style={sectionStyle}>
                  <SectionHeading id={sectionId("files-heading")} title="Documents"
                    action={attachments.length > previewFiles.length ? "See All Attachments" : undefined}
                    onAction={() => selectTab("documents")} />
                  {fileRows(previewFiles)}
                </section>
              ) : null}

              {onHideAlertsChange || onReadReceiptsChange || onSharedWithYouChange ? (
                <section data-slot="details-section" style={sectionStyle}>
                  <h3 className="sr-only">Conversation options</h3>
                  <RowGroup label="Conversation options">
                    {onHideAlertsChange ? (
                      <Row slot="details-hide-alerts" title="Hide Alerts" height={u.optionHeight}
                        trailing={<MacCheckbox checked={hideAlerts} defaultChecked={defaultHideAlerts} onChange={onHideAlertsChange} label="Hide Alerts" />} />
                    ) : null}
                    {onReadReceiptsChange ? (
                      <Row slot="details-read-receipts" title="Send Read Receipts" height={u.optionHeight}
                        trailing={<MacCheckbox checked={readReceipts} defaultChecked={defaultReadReceipts} onChange={onReadReceiptsChange} label="Send Read Receipts" />} />
                    ) : null}
                    {onSharedWithYouChange ? (
                      <Row slot="details-shared-with-you" title="Shared With You" height={u.optionHeight}
                        trailing={<MacCheckbox checked={sharedWithYou} defaultChecked={defaultSharedWithYou} onChange={onSharedWithYouChange} label="Shared With You" />} />
                    ) : null}
                  </RowGroup>
                </section>
              ) : null}

              {onLeave || onBlock || onDelete ? (
                <section data-slot="details-section" style={sectionStyle}>
                  <RowGroup label="Conversation">
                    {onLeave ? <Row slot="details-leave" onPress={onLeave} title="Leave this Conversation" tone="red" height={u.optionHeight} /> : null}
                    {onBlock ? <Row slot="details-block" onPress={onBlock} title="Block Contact" tone="red" height={u.optionHeight} /> : null}
                    {onDelete ? <Row slot="details-delete" onPress={onDelete} title="Delete Conversation…" tone="red" height={u.optionHeight} /> : null}
                  </RowGroup>
                </section>
              ) : null}
            </div>
          ) : null}

          {active === "backgrounds" ? (
            <div role="tabpanel" id={sectionId("backgrounds")} aria-labelledby={`${titleId}-tab-backgrounds`} tabIndex={-1} className="outline-none">
              {photoGrid(backgrounds)}
            </div>
          ) : null}

          {active === "photos" ? (
            <div role="tabpanel" id={sectionId("photos")} aria-labelledby={`${titleId}-tab-photos`} tabIndex={-1} className="outline-none">
              {photoGrid(photos)}
            </div>
          ) : null}

          {active === "links" ? (
            <div role="tabpanel" id={sectionId("links")} aria-labelledby={`${titleId}-tab-links`} tabIndex={-1} className="outline-none">
              {linkRows(links)}
            </div>
          ) : null}

          {active === "location" ? (
            <div role="tabpanel" id={sectionId("location")} aria-labelledby={`${titleId}-tab-location`} tabIndex={-1}
              className="flex flex-col outline-none" style={{ gap: m.sectionGap }}>
              {hasMap ? mapCard : null}
              {locationActions.length ? locationCard : null}
            </div>
          ) : null}

          {active === "documents" ? (
            <div role="tabpanel" id={sectionId("documents")} aria-labelledby={`${titleId}-tab-documents`} tabIndex={-1} className="outline-none">
              {fileRows(attachments)}
            </div>
          ) : null}
        </div>

        {resizable ? (
          <div
            data-slot="details-resize"
            role="separator"
            aria-label="Details width"
            aria-orientation="vertical"
            aria-valuenow={columnWidth}
            aria-valuemin={m.minWidth}
            aria-valuemax={m.maxWidth}
            tabIndex={0}
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
            onKeyDown={onHandleKeyDown}
            className={cn("absolute inset-y-0 left-0 w-[6px] cursor-col-resize", focusRing)}
            style={{ marginLeft: -3, touchAction: "none" }}
          />
        ) : null}
      </div>
    </div>
  );
}
