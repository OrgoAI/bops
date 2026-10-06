"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type UIEvent as ReactUIEvent } from "react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/message-ui/avatar";
import { GroupAvatar } from "@/components/message-ui/group-avatar";
import { IosSwitch, iosDetailsCollapse, iosDetailsMorph, iosDetailsMotion, iosDetailsPress, subpixel, usePressed } from "@/components/message-ui/ios-details";

/**
 * iOS 26 **group** conversation details, the screen a group's name pill opens.
 *
 * No capture in `references/` shows a group, so this screen is built from three sources and the
 * comment on every number says which one it is.
 *
 * **A. Measured on `references/ios/captures/details-light.png` / `details-dark.png`** (402×874 @3x),
 * through `ios-details.tsx`, which SPEC's fidelity table records at 0.08% against those frames. The
 * two screens share their whole frame, so these are used unchanged:
 *
 * - Back button Ø44 glass circle at (16, 62); the header photo slot Ø80 at (161, 62), centre (201, 102).
 * - Name 28px/33px bold (Chrome's fit to the measured 26pt ink box y 152.33–177.67), box top 146.15.
 * - Round glass action circles Ø54 with their centres on y 222.667, on a measured 74 pt pitch: three
 *   of them measure x 127 / 201 / 275. Centring an even count about x 201 is a **derivation** from
 *   that pitch, not a reading — see `actionLeft`.
 * - Grouped cells span x 16–386 (370 wide), radius 26 continuous, 20 between groups, first cell top
 *   269.6667. Row text starts 16 inside the cell (x 32); a plain text row is 52 tall; the separator
 *   is a 1 pt hairline on the row boundary, carried the way `ios-details.tsx` carries it.
 * - Cell and button fills: 6% black light / 12% white dark. Blue #0088ff / #0091ff, red #ff383c /
 *   #ff4245, separator #dadadb / #3a3a3c, secondary label #848488 / #98989f, chevron #bdbdbd / #5d5d5d.
 * - The screen sits over the conversation, blurred σ18 under a 49% white / 59% black scrim.
 * - `iosDetailsMotion`, `iosDetailsMorph`, `iosDetailsCollapse`, `IosSwitch` and `subpixel` are
 *   imported from that file rather than restated, so the two screens cannot drift apart.
 *
 * **B. Rendered by ChatKit 26 and measured off that render.** A probe app (`clang -target
 * arm64-apple-ios18.0-simulator`, `dlopen` of `/System/Library/PrivateFrameworks/ChatKit.framework`
 * inside the booted iPhone 17 Pro simulator — the same 402×874 @3x geometry as the captures) builds
 * the real cells, lays them out at the measured 370 cell width, dumps every frame, and is
 * screenshotted so the ink can be measured with `scripts/measure/px.py`. What it returned:
 *
 * | Value | Where it comes from |
 * |---|---|
 * | The header photo is the **Snowglobe** stack, not the pancake | A `CKAvatarView` given three contacts and a Ø80 frame draws faces at x 9.667–47.667 / y 32.333–61.333 / x 22.667–46.333, which is `group-avatar.tsx`'s `snowglobeSlots(3)` scaled to 80 to within a third of a point. `CKDetailsAvatarPancakeView` — the lozenge this file used to draw — is a *different* view: `CKDetailsGroupHeaderCell._avatarView`, 41 tall, with `configureCellIconForCollapsedState:`. The details header's photo is `CKGroupPhotoCell._groupView`. |
 * | Group photo ground disc | The Ø80 `CKAvatarView` paints a full-diameter disc behind the faces: measured #f4f5f5 over white and #1f1f20 over black. Light is exactly `+[UIColor quaternarySystemFillColor]` rgba(116,116,128,0.08); the dark alpha is fitted to the measured composite (quaternary's own 0.18 lands 10/255 too dark). |
 * | Participant row 64 tall, avatar Ø37, 12 to the name | `+[CKDetailsContactsStandardTableViewCell preferredHeight]` = 64 and the rendered cell: avatar Ø37 at x 8 y 13.333, name label at x 57 = 8 + 37 + 12. |
 * | Participant name 17 **semibold**, full label colour | The rendered `CKDetailsContactsTableViewCell.nameLabel` is `.SFUI-Semibold 17.0` at rgba(0,0,0,1) — so `detailsContactCellTitleColor`'s 84.71% is not what the cell paints. |
 * | Participant separator inset = the name column | The rendered cell's own hairline starts at x 57, the name column, and runs to the cell's trailing edge. Here that is 16 + 37 + 12 = **65**. |
 * | Add row 44 tall, button Ø37, glyph 13.667 square on a 1.444 stroke | `+[CKDetailsAddMemberStandardCell preferredHeight]` = 44; the rendered circle measures Ø37.000 at x 8 y 3.333 and its plus measures 13.6667 × 13.6667 pt of ink with a 4.33 device-px (1.4444 pt) stroke. |
 * | Add button fill | The rendered circle is #efeff0 over white and #323236 over the cell's own #1c1c1e in dark: both are exactly `-[CKUITheme detailsAddButtonBackgroundColor]` rgba(118,118,128,0.12 / 0.24). |
 * | "Add Contact" | `ADD_CONTACT` in ChatKit's en loctable, and the string the rendered cell actually shows. (`ADD_MEMBER` "Add Member" also exists and is exported for the callers that want it.) |
 * | Group count row 22 | `+[CKDetailsGroupCountCell preferredHeight]` = 22, `DETAILS_VIEW_GROUP_COUNT_TEXT` "%lu PEOPLE" / "%lu PERSON". |
 * | Show-all row 44 | `+[CKDetailsShowMoreContactsCell preferredHeight]` = 44 — native truncates a long member list. ChatKit has no string of its own for that row, so `SEARCH_SHOW_MORE` "See All" stands in. |
 * | Two action buttons, not three | `CKDetailsGroupNameCell` carries exactly `_phoneButton` and `_facetimeVideoButton`; there is no mail button on a group. |
 * | Copy | `ChatKit.loctable` (en), verbatim in `groupDetailsCopy`. |
 *
 * **C. UNMEASURED**, and marked as such where it is used:
 *
 * - Every duration: the presentation and the header collapse are `ios-details.tsx`'s, whose own
 *   header already records them as unmeasured.
 * - The shared-content cells (photos grid, links, attachments). They are the sibling screen's, built
 *   the same way and placed where the sibling places them — after Hide Alerts, above the destructive
 *   row — so with none of them present this screen reproduces the measured cell stack exactly.
 * - The 110 photo tile: `(370 − 2×16 − 2×4)/3`. The 4 gap and the radius 12 are measured
 *   (`photo-picker-light.png`, SPEC line 164); three-across inside the measured 16 inset is not.
 *   `-[CKUIBehaviorPhone searchPhotosInterItemSpacingDetailsView]` = 1.5 and
 *   `searchPhotosCellZKWAndDetailsCornerRadius` = 4 are named for a details photo grid and match
 *   neither number; nothing in this repo can say which surface they belong to.
 * - The group-count subtitle's position under the name (opt-in; with no `subtitle` the header is the
 *   measured one, untouched).
 * - Centring an even number of action circles about x 201.
 */

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

/**
 * The one-to-one screen's palette verbatim (measured; see `ios-details.tsx`), plus the two fills
 * ChatKit vends for the Add button and the group photo's ground disc. Light/dark live in CSS
 * variables so a `.dark` ancestor flips the whole screen.
 */
const vars =
  "[--ios-dt-label:#000000] [--ios-dt-secondary:#848488] [--ios-dt-blue:#0088ff] [--ios-dt-red:#ff383c] " +
  "[--ios-dt-fill:rgba(0,0,0,0.06)] [--ios-dt-separator:#dadadb] [--ios-dt-glyph:#000000] [--ios-dt-glyph-off:rgba(0,0,0,0.26)] [--ios-dt-glyph-blend:normal] " +
  "[--ios-dt-track:rgba(0,0,0,0.21)] [--ios-dt-knob:#ffffff] [--ios-dt-add:rgba(118,118,128,0.12)] [--ios-dt-press:#dcdcdc] " +
  "[--ios-dt-chevron:#bdbdbd] [--ios-dt-av-shadow:rgba(0,0,0,0.12)] [--ios-dt-glass:rgba(255,255,255,0.9)] [--ios-dt-glass-rim:inset_0_0_0_0_rgba(0,0,0,0)] [--ios-dt-glass-shadow:0_6px_36px_4px_rgba(0,0,0,0.065)] " +
  "[--ios-dt-scrim:rgba(255,255,255,0.573)] [--ios-dt-saturate:1] [--ios-dt-page:#ffffff] " +
  "dark:[--ios-dt-label:#ffffff] dark:[--ios-dt-secondary:#98989f] dark:[--ios-dt-blue:#0091ff] dark:[--ios-dt-red:#ff4245] " +
  "dark:[--ios-dt-fill:rgba(235,235,245,0.12)] dark:[--ios-dt-separator:#3a3a3c] dark:[--ios-dt-glyph:#ffffff] dark:[--ios-dt-glyph-off:rgba(255,255,255,0.26)] dark:[--ios-dt-glyph-blend:plus-lighter] " +
  "dark:[--ios-dt-track:rgba(255,255,255,0.28)] dark:[--ios-dt-add:rgba(118,118,128,0.24)] dark:[--ios-dt-press:#464646] " +
  "dark:[--ios-dt-chevron:#5d5d5d] dark:[--ios-dt-av-shadow:rgba(0,0,0,0.3)] " +
  "dark:[--ios-dt-glass:rgba(28,28,28,0.9)] dark:[--ios-dt-glass-rim:inset_0_0_0_0.3333px_rgba(255,255,255,0.0385),inset_0_0_0_0.6667px_rgba(255,255,255,0.032),inset_0_0_0_1px_rgba(255,255,255,0.061)] dark:[--ios-dt-glass-shadow:0_0_0_0_rgba(0,0,0,0)] " +
  "dark:[--ios-dt-scrim:rgba(0,0,0,0.587)] dark:[--ios-dt-saturate:1.05] dark:[--ios-dt-page:#000000]";

/** Apple's continuous corner. Browsers without `corner-shape` fall back to a plain round corner. */
const continuous = { cornerShape: "superellipse(1.14)" } as CSSProperties;

/**
 * The grouped-cell geometry, measured on the captures through `ios-details.tsx` (see heading A), and
 * the participant/add rows, measured off ChatKit's own render (see heading B).
 */
export const groupDetailsMetrics = {
  /** Measured: cells x 16–386, radius 26, 20 apart, the first one at 269.6667. */
  cellLeft: 16, cellWidth: 370, cellRadius: 26, cellGap: 20, cellTop: 269.6667,
  /** Measured: row content starts 16 inside the cell, and a plain text row is 52 tall. */
  inset: 16, row: 52,
  /** Measured: the header photo slot, Ø80 at (161, 62). */
  photo: 80, photoLeft: 161, photoTop: 62,
  /** Measured: the glass action circles, Ø54 with their centres on y 222.667, on a 74 pt pitch. */
  actionSize: 54, actionTop: 195.6667, actionPitch: 74, actionCentre: 201,
  /** ChatKit's render: participant row 64 with a Ø37 avatar 12 from a 17pt semibold name. */
  participantRow: 64, avatar: 37, avatarGap: 12,
  /** ChatKit's render: the add row is 44 with a Ø37 button whose plus is 13.6667 of ink on a 1.4444 stroke. */
  addRow: 44, addButton: 37, addGlyph: 13.6667, addGlyphStroke: 1.4444,
  /** ChatKit: `+[CKDetailsGroupCountCell preferredHeight]` and `+[CKDetailsShowMoreContactsCell preferredHeight]`. */
  countRow: 22, showAllRow: 44,
} as const;

/** ChatKit's en loctable, verbatim. Exported so a shell can put the same words in its own alerts. */
export const groupDetailsCopy = {
  /** `ADD_CONTACT` — what `CKDetailsAddMemberStandardCell` actually renders. */
  addContact: "Add Contact",
  /** `ADD_MEMBER` — the other string ChatKit carries for the same row. */
  addMember: "Add Member",
  /** `LEAVE_CONVERSATION`. */
  leave: "Leave this Conversation",
  /** `LEAVE_CONVERSATION_CONFIRMATION` — the shell owns the alert; this screen only calls `onLeave`. */
  leaveConfirmation: "Are you sure you want to leave this conversation?",
  /** `DETAILS_VIEW_HIDE_ALERTS_TOGGLE_TITLE`. */
  hideAlerts: "Hide Alerts",
  /** `GROUP_NAME_PLACEHOLDER` and `GROUP_NAME_LABEL`. */
  namePlaceholder: "Enter a Group Name",
  nameLabel: "Name",
  /** `CHANGE_GROUP_NAME_AND_PHOTO`. */
  changeNameAndPhoto: "Change Group Name and Photo",
  /** `SEARCH_SHOW_MORE` — ChatKit has no string of its own for the show-more-contacts row. */
  showAll: "See All",
  /** `SEE_ALL_*_TITLE`. */
  seeAllPhotos: "See All Photos",
  seeAllLinks: "See All Links",
  seeAllAttachments: "See All Attachments",
  seeAllLocations: "See All Locations",
  seeAllPasses: "See All Passes",
  /** `SHARED_WITH_YOU_TITLE`. */
  sharedWithYou: "Shared With You",
} as const;

/** `REMOVE_PARTICIPANT_FROM_GROUP`, 'Remove “%@” from “%@”?'. The shell presents the confirmation. */
export function removeParticipantPrompt(person: string, group: string): string {
  return `Remove “${person}” from “${group}”?`;
}

/** `DETAILS_VIEW_GROUP_COUNT_TEXT`: "%lu PERSON" for one, "%lu PEOPLE" for anything else. */
export function groupCountText(count: number): string {
  return `${count} ${count === 1 ? "PERSON" : "PEOPLE"}`;
}

/** 3 across, 4 apart, inside the measured 16 inset: a 110 tile. UNMEASURED; see heading C. */
const grid = { columns: 3, gap: 4, radius: 12 } as const;
const tile = (groupDetailsMetrics.cellWidth - groupDetailsMetrics.inset * 2 - grid.gap * (grid.columns - 1)) / grid.columns;

export type GroupDetailsParticipant = {
  id: string;
  name: string;
  /** Two letters. Ignored when `src` or `avatar` is given. */
  initials?: string;
  /** A photo for the row and for the header stack. */
  src?: string;
  /** Replaces the row's circle entirely (a next/image, say). The header stack still uses `src`. */
  avatar?: ReactNode;
  onPress?: () => void;
};

export type GroupDetailsAction = {
  id: string;
  label: string;
  icon: "phone" | "video";
  /** Unavailable actions keep the glass circle and drop the glyph to tertiary label (measured). */
  disabled?: boolean;
  onPress?: () => void;
};

/** One tile of the shared photos grid. Pass `node` for a next/image, `src` for a plain one. */
export type GroupDetailsPhoto = { id: string; src?: string; alt?: string; node?: ReactNode; onPress?: () => void };
/** One row of the shared links or shared attachments list. */
export type GroupDetailsItem = { id: string; title: string; detail?: string; onPress?: () => void };
/** A shared-content group: a header row that navigates, then its items. */
export type GroupDetailsSection<T> = { title?: string; count?: number | string; items: T[]; onOpen?: () => void };

export type GroupDetailsProps = Omit<ComponentProps<"div">, "children" | "onChange"> & {
  /** The group's name. Empty shows ChatKit's own placeholder, "Enter a Group Name". */
  name: string;
  /** Makes the name an editable field, the way `CKDetailsAddGroupNameView` is in native. */
  onNameChange?: (next: string) => void;
  namePlaceholder?: string;
  /**
   * A line under the name — ChatKit's `CKDetailsGroupHeaderCell._subTitleLabel`, whose content on a
   * group is `groupCountText(n)`. Its position is UNMEASURED, so it is opt-in: leave it out and the
   * header is the measured one, with the actions and cells on their measured tops.
   */
  subtitle?: string;
  /** Drawn as the framework's Snowglobe stack in the measured Ø80 slot. */
  participants?: GroupDetailsParticipant[];
  /**
   * Show only this many participants, then a 44 pt "See All" row — what
   * `CKDetailsShowMoreContactsCell` does natively. Omit to list everyone.
   */
  visibleParticipants?: number;
  showAllParticipantsLabel?: string;
  onShowAllParticipants?: () => void;
  /** Defaults to the two a group gets in ChatKit: audio and FaceTime video. */
  actions?: GroupDetailsAction[];
  addContactLabel?: string;
  onAddContact?: () => void;
  /** Controlled Hide Alerts. Omit it and the switch keeps its own state; see `IosSwitch`. */
  hideAlerts?: boolean;
  defaultHideAlerts?: boolean;
  onHideAlertsChange?: (next: boolean) => void;
  hideAlertsLabel?: string;
  /** Shared content, below the capture's fold and UNMEASURED. Each one is a grouped cell. */
  photos?: GroupDetailsSection<GroupDetailsPhoto>;
  sharedLinks?: GroupDetailsSection<GroupDetailsItem>;
  attachments?: GroupDetailsSection<GroupDetailsItem>;
  leaveLabel?: string;
  onLeave?: () => void;
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
 * Where in the rise the sheet stands `covered` of the way up: the entrance curve read backwards, so a
 * drag scrubs the timeline instead of leaving the screen nearly still under a finger that has already
 * moved 200 pt. The same control points `iosDetailsMotion.ease` is built from.
 */
const sheetCurve = [0.32, 0.72, 0, 1] as const;
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
 * lands leaves the screen with no animation, no transform and its glass intact.
 *
 * The header morphs out of the conversation's own nav bar, exactly as the one-to-one screen does: the
 * group photo is Ø60 there (`-[CKUIBehaviorPhone groupAvatarViewSize]` = 60 × 60, which is also the
 * measured nav-bar avatar) and Ø80 here, and the name is 17pt there and 28pt here, so
 * `iosDetailsMorph` transfers unchanged.
 *
 * `translate` and `scale` are used rather than `transform`, so the collapse — which owns `transform` —
 * composes with this instead of replacing it, and so the action circles keep the fractional
 * `transform` `subpixel` puts their measured top on.
 */
function groupLayers(content: HTMLElement, blur: HTMLElement | null, scrim: HTMLElement | null, height: number, saturate: string): Layer[] {
  const m = iosDetailsMotion;
  const layers: Layer[] = [];
  const add = (el: HTMLElement | null, from: Pose, to: Pose, duration: number, delay = 0, easing: string = m.ease) => {
    if (el) layers.push({ el, from, to, duration, delay, easing });
  };
  const own = (slot: string) => content.querySelector<HTMLElement>(`:scope > [data-slot="${slot}"]`);
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
  add(own("subtitle"), { opacity: "0" }, { opacity: "1" }, m.dim, 0, "ease-out");
  Array.from(content.querySelectorAll<HTMLElement>(`:scope > [data-slot="action"]`))
    .forEach((el, index) => add(el, { translate: `0px ${m.actionRise}px` }, { translate: "0px 0px" }, m.actionDuration, m.actionStart + index * m.actionStagger));
  // The stagger stops at the measured stack's four cells, so a group's longer stack still lands by
  // `enter`: a group always has at least three cells and often six.
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
 * The header collapse, as paused animations whose clock is the scroll offset in points: one
 * millisecond of timeline per point scrolled, so seeking is `currentTime = scrollTop`. It runs the
 * presentation's morph backwards, so a fully collapsed header is the conversation's own measured nav
 * bar. `travel` is `iosDetailsCollapse.travel` plus whatever a subtitle pushed the cells down by, so
 * the collapse still finishes exactly as the first cell reaches the pill it is passing under.
 */
function collapseLayers(content: HTMLElement, pillWidth: number, travel: number): Layer[] {
  const c = iosDetailsCollapse;
  const layers: Layer[] = [];
  const add = (el: HTMLElement | null, from: Pose, to: Pose, duration: number = travel) => {
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
  // The subtitle has nowhere to go in a 32.33 pill, so it fades with the action circles.
  add(own("subtitle"), { opacity: "1" }, { opacity: "0" }, c.actionFade);
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

type GlassCircleProps = ComponentProps<"button"> & { size: number; "data-slot"?: string; "data-action"?: string };

/**
 * The same glass circle the one-to-one screen draws, dimming under a finger to the same framework
 * alpha (`iosDetailsPress.touchAlpha`, `-[CKUIBehaviorPhone replyButtonTouchAlpha]` = 0.4).
 */
function GlassCircle({ size, className, style, children, disabled, ...rest }: GlassCircleProps) {
  const off = Boolean(disabled) || rest["aria-disabled"] === true || rest["aria-disabled"] === "true";
  const { pressed, pressAttr, handlers } = usePressed(!off);
  return (
    <button type="button" data-pressed={pressAttr} disabled={disabled}
      className={cn("absolute flex items-center justify-center rounded-full motion-reduce:!transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]", className)}
      style={{
        width: size, height: size, background: "var(--ios-dt-fill)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
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
 * The fill a held row paints, under its content and over the cell's own. `ios-details.tsx`'s, drawn
 * here rather than exported from there because it is four lines and this screen's cell clips it the
 * same way; `--ios-dt-press` is the shared token, from `-[CKUITheme detailsSelectedCellColor]` at
 * the phone idiom.
 */
function PressFill({ on }: { on: boolean }) {
  return (
    <span aria-hidden="true" data-slot="row-press" className="pointer-events-none absolute inset-0 motion-reduce:!transition-none"
      style={{ background: "var(--ios-dt-press)", opacity: on ? 1 : 0, transition: on ? "none" : `opacity ${iosDetailsPress.pressFade}ms ease-out` }} />
  );
}

/**
 * The two glyphs a group's header carries, at the ink sizes measured inside the Ø54 circles of
 * `details-light.png` (phone x 118.0–136.0 y 213.67–231.33, video x 190.0–213.11 y 215.02–230.33).
 * Copied from `ios-details.tsx` rather than re-derived; the envelope has no place on a group.
 */
function ActionGlyph({ icon }: { icon: GroupDetailsAction["icon"] }) {
  if (icon === "phone") {
    return (
      <svg aria-hidden="true" width="18.36" height="17.3333" viewBox="1.72 1.25 13.5 13.5" fill="currentColor">
        <path d="M3.654 1.328a.678.678 0 0 0-1.015-.063L1.605 2.3c-.483.484-.661 1.169-.45 1.77a17.6 17.6 0 0 0 4.168 6.608 17.6 17.6 0 0 0 6.608 4.168c.601.211 1.286.033 1.77-.45l1.034-1.034a.678.678 0 0 0-.063-1.015l-2.307-1.794a.68.68 0 0 0-.58-.122l-2.19.547a1.75 1.75 0 0 1-1.657-.459L5.482 8.062a1.75 1.75 0 0 1-.46-1.657l.548-2.19a.68.68 0 0 0-.122-.58z" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" width="23" height="15.3333" viewBox="0 0 23 15.3333" fill="currentColor" style={{ transform: "translateY(0.3333px)" }}>
      <rect x="0" y="0" width="16.3333" height="15.3333" rx="3.6" />
      <path d="M17.969 4.312 22.531 1.508Q23 1.22 23 1.77V13.53Q23 14.08 22.531 13.792L17.969 10.988Q17.5 10.7 17.5 10.15V5.15Q17.5 4.6 17.969 4.312Z" />
    </svg>
  );
}

/**
 * The disclosure chevron on a row that navigates. The one chevron this repo has measured: 4.67 ×
 * 12.67 of ink on a 2.6 round stroke, in the measured chevron gray (`ios-nav-bar.tsx`, reused by
 * `ios-details.tsx` on the same kind of row). ChatKit's own contact cell draws a different one — the
 * rendered probe measures 7.00 × 12.00 of ink at #c5c5c7 — but that is the legacy table cell, and a
 * group screen that disagreed with the one-to-one screen on the same pixel would be worse than one
 * that matches it. Its box is centred on the row and its ink sits `inset` in from the cell's edge.
 */
function Chevron() {
  return (
    <svg aria-hidden="true" className="absolute" width="8.6667" height="16.6667" viewBox="-2 -2 8.6667 16.6667" fill="none"
      stroke="var(--ios-dt-chevron)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
      style={{ right: groupDetailsMetrics.inset - 2, top: "50%", transform: "translateY(-50%)" }}>
      <path d="M1.3 1.3 3.37 6.3333 1.3 11.37" />
    </svg>
  );
}

/**
 * A grouped cell. Blink snaps a painted box to whole CSS px, so a fill placed straight on a
 * third-of-a-point edge lands a device pixel off at 3x: the fill sits on an integer box and a
 * transform carries the fraction. Identical to `ios-details.tsx`'s cell, which is what puts this
 * screen's first cell on the measured device row 809 rather than 810.
 */
function Cell({ top, height, children }: { top: number; height: number; children: ReactNode }) {
  const whole = Math.floor(top);
  const boxHeight = Math.max(1, Math.round(height));
  return (
    <div data-slot="cell" className="absolute" style={{ left: groupDetailsMetrics.cellLeft, top, width: groupDetailsMetrics.cellWidth, height }}>
      <span aria-hidden="true" data-slot="cell-fill" className="absolute" style={{
        left: 0, top: whole - top, width: groupDetailsMetrics.cellWidth, height: boxHeight, borderRadius: groupDetailsMetrics.cellRadius,
        background: "var(--ios-dt-fill)", transformOrigin: "0 0",
        transform: `translateY(${(top - whole).toFixed(4)}px) scaleY(${(height / boxHeight).toFixed(5)})`,
        ...continuous,
      }} />
      {/* The rows are clipped to the cell's measured corner so a held row's fill is cut by it. The
          clip wraps the rows and not the cell, because clipping `cell-fill` — which already paints
          this same superellipse — lands a hard mask on an already-antialiased edge and darkens every
          corner; see `ios-details.tsx`'s `Cell`, where that cost 2726 mismatched pixels in dark. */}
      <div data-slot="cell-clip" className="absolute inset-0" style={{ borderRadius: groupDetailsMetrics.cellRadius, overflow: "hidden", ...continuous }}>
        {children}
      </div>
    </div>
  );
}

/**
 * The measured hairline: 1 pt on a row boundary, sitting as the last point of the row above it
 * (`details-light.png` puts the boundary at 412.33 and the hairline on device rows 1234–1236). Its
 * trailing end is the measured 16 inside the cell; its leading end is `inset`, which is 16 for a text
 * row and the name column for a row with an avatar — ChatKit's own contact cell insets its hairline
 * to exactly that column.
 */
function Separator({ top, inset = groupDetailsMetrics.inset }: { top: number; inset?: number }) {
  return (
    <span aria-hidden="true" data-slot="separator" className="absolute"
      style={{ left: inset, right: groupDetailsMetrics.inset, top: top - 1.3333, transform: "translateY(0.3333px)", height: 1, background: "var(--ios-dt-separator)" }} />
  );
}

const rowFocus = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0088ff]";
/** Row text is 17pt (measured); a second line is 13pt (measured, the one-to-one screen's phone cell). */
const titleType: CSSProperties = { fontSize: 17, lineHeight: "22px", color: "var(--ios-dt-label)" };
const detailType: CSSProperties = { fontSize: 13, lineHeight: "16px", color: "var(--ios-dt-secondary)" };
const clip: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

/**
 * A shared group's header row: the section's name, how many it holds, and a chevron. The whole 52 pt
 * row is the hit target when it navigates, and it is a plain heading when it does not. UNMEASURED —
 * `ios-details.tsx`'s, verbatim, so the two screens file shared content the same way.
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
  const style: CSSProperties = { paddingLeft: groupDetailsMetrics.inset, paddingRight: groupDetailsMetrics.inset + (onOpen ? 14 : 0), transform: "translateY(0.6667px)" };
  return (
    <div className="absolute" style={{ left: 0, right: 0, top: 0, height: groupDetailsMetrics.row }}>
      {onOpen && <PressFill on={pressed} />}
      {onOpen
        ? <button type="button" data-slot="section-header" data-pressed={pressAttr} onClick={onOpen} className={cn("absolute inset-0 flex items-center text-left", rowFocus)} style={style} {...handlers}>{body}</button>
        : <h2 data-slot="section-header" className="absolute inset-0 m-0 flex items-center font-normal" style={style}>{body}</h2>}
    </div>
  );
}

/** One row of a shared links or attachments list. UNMEASURED; `ios-details.tsx`'s, verbatim. */
const twoLineRow = { title: 16.875, detail: 40.375, height: 70.6667 } as const;

function ItemRow({ item, top, height }: { item: GroupDetailsItem; top: number; height: number }) {
  const { pressed, pressAttr, handlers } = usePressed();
  const twoLine = item.detail !== undefined;
  const pad = groupDetailsMetrics.inset + 14;
  return (
    <div className="absolute" style={{ left: 0, right: 0, top, height }}>
      <PressFill on={pressed} />
      {/* Every item row sits under a row: the header above the first one, an item above the rest. */}
      <Separator top={0} />
      <button type="button" data-slot="detail-row" data-pressed={pressAttr} onClick={item.onPress}
        className={cn("absolute inset-0 text-left", !twoLine && "flex items-center", rowFocus)}
        style={twoLine ? { transform: "translateY(0.6667px)" } : { paddingLeft: groupDetailsMetrics.inset, paddingRight: pad, transform: "translateY(0.6667px)" }}
        {...handlers}>
        {twoLine ? (
          <>
            <span className="absolute" style={{ left: groupDetailsMetrics.inset, right: pad, top: twoLineRow.title, ...titleType, ...clip }}>{item.title}</span>
            <span className="absolute" style={{ left: groupDetailsMetrics.inset, right: pad, top: twoLineRow.detail, ...detailType, ...clip }}>{item.detail}</span>
          </>
        ) : (
          <span style={{ ...titleType, ...clip }}>{item.title}</span>
        )}
        <Chevron />
      </button>
    </div>
  );
}

/** How tall a shared group's cell is, given what it holds. UNMEASURED; see heading C. */
function photosHeight(section: GroupDetailsSection<GroupDetailsPhoto>) {
  const rows = Math.max(1, Math.ceil(section.items.length / grid.columns));
  return groupDetailsMetrics.row + groupDetailsMetrics.inset + rows * tile + (rows - 1) * grid.gap + groupDetailsMetrics.inset;
}
function listHeight(section: GroupDetailsSection<GroupDetailsItem>) {
  return groupDetailsMetrics.row + section.items.reduce((total, item) => total + (item.detail === undefined ? groupDetailsMetrics.row : twoLineRow.height), 0);
}

/** A tile of the shared grid; it dims under a finger at the framework's `replyButtonTouchAlpha`. */
function PhotoTile({ photo, label, box, media }: { photo: GroupDetailsPhoto; label: string; box: CSSProperties; media: ReactNode }) {
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

function PhotosCell({ section, top }: { section: GroupDetailsSection<GroupDetailsPhoto>; top: number }) {
  return (
    <Cell top={top} height={photosHeight(section)}>
      <SectionHeader title={section.title ?? "Photos"} count={section.count ?? section.items.length} onOpen={section.onOpen} />
      <Separator top={groupDetailsMetrics.row} />
      {section.items.map((photo, index) => {
        const column = index % grid.columns;
        const row = Math.floor(index / grid.columns);
        const box: CSSProperties = {
          left: groupDetailsMetrics.inset + column * (tile + grid.gap),
          top: groupDetailsMetrics.row + groupDetailsMetrics.inset + row * (tile + grid.gap),
          width: tile, height: tile, borderRadius: grid.radius, background: "var(--ios-dt-fill)",
        };
        const label = photo.alt ?? `Photo ${index + 1}`;
        const media = photo.node ?? (photo.src
          // eslint-disable-next-line @next/next/no-img-element -- registry components stay framework-neutral
          ? <img src={photo.src} alt="" className="size-full object-cover" draggable={false} />
          : null);
        return <PhotoTile key={photo.id} photo={photo} label={label} box={box} media={media} />;
      })}
    </Cell>
  );
}

function ListCell({ section, title, top }: { section: GroupDetailsSection<GroupDetailsItem>; title: string; top: number }) {
  // The rows stack under the header, each one as tall as it needs: 52 with one line, 70.67 with two.
  const rows: Array<{ item: GroupDetailsItem; top: number; height: number }> = [];
  section.items.reduce<number>((cursor, item) => {
    const height = item.detail === undefined ? groupDetailsMetrics.row : twoLineRow.height;
    rows.push({ item, top: cursor, height });
    return cursor + height;
  }, groupDetailsMetrics.row);
  return (
    <Cell top={top} height={listHeight(section)}>
      <SectionHeader title={section.title ?? title} count={section.count ?? section.items.length} onOpen={section.onOpen} />
      {rows.map(row => <ItemRow key={row.item.id} item={row.item} top={row.top} height={row.height} />)}
    </Cell>
  );
}

function initialsOf(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0] ?? "").join("").toUpperCase();
}

/** ChatKit's rendered contact cell insets its hairline to the name column: 16 + 37 + 12. */
const nameColumn = groupDetailsMetrics.inset + groupDetailsMetrics.avatar + groupDetailsMetrics.avatarGap;

/**
 * The rows of the participants cell and the destructive row, each its own component so it can hold
 * its own press state. They all fill with `--ios-dt-press` while held, and the cell clips the fill,
 * so the first and last rows of the cell are cut by the measured radius 26 corner.
 */
function ParticipantRow({ person, top, first }: { person: GroupDetailsParticipant; top: number; first: boolean }) {
  const m = groupDetailsMetrics;
  const { pressed, pressAttr, handlers } = usePressed();
  return (
    <div className="absolute" style={{ left: 0, right: 0, top, height: m.participantRow }}>
      <PressFill on={pressed} />
      {!first && <Separator top={0} inset={nameColumn} />}
      <button type="button" data-slot="participant" data-pressed={pressAttr} onClick={person.onPress}
        className={cn("absolute inset-0 flex items-center text-left", rowFocus)}
        style={{ paddingLeft: m.inset, paddingRight: m.inset + 14 }}
        {...handlers}>
        {person.avatar
          ? <span aria-hidden="true" className="relative block shrink-0 overflow-hidden rounded-full" style={{ width: m.avatar, height: m.avatar }}>{person.avatar}</span>
          : <Avatar size={m.avatar} initials={person.initials ?? initialsOf(person.name)} src={person.src} name={person.name} aria-hidden="true" role={undefined} />}
        {/* ChatKit's rendered cell: 17pt semibold at the full label colour, 12 past the avatar. */}
        <span style={{ ...titleType, ...clip, marginLeft: m.avatarGap, fontWeight: 600 }}>{person.name}</span>
        <Chevron />
      </button>
    </div>
  );
}

function ShowAllRow({ label, onPress, top, first }: { label: string; onPress?: () => void; top: number; first: boolean }) {
  const m = groupDetailsMetrics;
  const { pressed, pressAttr, handlers } = usePressed();
  return (
    <div className="absolute" style={{ left: 0, right: 0, top, height: m.showAllRow }}>
      <PressFill on={pressed} />
      {!first && <Separator top={0} inset={nameColumn} />}
      <button type="button" data-slot="show-all-participants" data-pressed={pressAttr} onClick={onPress}
        className={cn("absolute inset-0 flex items-center text-left", rowFocus)}
        style={{ paddingLeft: nameColumn, ...titleType, color: "var(--ios-dt-blue)", transform: "translateY(0.6667px)" }}
        {...handlers}>
        {label}
      </button>
    </div>
  );
}

function AddContactRow({ label, onPress, top, first }: { label: string; onPress?: () => void; top: number; first: boolean }) {
  const m = groupDetailsMetrics;
  const { pressed, pressAttr, handlers } = usePressed();
  return (
    <div className="absolute" style={{ left: 0, right: 0, top, height: m.addRow }}>
      <PressFill on={pressed} />
      {!first && <Separator top={0} inset={nameColumn} />}
      <button type="button" data-slot="add-contact" data-pressed={pressAttr} onClick={onPress}
        className={cn("absolute inset-0 flex items-center text-left", rowFocus)} style={{ paddingLeft: m.inset }}
        {...handlers}>
        <span aria-hidden="true" className="flex shrink-0 items-center justify-center rounded-full"
          style={{ width: m.addButton, height: m.addButton, background: "var(--ios-dt-add)", ...continuous }}>
          {/* ChatKit loads the "plus" SF Symbol here and tints it `detailsTextColor`; its ink
              measures 13.6667 square on a 1.4444 stroke in the rendered cell. */}
          <svg aria-hidden="true" width={m.addGlyph} height={m.addGlyph} viewBox={`0 0 ${m.addGlyph} ${m.addGlyph}`} fill="none"
            stroke="var(--ios-dt-blue)" strokeWidth={m.addGlyphStroke} strokeLinecap="round">
            <path d={`M${m.addGlyph / 2} ${m.addGlyphStroke / 2}V${m.addGlyph - m.addGlyphStroke / 2}M${m.addGlyphStroke / 2} ${m.addGlyph / 2}H${m.addGlyph - m.addGlyphStroke / 2}`} />
          </svg>
        </span>
        <span style={{ ...titleType, ...clip, marginLeft: m.avatarGap, color: "var(--ios-dt-blue)" }}>{label}</span>
      </button>
    </div>
  );
}

function LeaveRow({ label, onPress }: { label: string; onPress?: () => void }) {
  const { pressed, pressAttr, handlers } = usePressed();
  return (
    <>
      <PressFill on={pressed} />
      <button type="button" data-slot="leave" data-pressed={pressAttr} onClick={onPress}
        className={cn("absolute inset-0 flex items-center text-left", rowFocus)}
        style={{ paddingLeft: groupDetailsMetrics.inset, ...titleType, color: "var(--ios-dt-red)", transform: "translateY(0.6667px)" }}
        {...handlers}>
        {label}
      </button>
    </>
  );
}

export function GroupDetails({
  name, onNameChange, namePlaceholder = groupDetailsCopy.namePlaceholder, subtitle,
  participants = [], visibleParticipants, showAllParticipantsLabel = groupDetailsCopy.showAll, onShowAllParticipants,
  actions,
  addContactLabel = groupDetailsCopy.addContact, onAddContact,
  // No `= false`: `undefined` has to reach `IosSwitch` for it to keep its own state, which is what
  // a consumer that passes no handler needs. See `IosSwitch` in `ios-details.tsx`.
  hideAlerts, defaultHideAlerts, onHideAlertsChange, hideAlertsLabel = groupDetailsCopy.hideAlerts,
  photos, sharedLinks, attachments,
  leaveLabel = groupDetailsCopy.leave, onLeave,
  onBack, backdrop, progress, scroll, open = true, onExited, className, style, ...props
}: GroupDetailsProps) {
  const nameId = useId();
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

  const m = groupDetailsMetrics;
  // ChatKit gives a group exactly two of these: `CKDetailsGroupNameCell` carries a phone button and a
  // FaceTime video button and no mail button.
  const buttons: GroupDetailsAction[] = actions ?? [
    { id: "audio", label: "Audio", icon: "phone" },
    { id: "video", label: "FaceTime", icon: "video" },
  ];
  // A subtitle is UNMEASURED, so it only exists when it is asked for, and then it pushes everything
  // under the name down by its own block: the 1 pt `detailsGroupHeaderCellInterTextVerticalSpacing`
  // plus a 13/16 line. With no subtitle the shift is 0 and the header is the measured one.
  const subtitleShift = subtitle ? 17 : 0;
  const actionsTop = m.actionTop + subtitleShift;
  const cellsTop = m.cellTop + subtitleShift;
  const collapseTravel = iosDetailsCollapse.travel + subtitleShift;
  const shown = visibleParticipants === undefined ? participants : participants.slice(0, Math.max(0, visibleParticipants));
  const showAll = shown.length < participants.length;

  // The dismissal is derived during render, not in an effect: an effect leaves one committed frame
  // with the screen already gone, and the exit never runs. `closing` also separates a screen that is
  // leaving (fire `onExited`, stop taking clicks) from one mounted closed, which just sits dismissed.
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
    return runLayers(groupLayers(node, blur.current, scrim.current, height, saturate), phase);
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
  const seekCollapse = (top: number, travel: number) => {
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
      list = collapseLayers(node, inkWidth * iosDetailsMorph.name.scale + c.pill.padLeft + c.pill.padRight, travel)
        .map(({ el, from, to, duration, easing }) => el.animate([from, to], { duration, easing, fill: "both" }));
      collapse.current = list;
    }
    seekTo(list, Math.min(top, travel));
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
    seekCollapse(scroll ?? scrolled.current, collapseTravel);
    // `seekCollapse` only reads refs and its arguments; the offset, the pill's presence and the
    // travel a subtitle lengthens are the whole input.
  }, [collapsing, scroll, collapseTravel]);

  const onScroll = (event: ReactUIEvent<HTMLDivElement>) => {
    if (scroll !== undefined) return;
    const top = event.currentTarget.scrollTop;
    seekCollapse(top, collapseTravel);
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
   * half-dragged screen is the same pose as a half-played entrance. A group's list runs past the
   * bottom of the screen, so the drag only starts when the list is already at its top, which is what
   * native does too; below that the finger scrolls.
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

  // The stack, in order, on the same plan the measured one-to-one screen uses: the identity cells,
  // then Hide Alerts, then whatever shared content there is, then the destructive row last.
  const groups: ReactNode[] = [];
  let cursor = cellsTop;
  const place = (height: number, render: (top: number) => ReactNode) => {
    groups.push(render(cursor));
    cursor += height + m.cellGap;
  };

  if (shown.length > 0 || onAddContact) {
    const rows: Array<{ height: number; render: (top: number, first: boolean) => ReactNode }> = [];
    shown.forEach(person => rows.push({
      height: m.participantRow,
      render: (top, first) => <ParticipantRow key={person.id} person={person} top={top} first={first} />,
    }));
    if (showAll) rows.push({
      height: m.showAllRow,
      render: (top, first) => <ShowAllRow key="show-all" label={showAllParticipantsLabel} onPress={onShowAllParticipants} top={top} first={first} />,
    });
    if (onAddContact) rows.push({
      height: m.addRow,
      render: (top, first) => <AddContactRow key="add-contact" label={addContactLabel} onPress={onAddContact} top={top} first={first} />,
    });
    const height = rows.reduce((total, row) => total + row.height, 0);
    place(height, top => {
      let y = 0;
      return (
        <Cell key="participants" top={top} height={height}>
          {rows.map((row, index) => { const node = row.render(y, index === 0); y += row.height; return node; })}
        </Cell>
      );
    });
  }

  place(m.row, top => (
    <Cell key="hide-alerts" top={top} height={m.row}>
      {/* No press fill: a table cell whose accessory is a switch takes `selectionStyle .none`. */}
      <div className="absolute inset-0 flex items-center justify-between" style={{ paddingLeft: m.inset, paddingRight: 14 }}>
        <span data-slot="hide-alerts-label" style={{ ...titleType, transform: "translateY(0.6667px)" }}>{hideAlertsLabel}</span>
        <IosSwitch checked={hideAlerts} defaultChecked={defaultHideAlerts} onChange={onHideAlertsChange} label={hideAlertsLabel} style={{ transform: "translateY(0.3333px)" }} />
      </div>
    </Cell>
  ));
  if (photos && photos.items.length > 0) place(photosHeight(photos), top => <PhotosCell key="photos" section={photos} top={top} />);
  if (sharedLinks && sharedLinks.items.length > 0) place(listHeight(sharedLinks), top => <ListCell key="shared-links" section={sharedLinks} title="Links" top={top} />);
  if (attachments && attachments.items.length > 0) place(listHeight(attachments), top => <ListCell key="attachments" section={attachments} title="Attachments" top={top} />);
  place(m.row, top => (
    <Cell key="leave" top={top} height={m.row}>
      <LeaveRow label={leaveLabel} onPress={onLeave} />
    </Cell>
  ));
  // The page ends 20 below the last group: the measured gap, used as the bottom inset.
  const pageHeight = cursor;

  return (
    <div ref={root} data-slot="group-details" data-state={open ? "open" : "closing"}
      data-progress={progress === undefined ? undefined : clamp01(progress).toFixed(3)}
      role="dialog" aria-modal="true" aria-labelledby={nameId}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
      className={cn("relative isolate size-full select-none overflow-hidden", vars, className)}
      style={{ fontFamily: font, ...style }} {...props}>
      {backdrop !== undefined && (
        <div aria-hidden="true" data-slot="backdrop" className="absolute inset-0 -z-10 overflow-hidden">
          {/*
            Blurring a box larger than the screen keeps the filter's own edge falloff off-screen, and
            the same box takes the sheet's push-back. The blur is divided by that scale, so what lands
            on screen is the measured σ18 either way.
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
        {/* The cells scroll; the header above them does not, it collapses into the conversation's own
            nav bar. A group's list is long enough that this always matters. */}
        <div ref={scroller} data-slot="details-scroll" className="absolute inset-0" onScroll={onScroll}
          style={{ overflowY: scroll === undefined ? "auto" : "hidden", overscrollBehavior: "contain" }}>
          <div data-slot="details-page" className="relative" style={{ height: pageHeight }}>{groups}</div>
        </div>

        {/*
          After the scroll surface, with the rest of the header. Before it they were covered by
          `details-scroll` — `absolute inset-0`, the whole screen — so a finger on Audio or FaceTime
          landed on the scroller and the button was never pressed at all. The collapse already treats
          them as header: it fades them out by the scroll that reaches their measured top.
        */}
        {buttons.map((action, index) => (
          <GlassCircle key={action.id} size={m.actionSize} data-slot="action" data-action={action.id} aria-label={action.label}
            aria-disabled={action.disabled || undefined} onClick={action.disabled ? undefined : action.onPress}
            style={{
              ...subpixel(actionsTop),
              // The 74 pitch is measured, and this reproduces the measured three-up (left 100 / 174 /
              // 248, centres 127 / 201 / 275) exactly; centring an even count about the measured
              // x 201 is a derivation from that pitch, not a reading.
              left: m.actionCentre + (index - (buttons.length - 1) / 2) * m.actionPitch - m.actionSize / 2,
              color: action.disabled ? "var(--ios-dt-glyph-off)" : "var(--ios-dt-glyph)",
              mixBlendMode: action.disabled ? "var(--ios-dt-glyph-blend)" as CSSProperties["mixBlendMode"] : undefined,
            }}>
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

        {/* The group photo: `group-avatar.tsx`'s Snowglobe stack in the measured Ø80 slot, plate and
            all — which is what a Ø80 `CKAvatarView` given the group's contacts lays out. */}
        <div data-slot="avatar" className="absolute rounded-full"
          style={{ left: m.photoLeft, top: m.photoTop, width: m.photo, height: m.photo }}>
          <GroupAvatar size={m.photo} className="absolute left-0 top-0" aria-hidden="true" role={undefined}
            participants={participants.map(person => ({ name: person.name, initials: person.initials ?? initialsOf(person.name), src: person.src }))} />
        </div>

        {onNameChange ? (
          <input id={nameId} data-slot="name" value={name} placeholder={namePlaceholder} aria-label={groupDetailsCopy.nameLabel}
            onChange={event => onNameChange(event.target.value)}
            className="absolute m-0 select-text bg-transparent p-0 text-center outline-none placeholder:text-[color:var(--ios-dt-secondary)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#0088ff]"
            style={{ left: 16, right: 16, top: 146.15, width: "auto", fontSize: 28, lineHeight: "33px", fontWeight: 700, letterSpacing: 0, color: "var(--ios-dt-label)", fontFamily: font }} />
        ) : (
          <h1 id={nameId} data-slot="name" className="absolute m-0 whitespace-nowrap text-center"
            style={{ left: 0, right: 0, top: 146.15, fontSize: 28, lineHeight: "33px", fontWeight: 700, letterSpacing: 0, color: name ? "var(--ios-dt-label)" : "var(--ios-dt-secondary)" }}>
            <span ref={nameInk}>{name || namePlaceholder}</span>
          </h1>
        )}

        {subtitle && (
          // UNMEASURED: `CKDetailsGroupHeaderCell` carries a subtitle 1 pt under its title
          // (`detailsGroupHeaderCellInterTextVerticalSpacing`), but no capture shows where it lands
          // on this screen. Everything below it moves down by `subtitleShift` to make room.
          <div data-slot="subtitle" className="absolute text-center"
            style={{ left: 0, right: 0, top: 180.15, ...detailType }}>
            {subtitle}
          </div>
        )}

        <GlassCircle size={44} data-slot="back" aria-label="Back" onClick={onBack} style={{ left: 16, top: 62 }}>
          <svg aria-hidden="true" width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="var(--ios-dt-glyph)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M24.8 13.87 16.2 22.17 24.8 30.47" />
          </svg>
        </GlassCircle>
      </div>
    </div>
  );
}
