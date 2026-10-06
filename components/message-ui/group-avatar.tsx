"use client";

import { useLayoutEffect, useRef, type ComponentProps, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { Avatar, type AvatarProps } from "@/components/message-ui/avatar";

/**
 * The two avatar surfaces a group conversation has and a one-to-one does not: the stacked group
 * photo, and the small per-sender photo beside an incoming bubble.
 *
 * ## Where the numbers come from
 *
 * **A capture now exists.** Nothing in `references/ios/captures` or `references/macos/captures` shows
 * a group conversation — `grouped-light.png` is message *grouping* in a two-person thread and
 * `details-light.png` is a one-to-one details screen. So this surface was captured on purpose:
 * `references/group-avatar/snowglobe-light.png` and `snowglobe-dark.png` are
 * `xcrun simctl io booted screenshot` of the iPhone 17 Pro simulator (1206x2622 = 402x874 pt at 3x,
 * the repo's iOS capture geometry) running a small app that dlopens the runtime's own
 * ChatKit/ContactsUICore and lays out real `CKAvatarView`s over `CNMutableContact` fixtures. Every
 * circle in those two PNGs is drawn by Apple's code, in a live window, with a live blur. See
 * `references/group-avatar.md` for the layout and how to re-take them.
 *
 * The frames and diameters below are read straight out of the frameworks with a Mac Catalyst probe
 * (`clang -target arm64-apple-ios26.0-macabi`, `-[UIDevice userInterfaceIdiom]` swizzled to the idiom
 * being asked about, then `dlopen`), and cross-checked against those captures.
 *
 * ## The stack
 *
 * A group photo is not a ChatKit drawing at all: `CKAvatarView` is a `CNAvatarView` subclass, and
 * ContactsUICore lays the faces out through
 * `+[CNUIAvatarLayoutManager layoutConfigurationsForType:withItemCount:]`. Type 2 is
 * `SnowglobeAvatarLayoutConfigurations`, the one a group photo uses; type 3 is
 * `SnowglobeGroupTypingIndicatorAvatarLayoutConfigurations`, the same circles in a different order.
 * Each entry is a `CNUIAvatarLayoutItemConfiguration` carrying `x`, `y`, `size` and `baseSize`, and
 * `-itemFrameInContainingBounds:isRTL:` turns one into a frame:
 *
 * ```
 * s = bounds.width / baseSize          baseSize is 88 for every Snowglobe entry
 * d = size * s
 * frame = (bounds.midX + x*s - d/2, bounds.midY + y*s - d/2, d, d)
 * ```
 *
 * `snowglobeStack` is that table verbatim. One participant fills the circle; two and three have their
 * own rows; four, five and six add a slot to the three-face row; seven re-lays the whole set.
 * `+[CNUIAvatarLayoutManager maxAvatarCountForType:]` answers 10, but asking for 8, 9, 10 or 11
 * returns the same seven entries, so an eighth participant is simply not drawn.
 *
 * **The faces never touch.** The previous version of this file claimed "there is no ring, cut-out or
 * hairline between the faces — they simply overlap". They do not overlap: the table leaves a gap, and
 * that gap *is* the ring you see. Minimum centre-to-centre clearance, computed from the table and
 * confirmed in the capture (`snowglobeClearance`, in base-88 units): 1.598 for two faces, 2.446 for
 * three, 2.040 for four through six, 2.071 for seven — 1.09 / 1.67 / 1.39 / 1.41 pt once scaled to
 * Ø60. Whatever is behind the stack shows through that gap, and nothing strokes it.
 *
 * **The largest face is at the back, not the front.** A live `CKAvatarView` builds a
 * `ContactsUICore.SnowglobeUIView` holding one `ContactsUICore.AvatarUIView` per person, added in
 * table order with `zPosition` 0 on every one — so the first (largest) entry is the first subview and
 * paints first. (`-[CNUIAvatarLayoutItemConfiguration updateLayer:inBounds:atIndex:isRTL:layoutType:]`
 * does set `zPosition` to `-index`, but that path is not the one a group photo runs.) The previous
 * version asserted the opposite; it never showed because the faces do not overlap. This component
 * paints in table order with no `z-index`, which is the native order.
 *
 * **The frosted plate is real, and it is a circle.** `SnowglobeUIView` inserts a `UIVisualEffectView`
 * as subview 0, filling the box, behind every face, with `UIBlurEffect material=20` —
 * `.systemThinMaterial` (`+[UIBlurEffect effectWithStyle:]` reports material 20 for
 * `systemThinMaterial` and its Light/Dark siblings). The view's frame is square, but it is masked to a
 * circle: traced in `snowglobe-light.png` with `scripts/measure/outline.py` the plate is 60.00 x 60.00
 * pt with a ~29.5 pt radius on all four corners, i.e. a full-box disc. It is present only for two or
 * more faces — one contact skips `SnowglobeUIView` entirely and gets a bare `AvatarUIView`.
 * `groupAvatarPlate` is the material measured over five backgrounds in both appearances.
 *
 * **RTL** mirrors x about the centre and nothing else, so the whole stack is expressible as
 * `inset-inline-start`: a face at physical `left` L in a box of S with diameter d lands at `S - L - d`
 * in RTL, which is exactly what `inset-inline-start: L` does. This component therefore inherits the
 * document direction for free; `rtl` only stamps `dir` when a caller forces it.
 *
 * ## Sizes, per behaviour object
 *
 * `-[CKUIBehavior* groupAvatarViewSize]` is 60 x 60 on Phone, Pad and Mac alike — the nav-bar avatar's
 * Ø60 in `conv3-light.png`. The list rows are a different constant:
 * `conversationListContactImageDiameter` is 45 on Phone and Pad (SPEC's Ø45 iOS list rows) and 40 on
 * Mac (SPEC's Ø40 sidebar rows and Ø40 header avatar). See `groupAvatarMetrics`.
 *
 * The iOS **details** header is not this stack. `CKDetailsAvatarPancakeView` — diameter 37, cut-out
 * 41, overlap 13.5, widths 58 and 72 for two and three, all still on the behaviour object as
 * `detailsAvatar*` / `detailsAvatarPancakeView*` — is a row of overlapping heads with knockouts, and
 * `group-details.tsx` already draws it. (`registry.json` says this component covers "the details
 * header"; it does not, and that line wants correcting.)
 *
 * ## The per-sender avatar
 *
 * `+[CKChatItemLayoutUtilities avatarSupplementaryItemForChatItem:layoutEnvironment:]` returns an
 * `NSCollectionLayoutSupplementaryItem` of `.absolute(d) x .absolute(d)` at `zIndex` 1, anchored with
 * `[NSCollectionLayoutAnchor layoutAnchorWithEdges:6 absoluteOffset:(-d, 0)]`. Edges 6 is
 * `NSDirectionalRectEdge.leading | .bottom`, so the avatar hangs off the balloon's leading edge with
 * its **bottom flush to the balloon's bottom** — which is why a cluster carries one avatar, on its
 * last (tailed) bubble. `d` is not hardcoded: running the same call under each idiom returns 32 / 34 /
 * 28, i.e. `-[CKUIBehavior* transcriptContactImageDiameter]`, and
 * `-[CKTranscriptAvatarSupplementaryView initWithFrame:]` builds its `CKAvatarView` at exactly
 * `(0, 0, d, d)` with no inset whatever frame the view is given. `contactPhotoBalloonMargin` is 7 on
 * all three; the leading gutter an incoming row gives up is `d + 7` = **39 / 41 / 35**.
 *
 * The group typing indicator uses a bigger face: `transcriptGroupTypingContactImageDiameter`, 44 / 48
 * / 42. `typing-indicator.tsx` does not draw one yet; the constant is here so it can.
 *
 * ## Motion
 *
 * When a new message joins an incoming cluster the avatar hands off to the new last bubble, riding the
 * transcript's insert animation: `-[CKUIBehavior* scrollInNewMessageAnimationDuration]` is **0.300 s**
 * on all three idioms. `SenderAvatar` plays that as a FLIP on the Web Animations API so the harness can
 * seek it with `progress`. The easing is **unmeasured** — no recording in `references/` contains a
 * group transcript — so it uses `ease-in-out`, UIView's default, and says so in `senderAvatarMotion`.
 *
 * @see references/group-avatar.md
 */

/** One face in the stack. Same shape `avatar.tsx` takes, plus the name used for the composed label. */
export type GroupParticipant = { name?: string; initials?: string; src?: string };

/** `{ x, y, diameter }` in the Snowglobe table's own 88-point box, centre-relative. */
export type StackSlot = { x: number; y: number; diameter: number };

/** The base box every Snowglobe configuration is expressed in (`CNUIAvatarLayoutItemConfiguration.baseSize`). */
export const snowglobeBaseSize = 88;

/** Most faces the table will draw. Participants past this many are not shown. */
export const snowglobeMaxFaces = 7;

/**
 * `SnowglobeAvatarLayoutConfigurations`, read back from
 * `+[CNUIAvatarLayoutManager layoutConfigurationsForType:2 withItemCount:n]`.
 * Index 0 is the first entry the framework returns: the largest face, and the first subview added, so
 * it is at the **back** of the paint order.
 */
export const snowglobeStack: readonly (readonly StackSlot[])[] = [
  [{ x: 0, y: 0, diameter: 88 }],
  [{ x: -10.5, y: -10.5, diameter: 48 }, { x: 17.5, y: 17.5, diameter: 28 }],
  [{ x: -12.5, y: -12.5, diameter: 42 }, { x: 21.5, y: 7.5, diameter: 32 }, { x: -6, y: 23.5, diameter: 26 }],
  [{ x: -12.5, y: -12.5, diameter: 42 }, { x: 21.5, y: 7.5, diameter: 32 }, { x: -6, y: 23.5, diameter: 26 }, { x: 20, y: -20.5, diameter: 20 }],
  [{ x: -12.5, y: -12.5, diameter: 42 }, { x: 21.5, y: 7.5, diameter: 32 }, { x: -6, y: 23.5, diameter: 26 }, { x: 20, y: -20.5, diameter: 20 }, { x: -27.5, y: 14, diameter: 14 }],
  [{ x: -12.5, y: -12.5, diameter: 42 }, { x: 21.5, y: 7.5, diameter: 32 }, { x: -6, y: 23.5, diameter: 26 }, { x: 20, y: -20.5, diameter: 20 }, { x: -27.5, y: 14, diameter: 14 }, { x: 7.5, y: -32.5, diameter: 10 }],
  [{ x: -12.5, y: -12.5, diameter: 42 }, { x: 19.5, y: 11.5, diameter: 30 }, { x: 21.5, y: -16.5, diameter: 22 }, { x: -21, y: 19.5, diameter: 20 }, { x: 2, y: 30, diameter: 15 }, { x: -3, y: 15, diameter: 11 }, { x: 9, y: -31.5, diameter: 10 }],
];

/**
 * `SnowglobeGroupTypingIndicatorAvatarLayoutConfigurations`, layout type 3. The same circles as
 * `snowglobeStack` in a different order: four onwards puts the small top-right slot second, and seven
 * is a full reshuffle. Read back the same way, at `withItemCount:` 1 through 7.
 */
export const snowglobeTypingStack: readonly (readonly StackSlot[])[] = [
  [{ x: 0, y: 0, diameter: 88 }],
  [{ x: -10.5, y: -10.5, diameter: 48 }, { x: 17.5, y: 17.5, diameter: 28 }],
  [{ x: -12.5, y: -12.5, diameter: 42 }, { x: 21.5, y: 7.5, diameter: 32 }, { x: -6, y: 23.5, diameter: 26 }],
  [{ x: -12.5, y: -12.5, diameter: 42 }, { x: 20, y: -20.5, diameter: 20 }, { x: 21.5, y: 7.5, diameter: 32 }, { x: -6, y: 23.5, diameter: 26 }],
  [{ x: -12.5, y: -12.5, diameter: 42 }, { x: 20, y: -20.5, diameter: 20 }, { x: 21.5, y: 7.5, diameter: 32 }, { x: -6, y: 23.5, diameter: 26 }, { x: -27.5, y: 14, diameter: 14 }],
  [{ x: -12.5, y: -12.5, diameter: 42 }, { x: 7.5, y: -32.5, diameter: 10 }, { x: 20, y: -20.5, diameter: 20 }, { x: 21.5, y: 7.5, diameter: 32 }, { x: -6, y: 23.5, diameter: 26 }, { x: -27.5, y: 14, diameter: 14 }],
  [{ x: -12.5, y: -12.5, diameter: 42 }, { x: 9, y: -31.5, diameter: 10 }, { x: 21.5, y: -16.5, diameter: 22 }, { x: 19.5, y: 11.5, diameter: 30 }, { x: 2, y: 30, diameter: 15 }, { x: -3, y: 15, diameter: 11 }, { x: -21, y: 19.5, diameter: 20 }],
];

/**
 * Smallest gap between any two faces, in base-88 units, one entry per row of `snowglobeStack`. Every
 * value is positive: the stack has clearance everywhere, so the "ring" between the faces is the
 * background showing through and not a stroke. `NaN` for the single-face row, which has no pair.
 * Multiply by `size / 88` for a real diameter (Ø60 → 1.0895, 1.6678, 1.3910, 1.3910, 1.3910, 1.4123).
 */
export const snowglobeClearance: readonly number[] = [NaN, 1.598, 2.4462, 2.0401, 2.0401, 2.0401, 2.0713];

/**
 * The table row for `count` faces. One through seven map to their own row; anything larger gets the
 * seven-face row, as the framework does; zero and negatives clamp up to the single-face row, which is
 * what `GroupAvatar` draws while a conversation is still loading.
 */
export function snowglobeSlots(count: number, layout: "photo" | "typing" = "photo"): readonly StackSlot[] {
  const table = layout === "typing" ? snowglobeTypingStack : snowglobeStack;
  return table[Math.min(Math.max(count, 1), snowglobeMaxFaces) - 1];
}

/**
 * One slot's box inside a circle of `size`, in CSS px, as `-itemFrameInContainingBounds:isRTL:`
 * computes it. `left` is the physical left edge; pass `rtl` to mirror it the way `isRTL:YES` does.
 * `GroupAvatar` instead spends the LTR value as `inset-inline-start`, which mirrors identically and
 * inherits the document direction — see `snowglobeFrame(slot, size, true).left === size - ltr - d`.
 */
export function snowglobeFrame(slot: StackSlot, size: number, rtl = false): { left: number; top: number; size: number } {
  const scale = size / snowglobeBaseSize;
  const face = slot.diameter * scale;
  const x = (rtl ? -slot.x : slot.x) * scale;
  return { left: size / 2 + x - face / 2, top: size / 2 + slot.y * scale - face / 2, size: face };
}

/**
 * Group-photo diameters, per behaviour object. `groupAvatar` is `groupAvatarViewSize` (the nav bar and
 * the macOS header slot); `conversationList` is `conversationListContactImageDiameter` (the iOS list
 * rows and the macOS sidebar rows). Read off `CKUIBehaviorPhone` / `Pad` / `Mac` directly.
 */
export const groupAvatarMetrics = {
  phone: { groupAvatar: 60, conversationList: 45 },
  pad: { groupAvatar: 60, conversationList: 45 },
  mac: { groupAvatar: 60, conversationList: 40 },
} as const;

/** `-[CKUIBehavior groupAvatarViewSize]`, 60 x 60 on every idiom. */
export const groupAvatarSize = groupAvatarMetrics.phone.groupAvatar;

/**
 * The frosted disc behind the faces, `UIBlurEffect(.systemThinMaterial)`, measured off two live
 * simulator renders: `references/group-avatar/snowglobe-{light,dark}.png` (the plate under a real
 * stack, 762 clean samples per cell) and `material-swatches-{light,dark}.png` (a bare
 * `UIVisualEffectView` over the same flats). The two agree to under 1/255 everywhere.
 */
export const groupAvatarPlate: readonly { background: string; light: string; dark: string }[] = [
  { background: "#ffffff", light: "#f4f4f5", dark: "#7d7d7d" },
  { background: "#000000", light: "#8d8e8e", dark: "#1f1f1f" },
  { background: "#3478f6", light: "#a2c7ff", dark: "#264a8f" },
  { background: "#e9e9eb", light: "#ededee", dark: "#737373" },
  { background: "#1c1c1e", light: "#9d9d9e", dark: "#2a2a2a" },
];

/**
 * A translucent fill that reproduces the plate over an arbitrary background, fitted to the two
 * achromatic ends of `groupAvatarPlate` (#ffffff and #000000, which it hits exactly). Residuals
 * against the other measured rows: 1.2/255 on #e9e9eb and 4.0/255 on #1c1c1e in light, 1.7 and 0.9 in
 * dark. Over #3478f6 it misses by up to 14/255 (light) and 22/255 (dark) in the blue channel, because
 * the material also lifts saturation and a flat overlay cannot; a surface that knows it is drawing on
 * the selection blue should set `--im-ga-plate` to that row's measured colour instead.
 */
export const groupAvatarPlateFit = { light: "rgba(237, 237, 237, 0.596)", dark: "rgba(49, 49, 49, 0.632)" } as const;

export type GroupAvatarProps = Omit<ComponentProps<"span">, "children"> & {
  /** Circle diameter. Defaults to the framework's 60; see `groupAvatarMetrics` for the list sizes. */
  size?: number;
  /** The people in the conversation, in the order the stack should draw them. */
  participants: readonly GroupParticipant[];
  /** Accessible name; falls back to the participants' names. */
  name?: string;
  /**
   * Mirror the stack the way `isRTL:YES` does. Left undefined the stack follows the document
   * direction on its own (the faces are placed with `inset-inline-start`); passing a boolean stamps
   * `dir` on the host to force it.
   */
  rtl?: boolean;
  /** `"typing"` uses the group typing indicator's ordering of the same circles. */
  layout?: "photo" | "typing";
  /**
   * The frosted disc behind the faces. Defaults to `--im-ga-plate`, which the component seeds with
   * `groupAvatarPlateFit`; pass a colour to pin it (e.g. a measured `groupAvatarPlate` row over a
   * selected sidebar row) or `false` to leave it out. Never drawn for fewer than two faces, because
   * one contact skips `SnowglobeUIView` natively.
   */
  plate?: string | false;
};

/**
 * `avatar.tsx` declares `--av-top` / `--av-bottom` inline and then tries to override them with a
 * `dark:` class, which an inline declaration always beats — so an `Avatar` rendered through this file
 * would keep the light gradient in dark mode. Its `style` prop is spread last, so handing it the pair
 * as `var()` references with the light values as fallbacks restores the switch without touching that
 * file, and keeps working if it is fixed there.
 *
 * Both pairs re-measured off `references/group-avatar/snowglobe-{light,dark}.png`: fitting a straight
 * line down the Ø60 single-face circle (116 rows, glyph pixels dropped) returns #a9c2e1 -> #747fb9 in
 * light and #575368 -> #302649 in dark, max residual 0.89 and 0.78 of 255 — the same four values
 * `avatar.tsx` records, from a capture it has never been diffed against.
 */
const faceGradient = { "--av-top": "var(--im-ga-face-top, #a9c2e1)", "--av-bottom": "var(--im-ga-face-bottom, #747fb9)" } as CSSProperties;
const faceGradientDark = "dark:[--im-ga-face-top:#575368] dark:[--im-ga-face-bottom:#302649]";

/** "Alex Morgan, Jamie Chen and Sam Rivera", or "3 people" when nobody is named. */
function participantsLabel(participants: readonly GroupParticipant[]): string {
  const named = participants.map(person => person.name ?? person.initials).filter((value): value is string => Boolean(value));
  if (!named.length) return participants.length ? (participants.length === 1 ? "1 person" : `${participants.length} people`) : "Group";
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/**
 * A group conversation's photo: the participants' faces laid out by the Snowglobe table over the
 * material plate. Draws at most seven faces, as the framework does, largest first and so furthest
 * back.
 */
export function GroupAvatar({ size = groupAvatarSize, participants, name, rtl, layout = "photo", plate, className, style, ...props }: GroupAvatarProps) {
  const faces = participants.slice(0, snowglobeMaxFaces);
  const slots = snowglobeSlots(faces.length || 1, layout);
  const label = name ?? participantsLabel(participants);
  // The light fill rides in as the `var()` fallback rather than a declaration, so the dark class and
  // any `--im-ga-plate` a surface sets on an ancestor both win without a specificity fight.
  const plateFill = typeof plate === "string" ? plate : `var(--im-ga-plate, ${groupAvatarPlateFit.light})`;
  return (
    <span
      data-slot="group-avatar"
      data-size={size}
      data-count={participants.length}
      data-faces={faces.length || 1}
      data-truncated={participants.length > snowglobeMaxFaces ? "" : undefined}
      role="img"
      aria-label={label}
      dir={rtl === undefined ? undefined : rtl ? "rtl" : "ltr"}
      className={cn("relative inline-block shrink-0 select-none align-middle dark:[--im-ga-plate:rgba(49,49,49,0.632)]", faceGradientDark, className)}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      {/* `SnowglobeUIView`'s UIVisualEffectView: the whole box, masked to a disc, behind every face.
          Absent for one contact, which never builds a SnowglobeUIView at all. */}
      {slots.length > 1 && plate !== false && (
        <span data-slot="group-avatar-plate" aria-hidden="true" className="absolute inset-0 rounded-full" style={{ background: plateFill }} />
      )}
      {/* An empty group still draws one circle, so the surface never collapses while a conversation loads. */}
      {(faces.length ? faces : [{} as GroupParticipant]).map((person, index) => {
        const frame = snowglobeFrame(slots[index], size);
        // Table order, no z-index: the framework adds the largest face first, so it paints first.
        const layer: CSSProperties = { position: "absolute", insetInlineStart: frame.left, top: frame.top, ...faceGradient };
        const avatar: AvatarProps = { size: frame.size, initials: person.initials, src: person.src, name: person.name };
        return <Avatar key={index} {...avatar} aria-hidden="true" role={undefined} style={layer} />;
      })}
    </span>
  );
}

/** Which behaviour object a surface reads its transcript diameters from. */
export type SenderAvatarPlatform = "phone" | "pad" | "mac";

/**
 * The avatar beside an incoming bubble in a group, per behaviour object. `gutter` is
 * `transcriptContactImageDiameter + contactPhotoBalloonMargin`: the diameter, the margin and the
 * `(-d, 0)` supplementary anchor are each read directly from the frameworks, and the sum is the
 * leading inset the transcript cells spend on the pair.
 */
export const senderAvatarMetricsFor: Record<SenderAvatarPlatform, { diameter: number; balloonMargin: number; gutter: number; typingDiameter: number }> = {
  /** `CKUIBehaviorPhone`: 32 / 7 / 44. */
  phone: { diameter: 32, balloonMargin: 7, gutter: 39, typingDiameter: 44 },
  /** `CKUIBehaviorPad`: 34 / 7 / 48. */
  pad: { diameter: 34, balloonMargin: 7, gutter: 41, typingDiameter: 48 },
  /** `CKUIBehaviorMac`: 28 / 7 / 42. The macOS pane's gutter is 35, not the phone's 39. */
  mac: { diameter: 28, balloonMargin: 7, gutter: 35, typingDiameter: 42 },
};

/**
 * The Phone numbers, kept as a bare export because that is what this file used to ship. Prefer
 * `senderAvatarMetricsFor` — a macOS transcript is 28/35, not 32/39.
 */
export const senderAvatarMetrics = senderAvatarMetricsFor.phone;

/** Maps `platform.tsx`'s two-value platform onto a behaviour object. */
export function senderAvatarMetricsForPlatform(platform: "ios" | "macos") {
  return platform === "macos" ? senderAvatarMetricsFor.mac : senderAvatarMetricsFor.phone;
}

/**
 * The hand-off: when a new message joins an incoming cluster the avatar moves to the new last bubble
 * on the transcript's insert animation, `-[CKUIBehavior* scrollInNewMessageAnimationDuration]` =
 * 0.300 s (identical on Phone, Pad and Mac).
 *
 * `easing` is **unmeasured** — nothing in `references/` records a group transcript, so there is no
 * curve to fit. `ease-in-out` is UIView's default for a plain `animateWithDuration:`; treat it as a
 * placeholder, not a reading.
 */
export const senderAvatarMotion = { handoff: 300, easing: "ease-in-out" } as const;

/**
 * Where an element sits inside its scroll container, so a hand-off measures the same before and after
 * the list scrolls. Falls back to page coordinates when nothing above it scrolls.
 */
function anchorPoint(el: HTMLElement): { left: number; top: number } {
  const rect = el.getBoundingClientRect();
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") {
      const box = node.getBoundingClientRect();
      return { left: rect.left - box.left + node.scrollLeft, top: rect.top - box.top + node.scrollTop };
    }
  }
  return { left: rect.left + window.scrollX, top: rect.top + window.scrollY };
}

/** The last settled position of every live hand-off key, ref-counted so a move survives the remount. */
const handoffPositions = new Map<string, { left: number; top: number; users: number }>();

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type SenderAvatarProps = Omit<ComponentProps<"span">, "children"> & {
  /** The sender's name, used as the accessible label. */
  name?: string;
  initials?: string;
  src?: string;
  /** Which behaviour object's diameters to use. Defaults to the phone's. */
  platform?: "ios" | "macos";
  /** Diameter. Defaults to the platform's `transcriptContactImageDiameter`. */
  size?: number;
  /** `"typing"` swaps in `transcriptGroupTypingContactImageDiameter`. */
  variant?: "message" | "typing";
  /**
   * Identifies the cluster this avatar belongs to. When an avatar with the same key reappears at a
   * new position — the cluster grew a bubble and the avatar moved to it — it slides from where it
   * was. Leave it off to place the avatar without any motion.
   */
  handoffKey?: string;
  /** Play the hand-off from this offset instead of a measured one. For the lab and the harness. */
  handoffFrom?: { dx?: number; dy: number };
  /** 0..1 seeks the hand-off instead of playing it. */
  progress?: number;
  /**
   * Position the avatar in the row's leading gutter, bottom-aligned with the balloon, the way
   * `avatarSupplementaryItemForChatItem:` anchors it. Needs a positioned row that reserves `gutter`
   * of leading padding. Pass `false` to lay it out yourself.
   */
  anchored?: boolean;
};

/**
 * The photo beside an incoming bubble in a group: one per cluster, on the last (tailed) bubble,
 * bottom flush with the balloon and hanging its own diameter off the balloon's leading edge.
 *
 * The row it sits in has to be `position: relative` and give up `gutter` of `padding-inline-start`;
 * this element then takes the leading edge and the bottom of that box. See the file docstring for the
 * supplementary-item anchor those two rules come from.
 */
export function SenderAvatar({
  name, initials, src, platform = "ios", variant = "message", size, handoffKey, handoffFrom, progress, anchored = true, className, style, ...props
}: SenderAvatarProps) {
  const metrics = senderAvatarMetricsForPlatform(platform);
  const diameter = size ?? (variant === "typing" ? metrics.typingDiameter : metrics.diameter);
  const host = useRef<HTMLSpanElement>(null);
  const animation = useRef<Animation | null>(null);
  const forcedDx = handoffFrom ? handoffFrom.dx ?? 0 : undefined;
  const forcedDy = handoffFrom?.dy;

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    // Measure where this avatar rests, with any in-flight slide removed first.
    animation.current?.cancel();
    animation.current = null;
    const at = anchorPoint(el);
    const previous = handoffKey ? handoffPositions.get(handoffKey) : undefined;
    const delta = forcedDy !== undefined
      ? { dx: forcedDx ?? 0, dy: forcedDy }
      : previous
        ? { dx: previous.left - at.left, dy: previous.top - at.top }
        : null;
    if (handoffKey) handoffPositions.set(handoffKey, { left: at.left, top: at.top, users: (previous?.users ?? 0) + 1 });
    if (delta && (delta.dx !== 0 || delta.dy !== 0) && !prefersReducedMotion() && typeof el.animate === "function") {
      const run = el.animate(
        [{ transform: `translate(${delta.dx}px, ${delta.dy}px)` }, { transform: "translate(0px, 0px)" }],
        { duration: senderAvatarMotion.handoff, easing: senderAvatarMotion.easing, fill: "both" },
      );
      animation.current = run;
      // Drop the forwards fill once it lands, so a settled avatar carries no transform (and so no
      // stacking context) into the next hand-off. A seeked animation is paused and never resolves.
      run.finished.then(() => run.cancel()).catch(() => undefined);
    }
    return () => {
      if (!handoffKey) return;
      const entry = handoffPositions.get(handoffKey);
      if (!entry) return;
      entry.users -= 1;
      // React unmounts before it mounts the moved node, so let the new instance claim the key first.
      queueMicrotask(() => {
        const live = handoffPositions.get(handoffKey);
        if (live && live.users <= 0) handoffPositions.delete(handoffKey);
      });
    };
  }, [handoffKey, forcedDx, forcedDy]);

  // Seeks in a second layout effect, after the one above has built the animation and before paint, so
  // a scrubbed hand-off never shows a played frame and re-scrubbing never restarts it.
  useLayoutEffect(() => {
    const run = animation.current;
    if (!run || progress === undefined) return;
    run.pause();
    run.currentTime = Math.min(Math.max(progress, 0), 1) * senderAvatarMotion.handoff;
  }, [progress, handoffKey, forcedDx, forcedDy]);

  return (
    <span
      ref={host}
      data-slot="sender-avatar"
      className={cn("block", anchored && "absolute bottom-0 start-0", faceGradientDark, className)}
      style={{ width: diameter, height: diameter, ...style }}
      {...props}
    >
      <Avatar size={diameter} initials={initials} src={src} name={name} style={faceGradient} />
    </span>
  );
}
