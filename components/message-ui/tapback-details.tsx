"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/message-ui/avatar";
import { usePlatform, type Platform } from "@/components/message-ui/platform";
import { TapbackGlyph, tapbackLabels, type TapbackType } from "@/components/message-ui/tapback";
import { fontStack } from "@/components/message-ui/tokens";

/**
 * The **Tapback Details platter**: the horizontal list of who reacted, with one tally per reaction
 * kind across the front, presented when you tap a tapback badge or pick "Tapback Details…".
 *
 * **NO CAPTURE OF THIS PLATTER EXISTS**, on either platform, so nothing below was read off a frame of
 * it. It is built from ChatKit 26.5 — the framework macOS Messages is a Catalyst app of — read out of
 * the live runtime on 2026-09-08 with a Mac Catalyst probe (`clang -target arm64-apple-ios26.0-macabi`,
 * `dlopen` of `/System/iOSSupport/System/Library/PrivateFrameworks/ChatKit.framework/ChatKit`, swizzle
 * `-[UIDevice userInterfaceIdiom]`, then `objc_msgSend` on the getters named below), cross-checked
 * against the on-disk simulator copy of the same framework
 * (`…/iOS 26.0.simruntime/Contents/Resources/RuntimeRoot/…/ChatKit.framework/ChatKit`, whose symbol
 * table is intact and disassembles). Every value states its selector.
 *
 * ChatKit calls it the **voting view**: `-[CKUIBehavior messageAcknowledgementVotingViewHeight]` and
 * its two neighbours size the platter, and the Swift type `ChatKit.StyleSupport` carries the interior
 * as class constants (`+votingViewCellWidth` and the rest). Its strings are ChatKit's own, from
 * `ChatKit.framework/Resources/ChatKit.loctable` (`en`): `TAPBACK_DETAILS_ELLIPSIS` = "Tapback
 * Details…" is the menu row, `TAPBACK_DETAILS` = "Tapback Details" the title,
 * `ACCESSIBILITY_TAPBACK_LABEL` = "%@ reacted with %@" the cell,
 * `ACCESSIBILITY_EXPANDED_TAPBACK_FORMAT` = "%lu %@ reactions from %@" the tally,
 * `ACCESSIBILITY_TAPBACK_OVERFLOW_STRING` = "Others" the tail of a long name list, and
 * `REMOVE_TAPBACK_INTENT_TITLE` = "Remove Tapback" the action on your own cell.
 *
 * **Mac numbers are ChatKit's Mac numbers, 1:1. There is no Catalyst point scale.** An earlier version
 * of this file multiplied every macOS value by 0.77; that was wrong and the repo's own captures
 * falsify it three times over. `StyleSupport`'s constants are idiom-independent (one value, both
 * platforms); only `CKUIBehavior` differs by idiom, and its idiom pairs land on measured captures with
 * no scaling at all: `conversationListContactImageDiameter` 45 Phone / 40 Mac against SPEC's measured
 * Ø45 iOS row avatar and Ø40 macOS sidebar avatar; `conversationListSummaryFont` 15 / 12 against
 * SPEC's 15pt iOS preview and 12pt macOS preview; `balloonTextFont` 17 / 13 against SPEC's 17pt iOS
 * bubble text and 13pt macOS bubble text.
 *
 * **The layout is a horizontal platter, not a table.** `votingViewPlatterCornerRadius` = 34 round (all
 * but a capsule at `messageAcknowledgementVotingViewHeight` 72 iOS / 80 Mac), holding one
 * `votingViewCellWidth` = 64 wide cell per reactor: a `votingViewAvatarDiameter` = 44 avatar badged
 * with the reaction in a `votingViewAvatarViewGlyphFrame` 20 square, then
 * `votingViewAvatarToTextSpacing` = 4 and a `votingViewAvatarViewLabelHeight` = 18 name. One
 * `votingViewExpandedTally` 27 square per reaction kind leads the row with its count beside it
 * (`votingViewTallyLabelSpacing` = 0), and a close button trails everything at
 * `votingViewCloseButtonLeftPadding` = 22. `votingViewAdditionalTopInset` = 4 tops the content, which
 * with 4 + 44 + 4 + 18 = 70 fits the 72 iOS height with 2 to spare (10 on Mac's 80; ChatKit does not
 * say where that slack goes, so the content is top-aligned and it falls at the bottom).
 *
 * **The glyphs are glyphs, not balloons.** ChatKit names a balloon a balloon everywhere else
 * (`messageAcknowledgmentTranscriptBalloonSize`, `aggregateAcknowledgmentTranscriptBalloonSize`,
 * `messageAcknowledgmentPickerBarAcknowledgmentItemBalloonSize`); here it names a *glyph frame* and a
 * *tally*, so the badge and the tally draw the bare artwork with no circle behind it. What fills such
 * a frame comes from ChatKit's own balloon-to-glyph arithmetic checked against this repo's measured
 * ink, in `tapbackGlyphInk` below.
 *
 * **Presentation.** `-[CKChatController(ClickyOrbConformance) _votingViewForChatItem:containingViewController:]`
 * builds a `CKAttributionViewAccessoryView` sized `attributionViewHeight` = 132 by the safe layout
 * frame's width less the system layout margins, and `-[CKFullScreenBalloonViewControllerPhone
 * votingViewTargetFrame]` places it at x = the leading margin, y = `max(attributionViewMinPadding = 6,
 * the tapback's own frame origin y)` — i.e. **an overlay anchored near the top of the transcript at the
 * message, not a bottom sheet**. The platter itself shrink-wraps inside that box up to
 * `messageAcknowledgementVotingViewMaxWidth` (400 iOS / 500 Mac) and keeps
 * `messageAcknowledgementVotingViewMinPadding` (8 iOS / 6 Mac) from the presenting edge.
 *
 * **What is JUDGEMENT, and is marked so below:** the close button's size (ChatKit gives it a left
 * padding and no size), where the 20 square badge sits on the avatar vertically, whether
 * `votingViewItemSpacing` applies between cells as well as between tallies, the presentation's
 * durations and curves, and the filter behaviour of the tallies.
 *
 * Not to be confused with `message-actions.tsx`'s `TapbackDetails`, which is the *collapsed* form of
 * the same ChatKit view family and **is** captured: `CKTapbackAttributionView`, the 124 × 121 glass
 * card with a balloon over the reactor's avatar that floats above a long-pressed message you have
 * already reacted to (`references/ios/captures/longpress-ok-selected-{light,dark}.png`). That file
 * owns the name `tapbackDetailsMetrics` and the slot `data-slot="tapback-details"`; everything here is
 * named `…Platter` and slotted `tapback-details-platter` so the two never collide in one overlay.
 */

export type TapbackDetailsPlatterMetrics = {
  /** `-[CKUIBehavior messageAcknowledgementVotingViewHeight]`: 72 iOS, 80 Mac. */
  height: number;
  /** `+[ChatKit.StyleSupport votingViewPlatterCornerRadius]` = 34, both platforms. */
  radius: number;
  /** `+votingViewHorizontalPadding` = 24, both platforms. */
  paddingX: number;
  /** `+votingViewItemSpacing` = 24, both platforms. */
  itemSpacing: number;
  /** `+votingViewAdditionalTopInset` = 4, both platforms. */
  topInset: number;
  /** `-[CKUIBehavior messageAcknowledgementVotingViewMaxWidth]`: 400 iOS, 500 Mac. */
  maxWidth: number;
  /** `-messageAcknowledgementVotingViewMinPadding`: 8 iOS, 6 Mac, from the presenting edge. */
  minPadding: number;
  /** `+votingViewCellWidth` = 64, both platforms. */
  cellWidth: number;
  /** `+votingViewAvatarDiameter` = 44, both platforms. */
  avatar: number;
  /** `+votingViewAvatarViewGlyphFrameWidth` and `…Height`, both 20, both platforms. */
  glyphFrame: number;
  /** `+votingViewAvatarToTextSpacing` = 4, both platforms. */
  avatarToText: number;
  /** `+votingViewAvatarViewLabelHeight` = 18, both platforms. */
  labelHeight: number;
  /** `-[CKUIBehavior avatarNameFont]`: SFNS Regular 12 iOS, 16 Mac. */
  nameFontSize: number;
  /** `-[CKUIBehavior messageAcknowledgmentVoteCountFont]`: SFNS Regular 12 iOS, 16 Mac. */
  countFontSize: number;
  /** `+votingViewExpandedTallyWidth` and `…Height`, both 27, both platforms. */
  tally: number;
  /** `+votingViewTallyLabelSpacing` = 0, between a tally's glyph frame and its count. */
  tallyLabelSpacing: number;
  /** `+votingViewBlurWidth` = 88: how far the platter fades its scrolling content at an overflowing end. */
  blurWidth: number;
  /** `+votingViewCloseButtonLeftPadding` = 22, both platforms. */
  closeLeftPadding: number;
  /** JUDGEMENT: ChatKit gives the close button a left padding and no size, so it takes the tally's box. */
  closeSize: number;
  /** `-[CKUIBehavior messageAcknowledgmentVotingStackSize]` = 4, both platforms: how many names a tally reads out before "Others". */
  stackSize: number;
  /**
   * The measured share of a ChatKit glyph frame that the artwork's ink actually fills. ChatKit draws a
   * classic tapback as an image inset inside its frame, so a 27 frame is not 27 of ink.
   *
   * iOS: `-[CKUIBehavior messageAcknowledgmentTranscriptBalloonSize]` = 36 with
   * `messageAcknowledgmentTranscriptGlyphInset` = 4 all round gives a 28 glyph frame, and the heart's
   * ink in that balloon measures 18.34 on `references/ios/captures/tapback-love-light.png` →
   * 18.34 / 28 = 0.6550.
   *
   * macOS: the same pair is 29 and 3, giving a 23 frame, and the heart's ink measures 14.64 on
   * `references/macos/captures/tapback-love-{light,dark}-2x.png` → 14.64 / 23 = 0.6365. ChatKit's 29
   * and the capture agree independently: the measured circle is Ø27.98 and the measured knockout rim
   * is 0.51 a side, and 27.98 + 2 × 0.51 = 29.00 exactly. (The iOS pair agrees the same way, 34.0 +
   * 2 × 1.0 = 36.)
   */
  glyphInk: number;
};

const styleSupport = {
  // +[ChatKit.StyleSupport …], read at idiom 0 and idiom 5 and identical at both.
  radius: 34, paddingX: 24, itemSpacing: 24, topInset: 4,
  cellWidth: 64, avatar: 44, glyphFrame: 20, avatarToText: 4, labelHeight: 18,
  tally: 27, tallyLabelSpacing: 0, blurWidth: 88, closeLeftPadding: 22,
  /** JUDGEMENT, and unmeasured: the tally's own box is the only other 1:1 square in the platter. */
  closeSize: 27,
  /** -[CKUIBehavior messageAcknowledgmentVotingStackSize] = 4 on both idioms. */
  stackSize: 4,
} as const;

export const tapbackDetailsPlatterMetrics: Record<Platform, TapbackDetailsPlatterMetrics> = {
  ios: { ...styleSupport, height: 72, maxWidth: 400, minPadding: 8, nameFontSize: 12, countFontSize: 12, glyphInk: 0.655 },
  macos: { ...styleSupport, height: 80, maxWidth: 500, minPadding: 6, nameFontSize: 16, countFontSize: 16, glyphInk: 0.6365 },
};

/** The ink `TapbackGlyph` should draw to fill a ChatKit glyph frame of `frame` points. */
export function tapbackGlyphInk(platform: Platform, frame: number): number {
  return Number((frame * tapbackDetailsPlatterMetrics[platform].glyphInk).toFixed(4));
}

/**
 * The presentation. **All JUDGEMENT**, borrowed from motion this kit has already measured rather than
 * invented: the platter is presented by the same `CKFullScreenBalloonViewController` overlay as the
 * long press, so it takes that overlay's own entrance and its measured `messageActionsTiming.exit` of
 * 220 ms, with the spring `message-actions.tsx` uses for the sibling attribution card.
 *
 * ChatKit's own numbers here are recorded and not used: `-[CKUIBehavior tapbackDismissalDuration]`
 * = 0.5 s belongs to the picker, and `+[ChatKit.StyleSupport tapbackStartingScaleX]` / `…ScaleY`
 * = 0.3 is the balloon's pop-in scale, which `tapback.tsx`'s `tapbackAppear` already owns.
 */
export const tapbackDetailsPlatterMotion = {
  enter: 200,
  exit: 220,
  /** The spring `message-actions.tsx` runs its whole long-press entrance on. */
  ease: "cubic-bezier(0.2, 0.95, 0.3, 1)",
  /** `messageActionsTiming.exit`'s own curve. */
  exitEase: "cubic-bezier(0.4, 0, 1, 1)",
  /** The card's entrance pose in `message-actions.tsx`, which this platter shares. */
  from: { opacity: 0, transform: "translateY(-8px) scale(0.9)" } as Keyframe,
  to: { opacity: 1, transform: "translateY(0px) scale(1)" } as Keyframe,
  /** The dismissal pose `message-actions.tsx` folds every accessory back to. */
  exitTo: { opacity: 0, transform: "scale(0.72)" } as Keyframe,
  /** ChatKit's `-[CKUIBehavior tapbackDismissalDuration]` in ms. Recorded, not used; see above. */
  frameworkDismissal: 500,
  /** ChatKit's `+[ChatKit.StyleSupport tapbackStartingScaleX/Y]`. Recorded, not used; see above. */
  frameworkStartingScale: 0.3,
} as const;

/**
 * Theme tokens. They ride a `<style>` element, **not** an inline `style` object: an inline declaration
 * beats any non-`!important` author rule, custom properties included, so light values spread inline
 * would make every dark override dead. The dark selector mirrors `app/globals.css`'s own `dark`
 * variant, `:where(.dark, .dark *)` minus a `[data-preview-theme="light"]` subtree, and both rules sit
 * in this one stylesheet so source order settles the tie.
 *
 * The platter's glass is the glass `tapback.tsx` solved from `references/ios/captures/longpress-*.png`
 * (`--im-glass` over `--im-glass-filter`, with `--im-glass-solid` behind it, plus its rim and shadow),
 * reached through the same variables `tapback-bar.tsx` and `context-menu.tsx` read, so a host that has
 * spread `tapbackVars` gets the measured values and a standalone install gets the measured light ones.
 *
 * `--im-td-label` is `-[CKUITheme messageAcknowledgmentVotingTextColor]`, which returns
 * rgba(0,0,0,0.498) / rgba(255,255,255,0.549) — byte-identical to `+[UIColor secondaryLabelColor]`
 * resolved in the same process, i.e. it *is* secondaryLabel. Under Catalyst that resolves to the macOS
 * values, so macOS keeps them and iOS uses iOS's own secondaryLabel, rgba(60,60,67,0.6) /
 * rgba(235,235,245,0.6) (the values `system-message.tsx` already records). `sticker-picker.tsx`
 * documents this exact Catalyst trap.
 *
 * `--im-td-fill` (the close button, the selected tally, the pressed cell) is the iOS system fill
 * measured as the segmented-control track on `effects-picker-light.png` in `ios-effects-picker.tsx`.
 * The dim behind the iOS overlay is `--im-dim`, the 21% measured for the long-press overlay.
 */
const platterTokens = `
[data-slot="tapback-details-platter"]{
  --im-td-platter: var(--im-glass, rgba(229,229,231,0.69));
  --im-td-platter-filter: var(--im-glass-filter, blur(9px) brightness(1.32) saturate(1.35));
  --im-td-platter-solid: var(--im-glass-solid, #ededef);
  --im-td-rim: var(--im-glass-rim, rgba(255,255,255,0.55));
  --im-td-shadow: var(--im-glass-shadow, 0 6px 24px rgba(0,0,0,0.10));
  --im-td-label: rgba(60,60,67,0.6);
  --im-td-fill: rgba(120,120,128,0.16);
}
[data-slot="tapback-details-platter"][data-platform="macos"]{ --im-td-label: rgba(0,0,0,0.498); }
[data-slot="tapback-details-platter"]:where(.dark, .dark *):not(:where([data-preview-theme="light"], [data-preview-theme="light"] *)){
  --im-td-platter: var(--im-glass, rgba(38,37,39,0.8));
  --im-td-platter-filter: var(--im-glass-filter, blur(9px) saturate(1.6));
  --im-td-platter-solid: var(--im-glass-solid, #1f1e21);
  --im-td-rim: var(--im-glass-rim, rgba(255,255,255,0.10));
  --im-td-shadow: var(--im-glass-shadow, 0 6px 24px rgba(0,0,0,0.5));
  --im-td-label: rgba(235,235,245,0.6);
  --im-td-fill: rgba(120,120,128,0.24);
}
[data-slot="tapback-details-platter"][data-platform="macos"]:where(.dark, .dark *):not(:where([data-preview-theme="light"], [data-preview-theme="light"] *)){ --im-td-label: rgba(255,255,255,0.549); }
[data-slot="tapback-details-scrim"]{ background: var(--im-dim, rgba(22,18,44,0.21)); }
[data-slot="tapback-details-platter"] [data-slot="tapback-details-fill"]{ opacity: 0; transition: opacity 80ms linear }
[data-slot="tapback-details-platter"][data-state="open"] [data-slot="tapback-details-item"]:hover [data-slot="tapback-details-fill"]{ opacity: 1 }
[data-slot="tapback-details-platter"] [data-slot="tapback-details-item"]:focus-visible [data-slot="tapback-details-fill"]{ opacity: 1 }
[data-slot="tapback-details-platter"] [data-slot="tapback-details-item"]:active [data-slot="tapback-details-fill"]{ opacity: 1 }
[data-slot="tapback-details-platter"] [data-slot="tapback-details-item"][aria-pressed="true"] [data-slot="tapback-details-fill"]{ opacity: 1 }
[data-slot="tapback-details-scroller"]::-webkit-scrollbar{ display: none }
@media (prefers-reduced-motion: reduce){ [data-slot="tapback-details-platter"] [data-slot="tapback-details-fill"]{ transition: none } }
`;

/** Which corner of the platter its entrance grows out of. */
const transformOrigins: Record<"top-left" | "top-right" | "bottom-left" | "bottom-right" | "top" | "bottom", string> = {
  "top-left": "0% 0%",
  "top-right": "100% 0%",
  "bottom-left": "0% 100%",
  "bottom-right": "100% 100%",
  top: "50% 0%",
  bottom: "50% 100%",
};

export type TapbackReactor = {
  id: string;
  /** Full name, used for the accessible text. The cell truncates it to one line. */
  name: string;
  /** What the 64 wide cell shows under the avatar; the first word of `name` when absent. */
  shortName?: string;
  /** One or two letters for the avatar; derived from `name` when absent. */
  initials?: string;
  /** A photo instead of initials. */
  avatar?: string;
  /** One of the six classics. Ignored when `emoji` is set. */
  reaction?: TapbackType;
  /** A custom emoji reaction. */
  emoji?: string;
  /** Your own reaction: the one cell that can be activated to take it back. */
  own?: boolean;
};

export type TapbackDetailsPlatterProps = Omit<ComponentProps<"div">, "children" | "onSelect"> & {
  reactors: TapbackReactor[];
  platform?: Platform;
  /** Called when your own cell is activated. ChatKit's own name for this action is "Remove Tapback". */
  onRemove?: (reactor: TapbackReactor) => void;
  /** Dismiss: Escape, the close button, the iOS scrim, or a click outside the macOS platter. */
  onClose?: () => void;
  /**
   * Which reaction kind the tallies are filtering to, as `reactionKeyOf` returns it, or null for all.
   * Leave undefined to let the platter hold the filter itself.
   */
  filter?: string | null;
  onFilterChange?: (key: string | null) => void;
  /** False plays the dismissal; the platter stays mounted until it is over, then calls `onExited`. */
  open?: boolean;
  onExited?: () => void;
  /**
   * Seek the presentation to this fraction (0..1) instead of playing it, which is what the harness
   * does. It seeks whichever direction `open` selects, and a seeked dismissal never fires `onExited`:
   * scrubbing a timeline is not a dismissal, and a checkpoint has to land on the same frame every run.
   */
  progress?: number;
  /**
   * Where the platter's box sits in the containing block. ChatKit's own placement is x = the leading
   * layout margin and y = max(minPadding, the tapback's own frame origin y); pass the message's own
   * top as `top` to reproduce it. Defaults to `minPadding` from the top.
   */
  left?: number;
  top?: number;
  origin?: keyof typeof transformOrigins;
  /** iOS: render the dimming scrim and trap focus. macOS anchors without one. */
  modal?: boolean;
  /** Move focus into the platter when it opens (keyboard users). */
  autoFocus?: boolean;
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

const reducedMotionQuery = () => (typeof window === "undefined" ? null : window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null);
function subscribeReducedMotion(onChange: () => void) {
  const query = reducedMotionQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}
/** `macos-plus-menu.tsx` has the same hook; this file keeps its own copy so it installs on its own. */
function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, () => reducedMotionQuery()?.matches ?? false, () => false);
}

function initialsOf(reactor: TapbackReactor) {
  if (reactor.initials) return reactor.initials;
  return reactor.name.trim().split(/\s+/).slice(0, 2).map(part => part[0] ?? "").join("").toUpperCase();
}

/** The identity a tally groups on, and the value `filter` takes. */
export function reactionKeyOf(reactor: TapbackReactor) {
  return reactor.emoji ? `emoji:${reactor.emoji}` : `type:${reactor.reaction ?? "love"}`;
}

function reactionName(reactor: TapbackReactor) {
  return reactor.emoji ?? tapbackLabels[reactor.reaction ?? "love"];
}

/**
 * JUDGEMENT: the cell shows a first name. ChatKit sizes the label at `votingViewCellWidth` 64 with
 * `avatarNameFont` at 12, which fits a first name and truncates almost every full one; native avatar
 * stacks label themselves the same way. The whole name stays in the accessible text, and a caller
 * with a better short form passes `shortName`.
 */
function shortNameOf(reactor: TapbackReactor) {
  return reactor.shortName ?? reactor.name.trim().split(/\s+/)[0] ?? reactor.name;
}

/**
 * ChatKit's `ACCESSIBILITY_EXPANDED_TAPBACK_FORMAT` reads "%lu %@ reactions from %@". The name list
 * runs to `messageAcknowledgmentVotingStackSize` = 4 and then takes ChatKit's own
 * `ACCESSIBILITY_TAPBACK_OVERFLOW_STRING` = "Others".
 */
function namesFor(names: string[], stackSize: number) {
  return names.length <= stackSize ? names.join(", ") : `${names.slice(0, stackSize).join(", ")}, Others`;
}

type Tally = { key: string; reactor: TapbackReactor; count: number; names: string[] };

export function TapbackDetailsPlatter({
  reactors, platform: platformProp, onRemove, onClose, filter, onFilterChange,
  open = true, onExited, progress, left, top, origin, modal: modalProp, autoFocus = false,
  className, style, ...props
}: TapbackDetailsPlatterProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const m = tapbackDetailsPlatterMetrics[platform];
  const t = tapbackDetailsPlatterMotion;
  const modal = modalProp ?? platform === "ios";
  const id = useId().replace(/:/g, "");
  const reduced = usePrefersReducedMotion();
  const platter = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  /**
   * The dismissal is derived DURING RENDER, not in an effect: an effect leaves one committed frame
   * with the platter already unmounted and the exit never gets to run. `macos-plus-menu.tsx` and
   * `ios-details.tsx` derive theirs the same way.
   */
  const [seenOpen, setSeenOpen] = useState(open);
  const [shown, setShown] = useState(open);
  const [settled, setSettled] = useState(open && reduced);
  if (seenOpen !== open) {
    setSeenOpen(open);
    if (open) { setShown(true); setSettled(reduced); }
    // Under reduced motion there is no dismissal to wait for, so it goes in the same frame.
    else if (reduced) setShown(false);
  }
  const closing = shown && !open;
  const state = closing ? "closing" : reduced || settled || (progress !== undefined && clamp01(progress) === 1) ? "open" : "entering";

  // The filter is the caller's when they pass one, and the platter's own otherwise.
  const [ownFilter, setOwnFilter] = useState<string | null>(null);
  const selected = filter === undefined ? ownFilter : filter;
  const setFilter = useCallback((key: string | null) => {
    if (filter === undefined) setOwnFilter(key);
    onFilterChange?.(key);
  }, [filter, onFilterChange]);

  const exited = useRef(onExited);
  const close = useRef(onClose);
  useEffect(() => { exited.current = onExited; close.current = onClose; });

  // One place fires `onExited`, whether the platter left on its animation or under reduced motion.
  const wasShown = useRef(shown);
  useEffect(() => {
    if (wasShown.current && !shown) exited.current?.();
    wasShown.current = shown;
  }, [shown]);

  /**
   * Web Animations, not a transition or a rAF loop, so `document.getAnimations()` can reach the
   * timeline and a `progress` frame is a seek rather than a replay. Both platforms use the same pose:
   * ChatKit presents one platter and the host controller places it.
   */
  useEffect(() => {
    const element = platter.current;
    if (!element || !shown || reduced) return;
    const animation = open
      ? element.animate([t.from, t.to], { duration: t.enter, easing: t.ease, fill: "both" })
      : element.animate([t.to, t.exitTo], { duration: t.exit, easing: t.exitEase, fill: "both" });
    if (progress !== undefined) {
      // Seeked, not played: a scrubbed checkpoint has to land on the same frame every run.
      animation.pause();
      try { animation.currentTime = clamp01(progress) * (open ? t.enter : t.exit); } catch { /* no timeline yet */ }
      return () => animation.cancel();
    }
    const done = () => (open ? setSettled(true) : setShown(false));
    animation.addEventListener("finish", done);
    return () => {
      animation.removeEventListener("finish", done);
      // Reopened mid-dismissal: drop the fold so it cannot hold a stale pose under the entrance.
      if (animation.playState !== "finished") animation.cancel();
    };
  }, [shown, open, progress, reduced, t.enter, t.exit, t.ease, t.exitEase, t.from, t.to, t.exitTo]);

  // The scrim rides the same timeline, so a scrubbed frame is consistent with the platter's.
  useEffect(() => {
    const element = scrim.current;
    if (!element || !shown || reduced) return;
    const animation = open
      ? element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: t.enter, easing: "ease-out", fill: "both" })
      : element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: t.exit, easing: "ease-out", fill: "both" });
    if (progress !== undefined) {
      animation.pause();
      try { animation.currentTime = clamp01(progress) * (open ? t.enter : t.exit); } catch { /* no timeline yet */ }
    }
    return () => { try { animation.cancel(); } catch { /* already gone */ } };
  }, [shown, open, progress, reduced, t.enter, t.exit]);

  // Escape from wherever focus is, and outside a non-modal (macOS) platter, a click anywhere else.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !close.current) return;
      event.preventDefault();
      close.current();
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node | null;
      if (modal || !close.current || !target || platter.current?.contains(target)) return;
      // The control that opened it owns the toggle; closing here would let its own click reopen it.
      if (target instanceof Element && target.closest('[aria-haspopup="dialog"]')) return;
      close.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, modal]);

  /**
   * A modal platter keeps Tab inside it. There is no `inert` to hand out here (the platter does not
   * own its siblings), so the trap is the cycle itself, which is what makes `aria-modal` honest.
   */
  useEffect(() => {
    if (!open || !modal) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const box = platter.current;
      if (!box) return;
      const stops = Array.from(box.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (stops.length === 0) return;
      const first = stops[0], last = stops[stops.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !box.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !box.contains(active))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, modal]);

  useEffect(() => {
    // A scrubbed entrance must not move the caret: the harness seeks frames, it does not open dialogs.
    if (!open || !autoFocus || progress !== undefined) return;
    platter.current?.querySelector<HTMLElement>('[data-slot="tapback-details-item"], button')?.focus({ preventScroll: true });
  }, [open, autoFocus, progress]);

  /**
   * ChatKit fades the platter's content over `votingViewBlurWidth` at an end that has content beyond
   * it, which is a scroll position, not a layout constant: a ramp at an end you are already at hides
   * content for nothing. Both ends are tracked, and the mask carries only the ones that are live.
   */
  const [edges, setEdges] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    const hidden = node.scrollWidth - node.clientWidth;
    const next = { start: node.scrollLeft > 0.5, end: hidden > 0.5 && node.scrollLeft < hidden - 0.5 };
    setEdges(current => (current.start === next.start && current.end === next.end ? current : next));
  }, []);
  useLayoutEffect(() => {
    measure();
    const node = scroller.current;
    if (!node) return;
    node.addEventListener("scroll", measure, { passive: true });
    if (typeof ResizeObserver === "undefined") return () => node.removeEventListener("scroll", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => { node.removeEventListener("scroll", measure); observer.disconnect(); };
  }, [measure, reactors.length, selected]);

  /**
   * One roving tab stop across the whole row, arrows between items, and every move scrolls its item
   * back into view: a focused cell that has scrolled off the platter is a focus you cannot see.
   */
  const [focusIndex, setFocusIndex] = useState(0);
  const onRowKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-slot="tapback-details-item"]'));
    if (items.length === 0) return;
    const at = Math.max(0, items.findIndex(item => item === document.activeElement));
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : event.key === "ArrowRight" ? Math.min(items.length - 1, at + 1)
      : Math.max(0, at - 1);
    event.preventDefault();
    setFocusIndex(next);
    items[next]?.focus({ preventScroll: true });
    items[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  if (!shown || reactors.length === 0) return null;

  // Tallies keep first-appearance order, and a filter narrows the cells without changing the tallies.
  const tallies: Tally[] = [];
  for (const reactor of reactors) {
    const key = reactionKeyOf(reactor);
    const found = tallies.find(entry => entry.key === key);
    if (found) { found.count += 1; found.names.push(reactor.name); }
    else tallies.push({ key, reactor, count: 1, names: [reactor.name] });
  }
  const shownReactors = selected ? reactors.filter(reactor => reactionKeyOf(reactor) === selected) : reactors;

  // One tab stop for the row; every other item is reachable with the arrows. A tally is at its own
  // index and a cell at `tallies.length` plus its own, so the row is one flat sequence.
  const stopAt = Math.min(focusIndex, tallies.length + shownReactors.length - 1);
  const tabIndexFor = (index: number) => (index === stopAt ? 0 : -1);

  const badgeInk = tapbackGlyphInk(platform, m.glyphFrame);
  const tallyInk = tapbackGlyphInk(platform, m.tally);
  const ramp = [
    `transparent 0`,
    `#000 ${edges.start ? m.blurWidth : 0}px`,
    `#000 calc(100% - ${edges.end ? m.blurWidth : 0}px)`,
    `transparent 100%`,
  ].join(", ");
  const fade = edges.start || edges.end ? `linear-gradient(to right, ${ramp})` : undefined;

  const itemBase: CSSProperties = {
    position: "relative", border: 0, background: "transparent", padding: 0, margin: 0,
    cursor: "default", font: "inherit", color: "inherit", outlineOffset: -2,
    display: "inline-flex", alignItems: "flex-start", flex: "0 0 auto",
  };

  /**
   * The tally: ChatKit's `votingViewExpandedTally` 27 square with its count beside it at
   * `votingViewTallyLabelSpacing` 0. JUDGEMENT: it is the filter control. ChatKit's own
   * `TapbackAttributionViewModel` carries a `_selectedItem`, so one tally being selected is the
   * framework's own idea; that selecting it narrows the cells is this file's.
   */
  const tallyItems = tallies.map((entry, index) => {
    const on = selected === entry.key;
    return (
      <button
        key={entry.key} type="button" data-slot="tapback-details-item" data-kind="tally" data-reaction={entry.key}
        aria-pressed={on} tabIndex={tabIndexFor(index)}
        aria-label={`${entry.count} ${reactionName(entry.reactor)} ${entry.count === 1 ? "reaction" : "reactions"} from ${namesFor(entry.names, m.stackSize)}`}
        onClick={() => setFilter(on ? null : entry.key)}
        onFocus={event => { setFocusIndex(index); event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" }); }}
        style={{ ...itemBase, alignItems: "center", height: m.tally, marginLeft: tallies[0] === entry ? 0 : m.itemSpacing }}
      >
        <span aria-hidden="true" data-slot="tapback-details-fill"
          style={{ position: "absolute", left: -m.tallyLabelSpacing - 6, right: -6, top: -3, bottom: -3, borderRadius: (m.tally + 6) / 2, background: "var(--im-td-fill, rgba(120,120,128,0.16))" }} />
        <span aria-hidden="true" style={{ position: "relative", width: m.tally, height: m.tally, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <TapbackGlyph type={entry.reactor.emoji ? undefined : entry.reactor.reaction ?? "love"} emoji={entry.reactor.emoji} size={tallyInk} />
        </span>
        <span aria-hidden="true" data-slot="tapback-details-count"
          style={{ position: "relative", marginLeft: m.tallyLabelSpacing, fontSize: m.countFontSize, lineHeight: 1, fontWeight: 400, letterSpacing: 0, color: "var(--im-td-label, rgba(60,60,67,0.6))" }}>
          {entry.count}
        </span>
      </button>
    );
  });

  const cellItems = shownReactors.map((reactor, index) => {
    // ChatKit's own accessibility string is "%@ reacted with %@"; the action that takes one back is
    // "Remove Tapback".
    const reacted = `${reactor.name} reacted with ${reactionName(reactor)}`;
    const removable = Boolean(reactor.own && onRemove);
    return (
      <button
        key={reactor.id} type="button" data-slot="tapback-details-item" data-kind="cell" data-own={reactor.own || undefined}
        tabIndex={tabIndexFor(tallies.length + index)} aria-label={removable ? `${reacted}. Remove Tapback` : reacted}
        aria-disabled={removable ? undefined : true}
        onClick={removable ? () => onRemove?.(reactor) : undefined}
        onFocus={event => { setFocusIndex(tallies.length + index); event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" }); }}
        style={{ ...itemBase, flexDirection: "column", width: m.cellWidth, marginLeft: index === 0 ? 0 : m.itemSpacing }}
      >
        <span aria-hidden="true" data-slot="tapback-details-fill"
          style={{ position: "absolute", left: 0, right: 0, top: -2, bottom: -2, borderRadius: m.avatar / 2, background: "var(--im-td-fill, rgba(120,120,128,0.16))" }} />
        <span style={{ position: "relative", display: "block", width: m.cellWidth, height: m.avatar }}>
          <Avatar size={m.avatar} initials={initialsOf(reactor)} src={reactor.avatar} role="presentation" aria-hidden="true"
            style={{ position: "absolute", left: (m.cellWidth - m.avatar) / 2, top: 0 }} />
          {/* The reaction badges the avatar as a bare glyph in ChatKit's `votingViewAvatarViewGlyphFrame`
              20 square. Horizontally that is arithmetic, not a guess: `votingViewCellWidth` 64 is the
              Ø44 avatar plus exactly one 20 frame, so the frame's trailing edge is the cell's and half
              of it laps the avatar. JUDGEMENT, and unmeasured: it is bottom-aligned with the avatar.
              ChatKit gives the frame's size and says nothing about where in the cell it sits. */}
          <span aria-hidden="true" data-slot="tapback-details-badge"
            style={{ position: "absolute", right: 0, top: m.avatar - m.glyphFrame, width: m.glyphFrame, height: m.glyphFrame, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <TapbackGlyph type={reactor.emoji ? undefined : reactor.reaction ?? "love"} emoji={reactor.emoji} size={badgeInk} />
          </span>
        </span>
        <span
          data-slot="tapback-details-name"
          style={{
            position: "relative", display: "block", marginTop: m.avatarToText, width: m.cellWidth, height: m.labelHeight,
            lineHeight: `${m.labelHeight}px`, fontSize: m.nameFontSize, fontWeight: 400, letterSpacing: 0,
            color: "var(--im-td-label, rgba(60,60,67,0.6))", textAlign: "center",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          {shortNameOf(reactor)}
        </span>
      </button>
    );
  });

  /**
   * The platter hugs its content and only then runs into `maxWidth`, which is what ChatKit's pair of
   * a max width and a minimum padding from the presenting edge describes. With a `left` it is placed
   * absolutely, the way `votingViewTargetFrame` places it (x = the leading layout margin); without
   * one it centres in the row it is given, which is where the one captured frame of this view family
   * (`longpress-ok-selected-*.png`) actually shows it.
   */
  const placed = left !== undefined;
  const platterStyle: CSSProperties = {
    ...(placed ? { position: "absolute", left, top: top ?? m.minPadding } : { position: "relative" }),
    boxSizing: "border-box",
    // Shrink-wrapped, then clamped: a relatively positioned block would otherwise fill its row.
    width: "fit-content",
    maxWidth: `min(${m.maxWidth}px, 100%)`,
    height: m.height,
    borderRadius: m.radius,
    paddingTop: m.topInset,
    paddingInline: m.paddingX,
    display: "flex",
    alignItems: "flex-start",
    background: "var(--im-td-platter, rgba(229,229,231,0.69))",
    backdropFilter: "var(--im-td-platter-filter, blur(9px) brightness(1.32) saturate(1.35))",
    WebkitBackdropFilter: "var(--im-td-platter-filter, blur(9px) brightness(1.32) saturate(1.35))",
    boxShadow: "var(--im-td-shadow, 0 6px 24px rgba(0,0,0,0.10)), inset 0 0 0 0.5px var(--im-td-rim, rgba(255,255,255,0.55))",
    transformOrigin: transformOrigins[origin ?? "top"],
    // Nothing is clickable while it folds away, so a dismissal cannot pick a cell by accident.
    pointerEvents: closing ? "none" : undefined,
  };

  const platterBox = (
    <div ref={platter} data-slot="tapback-details-platter" data-platform={platform} data-state={state}
      role="dialog" aria-modal={modal || undefined} aria-labelledby={`${id}-title`}
      // A modal platter hands `className`, `style` and the rest of the props to its overlay instead,
      // which is the element the caller is actually positioning.
      className={cn("select-none", modal ? undefined : className)}
      style={{ fontFamily: fontStack, ...platterStyle, ...(modal ? undefined : style) } as CSSProperties}
      {...(modal ? {} : props)}>
      <span id={`${id}-title`} style={{ position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap", border: 0 }}>Tapback Details</span>

      {/* The tallies and the people scroll together, which is what one fade at each end of the platter
          (`votingViewBlurWidth`) describes; only the close button is pinned. */}
      <div ref={scroller} data-slot="tapback-details-scroller"
        style={{
          flex: "0 1 auto", minWidth: 0, height: m.avatar + m.avatarToText + m.labelHeight,
          overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none",
          WebkitMaskImage: fade, maskImage: fade,
        }}>
        <div role="group" aria-label="Reactions" onKeyDown={onRowKeyDown}
          style={{ display: "flex", alignItems: "flex-start", width: "max-content", height: m.avatar + m.avatarToText + m.labelHeight }}>
          {/* JUDGEMENT: the tallies are centred on the avatars' own band rather than on the whole
              cell. ChatKit sizes the tally and says nothing about its vertical alignment. */}
          <div data-slot="tapback-details-tallies" style={{ display: "flex", alignItems: "center", flex: "0 0 auto", height: m.avatar, marginRight: m.itemSpacing }}>
            {tallyItems}
          </div>
          <div data-slot="tapback-details-cells" style={{ display: "flex", alignItems: "flex-start", flex: "0 0 auto" }}>
            {cellItems}
          </div>
        </div>
      </div>

      {onClose && (
        <button type="button" data-slot="tapback-details-close" aria-label="Close" onClick={onClose}
          style={{
            flex: "0 0 auto", marginLeft: m.closeLeftPadding, marginTop: (m.avatar - m.closeSize) / 2,
            width: m.closeSize, height: m.closeSize,
            borderRadius: m.closeSize / 2, border: 0, padding: 0, cursor: "default",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "var(--im-td-fill, rgba(120,120,128,0.16))", color: "var(--im-td-label, rgba(60,60,67,0.6))",
            outlineOffset: -2,
          }}>
          {/* The cross is 0.394 of its button, the ratio between the 17.33 cross and the Ø44 glass
              circle measured on `newmsg-light.png` in `ios-new-message-sheet.tsx`. */}
          <svg aria-hidden="true" width={m.closeSize * 0.394} height={m.closeSize * 0.394} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M1 1 11 11M11 1 1 11" />
          </svg>
        </button>
      )}
    </div>
  );

  // macOS anchors the platter directly; the caller positions it against the message.
  if (!modal) {
    return (
      <>
        <style>{platterTokens}</style>
        {platterBox}
      </>
    );
  }

  // iOS presents it over the dimmed transcript, the way the full-screen balloon controller does.
  return (
    <div data-slot="tapback-details-overlay" data-platform={platform} data-state={state}
      className={cn("absolute inset-0 z-40", className)} style={style} {...props}>
      <style>{platterTokens}</style>
      <div ref={scrim} data-slot="tapback-details-scrim" aria-hidden="true" onClick={onClose}
        style={{ position: "absolute", inset: 0 }} />
      <div style={{ position: "absolute", left: m.minPadding, right: m.minPadding, top: placed ? 0 : top ?? m.minPadding, bottom: 0, display: placed ? "block" : "flex", justifyContent: "center", alignItems: "flex-start" }}>
        {platterBox}
      </div>
    </div>
  );
}
