"use client";

import { useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { usePlatform, type Platform } from "@/components/message-ui/platform";
import { bubbleMetrics, fontStack } from "@/components/message-ui/tokens";
import type { TapbackType } from "@/components/message-ui/tapback";

/**
 * The centred grey transcript lines that are not bubbles: a group rename, a join, a leave, the group
 * photo and background, an unsent message, a kept attachment, a failed group edit, and the
 * unknown-sender notice.
 *
 * ## Where every number comes from
 *
 * Two sources, and the code says which for each value. Nothing here is a guess except the four
 * things called out under "Still unmeasured".
 *
 * ### 1. `references/ios/captures/incoming-light.png` (402x874 @3x), the unknown-sender notice
 *
 * The only frame in this repo that holds any member of this family. Re-measured for this file with a
 * full-width non-white row scan (`scripts/measure/px.py row` agrees; the scan is reproduced by
 * `/lab/system-message?scene=notice`):
 *
 * - Line 1 ("If you did not expect this message from an unknown sender, it may") inks device rows
 *   2163-2195; line 2 ("be spam.") inks 2204-2234. Row 2203 is clear, so line 2 starts at 2204.
 * - **Line pitch 13.3333**, read twice and independently. Baselines: line 1's inked-pixel count
 *   falls 525 -> 128 between rows 2188 and 2189, line 2's falls 82 -> 24 between 2228 and 2229, so
 *   the baselines are 40 device rows apart. The x-height band opens on row 2170 (n jumps 65 -> 337)
 *   and on row 2210 (n jumps 5 -> 41): also 40 rows. 40/3 = 13.3333.
 * - **Font size 11**, established by *width*, not by x-height. Line 1's ink spans device x 67-1137,
 *   i.e. 22.3333 to 379.3333 = 357.0 pt of advance for 65 characters. 12 pt would need ~389 and
 *   would not fit the 370 column at all. (The x-height argument that used to live here proves
 *   nothing: ChatKit reports `-[UIFont xHeight]` = 5.79 for this font, and a threshold scan of the
 *   capture reads 6.33, so every x-height reading in this repo is anti-aliasing-inflated.)
 * - **Colour #8a8a8e light / #8d8d93 dark**, which is `--im-secondary`. Confirmed from both ends:
 *   the capture's darkest ink is exactly (138,138,142), and ChatKit's transcript attributes carry
 *   `UIColor.secondaryLabel`, which on iOS is (60,60,67, 0.6) -> (138,138,142.2) over white and
 *   (235,235,245, 0.6) -> (141,141,147) over black.
 * - **The 370 column** (402 - 2 x 16): it reproduces the capture's line break to the word.
 * - **Space above: 16.1667.** The bubble body above ends at 702.67 (`ios-notices.tsx`). Line 1's
 *   baseline is at 729.6667; walking back the 10.6348 ascent and the 0.1891 half-leading of a
 *   13.3333 box puts the line box top at 718.84, i.e. 16.1667 below the bubble. This file splits
 *   that the way ChatKit does: `padTop` 3 belongs to the item, `gapAbove` 13.1667 to the layout.
 *
 * ### 2. ChatKit 26.5, read with a Catalyst probe
 *
 * `clang -target arm64-apple-ios26.0-macabi`, `dlopen`
 * `/System/iOSSupport/.../ChatKit.framework/ChatKit`, `-[UIDevice userInterfaceIdiom]` swizzled to
 * `.phone` and to `.mac`, and `CKUIBehaviorPhone` / `CKUIBehaviorMac` instantiated directly. Every
 * reading below was taken in this session, not quoted:
 *
 * | reading | phone | mac |
 * |---|---|---|
 * | `transcriptRegularFontAttributes` | .SFNS-Regular **11**, natural line height 13.0, centred, no min/max line height, no line spacing | identical |
 * | `transcriptEmphasizedFontAttributes` | .SFNS-**Medium**, `UIFontWeightTrait` 0.23 = `UIFontWeightMedium` = CSS **500** | identical |
 * | `transcriptGroupModificationErrorRegularFontAttributes` | .SFNS-**Light**, trait -0.4 = CSS **300**, `systemRedColor` | identical |
 * | `transcriptGroupModificationErrorEmphasizedFontAttributes` | .SFNS-Medium 11, `systemRedColor` | identical |
 * | `-[CKGroupActionChatItem textAlignmentInsets]` | top **3**, bottom **3** | top **2.5**, bottom **2** |
 * | `-[CKGroupActionChatItem hasSelectableText]` | **NO** | **NO** |
 * | `transcriptMessageStatusFont` ("Delivered") | .SFNS-Semibold 11 | .SFNS-Medium 9 |
 * | `transcriptStatusItemEdgeInsets` | all zeros | all zeros |
 *
 * Three consequences, each of which was wrong here before:
 *
 * - The emphasised run is weight **500**, not 600. The old 600 was borrowed from
 *   `transcriptMessageStatusFont`, which is the "Delivered" label - a different font from the
 *   emphasis run inside a status sentence.
 * - **macOS is 11/13, the same as iOS**, not 9/11. `transcriptMessageStatusFont` is the one
 *   transcript metric ChatKit scales per idiom, and it is precisely the one this file used to
 *   borrow. The transcript status text does not scale.
 * - `hasSelectableText` is NO, so `select-none` is a reading, not a preference.
 *
 * ### 3. The strings
 *
 * Every sentence below is a ChatKit format string, verbatim, from
 * `.../ChatKit.framework/Resources/ChatKit.loctable` (`plistlib`, no probe needed). They are kept as
 * templates in `statusTemplates` rather than assembled in code, so the wording cannot drift. ChatKit
 * marks the emphasised run with `#...#`; that this is emphasis markup and not a substitution token
 * is settled by the localisations, where the delimiters wrap a translated verb phrase:
 * `es` "#Has denominado# la conversación “%@”.", `de` "#Du# hast...", `ja` "#あなた#が...".
 *
 * That markup fixes two more errors this file used to make: **"You" is emphasised** (every
 * `GROUP_YOU_*` string wraps it), and **the added or removed participant is not** - only the actor
 * sits inside `#...#`, so "**You** added Sam Rivera to the conversation." bolds the first half, not
 * the second.
 *
 * ### What this surface is not
 *
 * - **A missed call is not a Messages transcript line.** ChatKit's string tables contain no `Missed*`
 *   string of any kind; "Missed Call" and "Missed FaceTime" live in FaceTime.app's `Recents.loctable`
 *   (the recents list), and "Missed Video Call" - which this file used to render - exists nowhere on
 *   the system. A call in a transcript is the FaceTime card: use `facetime-card.tsx` with
 *   `state="missed"`.
 * - **A tapback is not a transcript line either**, it is a balloon (`tapback.tsx`). The six verbs are
 *   real, but they come from `IMSharedUtilities.loctable` ("%@ loved “%@”", "You loved “%@”"), which
 *   is the *notification and sidebar preview* format: it carries no `#...#` emphasis at all, and
 *   ChatKit has no status string for a reaction. `tapbackSummary()` below renders that preview
 *   string; it is deliberately not a `SystemMessageEvent`.
 *
 * ### Still unmeasured
 *
 * 1. **`gapAbove` / `gapBelow` for the group lines on both platforms.** ChatKit keeps the item's own
 *    padding in `textAlignmentInsets` (which we have) but the spacing *between* chat items in
 *    `-[CKChatItem layoutItemSpacingWithEnvironment:...]`, which needs a live collection-view layout
 *    environment; `transcriptStatusItemEdgeInsets` is all zeros. No committed capture shows a group
 *    conversation on either platform. The remaining route is an iOS-simulator capture of a real group
 *    event: seed the booted simulator's `Library/SMS/sms.db` with `item_type` 1/2/3/6 rows and
 *    screenshot with `xcrun simctl io booted screenshot`. That was attempted for this file and the
 *    sandbox declined the write to the Messages database, so it needs an explicit permission grant.
 * 2. **The space *below* a status line is not a number this file owns.** ChatKit's layout puts one
 *    spacing between two chat items, so the space below a status line is the next row's space above.
 *    That is also why there is no `gapBelow` in the metrics: see `SystemMessageMetrics.gapAbove`.
 *    Nothing sits under the notice in the capture anyway, except its own "Report Spam" pill 10.33
 *    below, which belongs to `UnknownSenderNotice`.
 * 3. **`macos.letterSpacing`.** No macOS capture holds any line of this family, so there is no
 *    advance to fit. 0 is the untracked default, like `date-separator.tsx`'s macOS line.
 * 4. **`errorColor.ios`.** `systemRedColor` is a `UIDynamicCatalogSystemColor`: the Catalyst probe
 *    resolves it on the host, so it returned the *macOS* red (#ff383c / #ff4245) under both idioms.
 *    The iOS pair below is Apple's published iOS systemRed and is not a reading.
 *
 * ### Motion
 *
 * **UNVERIFIED**, and marked so on `systemMessageMotion`. Nothing in `references/` captures a status
 * line arriving. It is built the way the rest of the kit builds unverified motion: one Web Animations
 * animation on the row, so `document.getAnimations()` reaches it and `animateIn={{ progress }}`
 * pauses and seeks it instead of playing it. Reduced motion drops the rise and keeps the fade.
 */

export type SystemMessageMetrics = {
  /** ChatKit `transcriptRegularFontAttributes`: .SFNS-Regular 11 on both platforms. */
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  /** .SFNS-Regular, `UIFontWeightTrait` 0. */
  weight: number;
  /** .SFNS-Medium, trait 0.23 = `UIFontWeightMedium`. The actor's name, and "You". */
  emphasisWeight: number;
  /** `transcriptGroupModificationErrorRegularFontAttributes`: .SFNS-Light, trait -0.4. */
  errorWeight: number;
  errorEmphasisWeight: number;
  /**
   * `-[CKGroupActionChatItem textAlignmentInsets]` - the padding the chat item adds around its own
   * text, inside whatever the layout puts between items. Part of the line's box, not a gap.
   */
  padTop: number;
  padBottom: number;
  /**
   * The transcript layout's spacing outside the item, above it.
   *
   * There is deliberately no `gapBelow` here. ChatKit's layout puts **one** spacing between two chat
   * items, and the kit already expresses that the same way: every row `MessageList` draws carries
   * `marginTop: row.gap` and no bottom margin at all. A `gapBelow` in the metrics would be added to
   * the next row's `gapAbove`, so two consecutive status lines - a rename immediately followed by a
   * join, the commonest real case - would sit 2x apart. The `gapBelow` *prop* is still there, at 0
   * by default, for a caller that needs trailing space because nothing follows.
   */
  gapAbove: number;
  /** Inset from the pane edge, which is what wraps the sentence. Pass `edgeInset={0}` inside a list that already insets its rows. */
  inset: number;
};

export const systemMessageMetrics: Record<Platform, SystemMessageMetrics> = {
  ios: {
    // ChatKit: .SFNS-Regular 11. Confirmed by the capture's 357.0 pt line-1 advance.
    fontSize: 11,
    // Measured: 40 device rows at 3x between both baselines and both x-height tops.
    lineHeight: 13.3333,
    // Fitted against the capture, not assumed. Chrome's SF is narrower than native's over a long
    // run, so the notice needs tracking to land on the capture's 357.0 pt line. Sweeping
    // `/lab/system-message?scene=notice&ls=…` and taking the mean squared error of the whole
    // 402x40 band against `incoming-light.png`: 0.10 -> 468.6, 0.11 -> 431.5, 0.115 -> 423.9,
    // **0.12 -> 418.7**, 0.125 -> 424.6, 0.13 -> 424.1, 0.14 -> 462.9, 0.15 -> 503.1. Line 1's ink
    // then measures 356.33 against native's 357.00, and the capture's break ("…it may" / "be spam.")
    // holds from 0.08 up. The 0.1 this file used to inherit silently from `unknownSenderMetrics` was
    // close but never fitted, and never documented as measured in either file.
    letterSpacing: 0.12,
    weight: 400,
    emphasisWeight: 500,
    errorWeight: 300,
    errorEmphasisWeight: 500,
    // ChatKit `-[CKGroupActionChatItem textAlignmentInsets]` under a .phone idiom.
    padTop: 3,
    padBottom: 3,
    // Measured, notice only: 16.1667 from the bubble body's bottom to the line box top, less padTop.
    // Confirmed by the diff as well as by the geometry - sweeping the gap in `/lab/system-message`
    // and taking the band's mean squared error, 11.83 -> 779, 12.17 -> 574, 12.67 -> 520,
    // **13.0 to 13.5 -> 418.7**, 14.0 -> 742. Chrome snaps a baseline to whole CSS px, so everything
    // inside that plateau rasterises identically; 13.1667 is the value the capture's geometry gives
    // and it sits inside it.
    // UNMEASURED for the group lines - see the docstring. The notice is the closest reading we have.
    gapAbove: 13.1667,
    // Measured: 402 - 2x16 = the 370 column the notice wraps inside, to the word.
    inset: bubbleMetrics.ios.edgeInset,
  },
  macos: {
    // ChatKit, .mac idiom: transcriptRegularFontAttributes is .SFNS-Regular 11 / 13 there too. The
    // 9 pt this file used to carry was `transcriptMessageStatusFont`, the "Delivered" label, which
    // is the one transcript metric that does scale on the Mac.
    fontSize: 11,
    // ChatKit's natural line height for the font. No macOS capture holds a two-line status sentence,
    // so unlike iOS's 13.3333 this one is not confirmed against a rasterised pitch.
    lineHeight: 13,
    // UNMEASURED: no macOS capture of this family, so nothing to fit. Untracked, like the macOS date header.
    letterSpacing: 0,
    weight: 400,
    emphasisWeight: 500,
    errorWeight: 300,
    errorEmphasisWeight: 500,
    // ChatKit `-[CKGroupActionChatItem textAlignmentInsets]` under a .mac idiom. Not symmetric.
    padTop: 2.5,
    padBottom: 2,
    // UNMEASURED. Reused from the measured between-cluster gap, the way `dateSeparatorMetrics.macos`
    // reuses it: a status line is its own cluster. Less the item's own padding, so the box lands
    // where a bubble's would.
    gapAbove: bubbleMetrics.macos.gapBetweenGroups - 2.5,
    inset: bubbleMetrics.macos.edgeInset,
  },
};

/**
 * UNVERIFIED. No capture shows a status line arriving, and ChatKit exposes no duration for one.
 * Seekable by construction: one Web Animations animation on the row.
 */
export const systemMessageMotion = { duration: 260, rise: 6, reducedDuration: 160 } as const;

/**
 * Palette first, then the value measured for that platform and theme, so a bare `<SystemMessage>`
 * outside an app shell still paints the right grey. Both pairs are `UIColor.secondaryLabel`
 * resolved on that platform.
 */
const secondaryVars: Record<Platform, string> = {
  ios: "[--im-sys-label:var(--im-secondary,#8a8a8e)] dark:[--im-sys-label:var(--im-secondary,#8d8d93)]",
  macos: "[--im-sys-label:var(--im-secondary,#808080)] dark:[--im-sys-label:var(--im-secondary,#9a9a9a)]",
};

/**
 * `systemRedColor`, for the two group-edit failures. macOS is a reading (the Catalyst probe resolved
 * the catalog colour on the host); iOS is Apple's published pair and is NOT measured - see the
 * docstring's "Still unmeasured".
 */
const errorVars: Record<Platform, string> = {
  ios: "[--im-sys-error:#ff3b30] dark:[--im-sys-error:#ff453a]",
  macos: "[--im-sys-error:#ff383c] dark:[--im-sys-error:#ff4245]",
};

/**
 * ChatKit's status format strings, verbatim from `ChatKit.loctable`'s `en` table, keyed by their own
 * `.strings` keys so any one of them can be checked against the framework in a line. `#...#` wraps
 * the emphasised run; `%@` and `%n$@` are substitutions.
 */
export const statusTemplates = {
  REPORT_SPAM_STATUS: "If you did not expect this message from an unknown sender, it may be spam.",

  GROUP_NAME_STATUS: "#%1$@# named the conversation “%2$@”.",
  GROUP_YOU_NAME_STATUS: "#You# named the conversation “%@”.",
  GROUP_SYSTEM_NAME_STATUS: "The conversation was named “%1$@”.",

  GROUP_REMOVE_NAME_STATUS: "#%1$@# removed the name from the conversation.",
  GROUP_YOU_REMOVE_NAME_STATUS: "#You# removed the name from the conversation.",
  GROUP_SYSTEM_REMOVE_NAME_STATUS: "The conversation name was removed.",

  GROUP_ADD_STATUS: "#%1$@# added %2$@ to the conversation.",
  GROUP_YOU_ADD_STATUS: "#You# added %@ to the conversation.",
  GROUP_ADD_YOU_STATUS: "#%@# added you to the conversation.",
  GROUP_SYSTEM_ADD_STATUS: "#%@# was added to the conversation.",

  GROUP_REMOVE_STATUS: "#%1$@# removed %2$@ from the conversation.",
  GROUP_YOU_REMOVE_STATUS: "#You# removed %@ from the conversation.",
  GROUP_REMOVE_YOU_STATUS: "#%@# removed you from the conversation.",

  GROUP_LEAVE_STATUS: "#%@# left the conversation.",
  GROUP_YOU_LEAVE_STATUS: "#You# left the conversation.",

  GROUP_UPDATE_PHOTO_STATUS: "#%@# changed the group photo.",
  GROUP_YOU_UPDATE_PHOTO_STATUS: "#You# changed the group photo.",
  GROUP_SYSTEM_UPDATE_PHOTO_STATUS: "The group photo was changed.",

  GROUP_DELETE_PHOTO_STATUS: "#%@# removed the group photo.",
  GROUP_YOU_DELETE_PHOTO_STATUS: "#You# removed the group photo.",
  GROUP_SYSTEM_DELETE_PHOTO_STATUS: "The group photo was removed.",

  GROUP_UPDATE_BACKGROUND_STATUS: "#%@# changed the background.",
  GROUP_YOU_UPDATE_BACKGROUND_STATUS: "#You# changed the background.",
  GROUP_SYSTEM_UPDATE_BACKGROUND_STATUS: "The background was changed.",

  GROUP_DELETE_BACKGROUND_STATUS: "#%@# removed the background.",
  GROUP_YOU_DELETE_BACKGROUND_STATUS: "#You# removed the background.",
  GROUP_SYSTEM_DELETE_BACKGROUND_STATUS: "The background was removed.",

  GROUP_SUBSCRIPTION_CHANGE_STATUS: "#%1$@# changed their phone number.",

  MESSAGE_RETRACTED_BY_PERSON_STATUS: "#%@# unsent a message",
  MESSAGE_RETRACTED_BY_ME_STATUS: "#You# unsent a message",

  MESSAGE_SAVE_ACTION_STATUS: "#%1$@# kept %2$@ from %3$@.",
  MESSAGE_SAVE_YOU_ACTION_STATUS: "#%1$@# kept %2$@ from you.",
  MESSAGE_YOU_SAVE_ACTION_STATUS: "#You# kept %1$@ from %2$@.",

  // No `#...#`: the whole sentence renders in the Light red of
  // `transcriptGroupModificationErrorRegularFontAttributes`.
  GROUP_ADD_ERROR_STATUS: "%@ was not added to the conversation.",
  GROUP_REMOVE_ERROR_STATUS: "%@ was not removed from the conversation.",
} as const;

/** The one captured string, byte-identical to ChatKit's `REPORT_SPAM_STATUS`. */
export const unknownSenderText = statusTemplates.REPORT_SPAM_STATUS;

/**
 * The six tapback verbs, from `IMSharedUtilities.loctable`. **Not a transcript line**: these are the
 * notification and sidebar-preview formats, which is why they carry no emphasis. See `tapbackSummary`.
 */
export const reactionVerbs: Record<TapbackType, string> = {
  love: "loved",
  like: "liked",
  dislike: "disliked",
  laugh: "laughed at",
  emphasize: "emphasized",
  question: "questioned",
};

/**
 * `"You loved “Tuesday morning at 9?”"` / `"Alex Morgan laughed at “…”"` - the exact
 * `IMSharedUtilities` preview format, with no trailing period, for a sidebar row or a notification.
 * A tapback in a transcript is a balloon, so this is not a `SystemMessageEvent`.
 */
export function tapbackSummary(reaction: TapbackType, excerpt: string, actor?: string): string {
  return `${actor ?? "You"} ${reactionVerbs[reaction]} “${excerpt}”`;
}

/**
 * Who acted. Omit for the first person ("You", emphasised - ChatKit's `GROUP_YOU_*` strings wrap it
 * in the same `#...#` as a name); a name for anyone else; `null` for ChatKit's unattributed
 * `GROUP_SYSTEM_*` form, which names no one ("The group photo was changed.").
 *
 * Only six events have an unattributed form in ChatKit, so `null` is meaningful only on
 * `conversationNamed`, `conversationNameRemoved`, `participantAdded` (where the *participant* is the
 * one named, and is emphasised), `groupPhotoChanged`, `groupPhotoRemoved`, `backgroundChanged` and
 * `backgroundRemoved`. Anywhere else it degrades to a sentence with an empty actor.
 */
export type SystemActor = string | null | undefined;

/**
 * One thing that happened to the conversation rather than in it. Every case maps to a ChatKit format
 * string in `statusTemplates`; nothing here is invented wording.
 *
 * `participant` omitted means you, which selects ChatKit's `*_YOU_STATUS` form ("added **you**" -
 * lowercase and unemphasised, because only the actor is inside `#...#`).
 */
export type SystemMessageEvent =
  | { type: "unknownSender" }
  | { type: "conversationNamed"; actor?: SystemActor; name: string }
  | { type: "conversationNameRemoved"; actor?: SystemActor }
  | { type: "participantAdded"; actor?: SystemActor; participant?: string }
  | { type: "participantRemoved"; actor?: SystemActor; participant?: string }
  | { type: "participantLeft"; actor?: SystemActor }
  | { type: "groupPhotoChanged"; actor?: SystemActor }
  | { type: "groupPhotoRemoved"; actor?: SystemActor }
  | { type: "backgroundChanged"; actor?: SystemActor }
  | { type: "backgroundRemoved"; actor?: SystemActor }
  | { type: "messageUnsent"; actor?: SystemActor }
  | { type: "messageKept"; actor?: SystemActor; what: string; from?: string }
  | { type: "phoneNumberChanged"; actor?: SystemActor }
  | { type: "addFailed"; participant: string }
  | { type: "removeFailed"; participant: string };

/** A run of the sentence. `emphasis` is ChatKit's `#...#`, which renders at `emphasisWeight`. */
export type SystemMessageSegment = { text: string; emphasis?: boolean };

/** Only the two group-edit failures render in the Light red of the error attributes. */
export function isErrorEvent(event: SystemMessageEvent): boolean {
  return event.type === "addFailed" || event.type === "removeFailed";
}

/**
 * Splits a ChatKit template into runs on its `#...#` delimiters, then substitutes `%@` / `%n$@`
 * inside each run. Substitution happens after the split so a value that itself contains a `#`
 * (a group named "C# crew") cannot invent an emphasis boundary.
 */
export function formatTemplate(template: string, values: readonly string[] = []): SystemMessageSegment[] {
  let next = 0;
  const fill = (piece: string) =>
    piece.replace(/%(\d+)\$@|%@/g, (_match, index?: string) =>
      values[index ? Number(index) - 1 : next++] ?? "");
  return template
    .split("#")
    .map((piece, i) => ({ text: fill(piece), emphasis: i % 2 === 1 }))
    .filter(segment => segment.text.length > 0)
    .map(segment => (segment.emphasis ? segment : { text: segment.text }));
}

const T = statusTemplates;

/** Turns an event into the runs of its sentence, so the actor can render at `emphasisWeight`. */
export function formatSystemMessage(event: SystemMessageEvent): SystemMessageSegment[] {
  const actor = "actor" in event ? event.actor : undefined;
  const you = actor === undefined;
  const unattributed = actor === null;
  const name = actor ?? "";
  switch (event.type) {
    case "unknownSender":
      return formatTemplate(T.REPORT_SPAM_STATUS);
    case "conversationNamed":
      return unattributed ? formatTemplate(T.GROUP_SYSTEM_NAME_STATUS, [event.name])
        : you ? formatTemplate(T.GROUP_YOU_NAME_STATUS, [event.name])
          : formatTemplate(T.GROUP_NAME_STATUS, [name, event.name]);
    case "conversationNameRemoved":
      return unattributed ? formatTemplate(T.GROUP_SYSTEM_REMOVE_NAME_STATUS)
        : you ? formatTemplate(T.GROUP_YOU_REMOVE_NAME_STATUS)
          : formatTemplate(T.GROUP_REMOVE_NAME_STATUS, [name]);
    case "participantAdded":
      // Unattributed adds name the person added, and emphasise them; every other form emphasises
      // only the actor, so the participant stays in the regular weight.
      return unattributed ? formatTemplate(T.GROUP_SYSTEM_ADD_STATUS, [event.participant ?? ""])
        : event.participant === undefined ? formatTemplate(T.GROUP_ADD_YOU_STATUS, [name])
          : you ? formatTemplate(T.GROUP_YOU_ADD_STATUS, [event.participant])
            : formatTemplate(T.GROUP_ADD_STATUS, [name, event.participant]);
    case "participantRemoved":
      return event.participant === undefined ? formatTemplate(T.GROUP_REMOVE_YOU_STATUS, [name])
        : you ? formatTemplate(T.GROUP_YOU_REMOVE_STATUS, [event.participant])
          : formatTemplate(T.GROUP_REMOVE_STATUS, [name, event.participant]);
    case "participantLeft":
      return you ? formatTemplate(T.GROUP_YOU_LEAVE_STATUS) : formatTemplate(T.GROUP_LEAVE_STATUS, [name]);
    case "groupPhotoChanged":
      return unattributed ? formatTemplate(T.GROUP_SYSTEM_UPDATE_PHOTO_STATUS)
        : you ? formatTemplate(T.GROUP_YOU_UPDATE_PHOTO_STATUS) : formatTemplate(T.GROUP_UPDATE_PHOTO_STATUS, [name]);
    case "groupPhotoRemoved":
      return unattributed ? formatTemplate(T.GROUP_SYSTEM_DELETE_PHOTO_STATUS)
        : you ? formatTemplate(T.GROUP_YOU_DELETE_PHOTO_STATUS) : formatTemplate(T.GROUP_DELETE_PHOTO_STATUS, [name]);
    case "backgroundChanged":
      return unattributed ? formatTemplate(T.GROUP_SYSTEM_UPDATE_BACKGROUND_STATUS)
        : you ? formatTemplate(T.GROUP_YOU_UPDATE_BACKGROUND_STATUS) : formatTemplate(T.GROUP_UPDATE_BACKGROUND_STATUS, [name]);
    case "backgroundRemoved":
      return unattributed ? formatTemplate(T.GROUP_SYSTEM_DELETE_BACKGROUND_STATUS)
        : you ? formatTemplate(T.GROUP_YOU_DELETE_BACKGROUND_STATUS) : formatTemplate(T.GROUP_DELETE_BACKGROUND_STATUS, [name]);
    case "messageUnsent":
      return you ? formatTemplate(T.MESSAGE_RETRACTED_BY_ME_STATUS) : formatTemplate(T.MESSAGE_RETRACTED_BY_PERSON_STATUS, [name]);
    case "phoneNumberChanged":
      return formatTemplate(T.GROUP_SUBSCRIPTION_CHANGE_STATUS, [you ? "You" : name]);
    case "messageKept":
      return you ? formatTemplate(T.MESSAGE_YOU_SAVE_ACTION_STATUS, [event.what, event.from ?? "you"])
        : event.from === undefined ? formatTemplate(T.MESSAGE_SAVE_YOU_ACTION_STATUS, [name, event.what])
          : formatTemplate(T.MESSAGE_SAVE_ACTION_STATUS, [name, event.what, event.from]);
    case "addFailed":
      return formatTemplate(T.GROUP_ADD_ERROR_STATUS, [event.participant]);
    case "removeFailed":
      return formatTemplate(T.GROUP_REMOVE_ERROR_STATUS, [event.participant]);
  }
}

/** The same sentence as one string, for a sidebar preview, an aria label, or a test. */
export function systemMessageText(event: SystemMessageEvent): string {
  return formatSystemMessage(event).map(segment => segment.text).join("");
}

/** Same reading as the rest of the kit's; repeated because `message-motion` is not a dependency here. */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type SystemMessageProps = Omit<ComponentProps<"div">, "children"> & {
  /** The event to describe. Omit and pass `children` to render your own sentence in this style. */
  event?: SystemMessageEvent;
  platform?: Platform;
  /**
   * Override the layout's spacing above, e.g. to close the line up against a date header. Inside
   * `MessageList` pass the row's own gap here, the way every other row gets `marginTop: row.gap`.
   */
  gapAbove?: number;
  /**
   * Trailing space. **0 by default**, because whatever follows supplies its own space above; see
   * `SystemMessageMetrics.gapAbove`. Set it only when this line is the last thing in its container.
   */
  gapBelow?: number;
  /**
   * How far the line is held off the pane edge, which is what wraps it. Defaults to the platform's
   * edge inset. **Pass 0 inside `MessageList`**, whose content box already applies that inset:
   * two of them narrow the iOS column from 370 to 338 and rewrap the sentence.
   */
  edgeInset?: number;
  /** Cap the wrapped column directly, instead of letting `edgeInset` do it. */
  maxWidth?: number;
  /**
   * Play the arrival. `true` plays it; `{ progress }` (0..1) pauses and seeks it, which is what makes
   * a scenario checkpoint reproducible. UNVERIFIED motion - see `systemMessageMotion`.
   */
  animateIn?: boolean | { progress?: number };
  children?: ReactNode;
};

export function SystemMessage({
  event, platform: platformProp, gapAbove, gapBelow, edgeInset, maxWidth, animateIn, children, className, style, ...props
}: SystemMessageProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const m = systemMessageMetrics[platform];
  const segments = event ? formatSystemMessage(event) : undefined;
  const error = event ? isErrorEvent(event) : false;
  const row = useRef<HTMLDivElement>(null);

  const play = animateIn === true || (typeof animateIn === "object" && animateIn !== null);
  const progress = typeof animateIn === "object" && animateIn !== null ? animateIn.progress : undefined;
  useLayoutEffect(() => {
    const el = row.current;
    if (!el || !play) return;
    const M = systemMessageMotion;
    const reduced = prefersReducedMotion();
    const duration = reduced ? M.reducedDuration : M.duration;
    const frames: Keyframe[] = reduced
      ? [{ offset: 0, opacity: 0 }, { offset: 1, opacity: 1 }]
      : [
        { offset: 0, opacity: 0, transform: `translateY(${M.rise}px)`, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
        { offset: 1, opacity: 1, transform: "translateY(0)" },
      ];
    const animation = el.animate(frames, { duration, fill: "both", easing: "linear" });
    if (progress === undefined) {
      void animation.finished.then(() => animation.cancel()).catch(() => { /* superseded */ });
    } else {
      animation.pause();
      animation.currentTime = Math.max(0, Math.min(1, progress)) * duration;
    }
    return () => animation.cancel();
  }, [play, progress]);

  return (
    <div
      ref={row}
      data-slot="system-message"
      data-platform={platform}
      data-kind={event?.type}
      data-error={error ? "true" : undefined}
      role="note"
      // `-[CKGroupActionChatItem hasSelectableText]` is NO on both idioms: Messages does not let a
      // status line into a text selection, so neither does this.
      className={cn("flex w-full select-none flex-col items-center", secondaryVars[platform], errorVars[platform], className)}
      style={{
        fontFamily: fontStack,
        // The inset is what wraps the sentence, so it has to come out of the full width even where
        // the host has no global reset: without this the column is 402 wide inside a 402 frame and
        // the measured 370 wrap becomes an overflow.
        boxSizing: "border-box",
        marginTop: gapAbove ?? m.gapAbove,
        marginBottom: gapBelow ?? 0,
        paddingTop: m.padTop,
        paddingBottom: m.padBottom,
        paddingInline: edgeInset ?? m.inset,
        ...style,
      }}
      {...props}
    >
      <p
        data-slot="system-message-text"
        className="m-0 text-center"
        style={{
          maxWidth,
          fontSize: m.fontSize,
          lineHeight: `${m.lineHeight}px`,
          fontWeight: error ? m.errorWeight : m.weight,
          letterSpacing: m.letterSpacing,
          color: error ? "var(--im-sys-error)" : "var(--im-sys-label)",
        }}
      >
        {segments
          ? segments.map((segment, index) =>
              segment.emphasis ? (
                <strong key={`${index}-${segment.text}`} style={{ fontWeight: error ? m.errorEmphasisWeight : m.emphasisWeight }}>
                  {segment.text}
                </strong>
              ) : (
                <span key={`${index}-${segment.text}`}>{segment.text}</span>
              ),
            )
          : children}
      </p>
    </div>
  );
}
