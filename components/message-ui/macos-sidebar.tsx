"use client";

import { useId, useState, type ComponentProps, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/message-ui/avatar";
import { GroupAvatar, groupAvatarPlate } from "@/components/message-ui/group-avatar";

/**
 * macOS 26 Messages conversation list. Every number is measured from a native 960×640 window at 2x
 * (see `references/SPEC.md` → macOS Chrome). The sidebar is not a flat 330 pt column: it is a floating
 * panel inset 8 from the window's left, top and bottom, 320 wide (window x 8–328), radius ≈18, with a
 * 1 pt bright rim and a soft shadow onto the pane. Everything inside sits in window coordinates:
 * search field x 18–318 y 52–88 (a 36 tall capsule), pinned Ø73 avatar centered (168, 142.5) with an
 * 11 pt gray label, rows 80.5 tall from y 215 with a Ø40 avatar at x 36–76, a 13 pt semibold name
 * (baseline 28.75 into the row), a 12 pt time on the same baseline ending at x 307.5, a 12 pt preview
 * (baseline 45, 15 pt line pitch, two lines), 1 pt separators from x 82 to 306, a #3478f6 selection
 * (#3a3a3a when the window is not key) and a 49 pt footer bar at the panel's bottom.
 *
 * **Unread** (no capture; read out of ChatKit 26.5 on macOS 26.5, the framework macOS Messages is
 * built on). An unread row draws a dot and nothing else: nothing in the row's layout moves, no label
 * changes weight or colour, and there is no count badge.
 * - Ø **9**, from `-[CKUIBehaviorMac unreadIndicatorImageViewSize]` = `{9, 9}`. The asset behind it,
 *   `-[CKUIBehavior unreadIndicatorTintedImage]`, is a Ø12 circle that fills its box edge to edge, so
 *   the image view's size *is* the dot's diameter.
 * - Fill **#0088ff light / #0091ff dark, opaque**, from `-[CKUIThemeMac unreadIndicatorColor]`.
 *   `__42-[CKUIBehavior unreadIndicatorTintedImage]_block_invoke` is that colour's only consumer:
 *   it bakes it into the circle, and rendering the image under each appearance returns those two.
 * - Placement `-[CKConversationListCellLayout unreadFrame]` = `{4.5, y, 9, 9}` in the same row space
 *   whose avatar is `{18, ·, 40, 40}` and whose name box starts at 64, i.e. exactly this component's.
 *   `-[CKConversationListStandardCell _calculateIndicatorFrameForSize:trailing:displayScale:insets:]`
 *   derives both: x = (`conversationListCellLeftMargin` 18 − 9) / 2 = 4.5, so the dot is centred in the
 *   gutter left of the avatar, and y = (row height − 9) / 2, so it is centred on the row.
 * - **Selected and unread**: the dot turns **white**, opaque. `-[CKUIBehaviorMac
 *   shouldUnreadIndicatorChangeOnSelection]` is `YES` (it is `NO` on `CKUIBehaviorPhone`), and
 *   `-[CKConversationListCell unreadIndicatorImageForVisibility:withMuteState:]` reads
 *   `shouldLabelsBeHighlighted && shouldUnreadIndicatorChangeOnSelection ? unreadIndicatorSelectedImage
 *   : unreadIndicatorTintedImage`. The selected image renders #ffffff in both appearances. It is the
 *   same test that whitens the labels, because the dot sits inside the selection fill, not beside it,
 *   so the dot follows `highlighted` here. `shouldLabelsBeHighlighted` is a bare ivar on the cell with
 *   no notion of a key window, so an inactive window's gray selection is the one case not settled by
 *   the framework: the capture shows its labels staying dark, and the dot stays blue to match.
 * - **No count.** `_TtC7ChatKit32CKConversationListIndicatorsView`, the row's accessory strip, holds
 *   only image views, and `-[CKConversationListCell unreadMessageCount]` is read by nothing that
 *   draws. A number passed here is announced and never painted.
 * - **A pinned conversation** draws the same dot before its title label. `CKPinnedConversationView`
 *   vends `unreadIndicatorSize` {9, 9} and `unreadIndicatorPreferredPadding` trailing **3**, and laying
 *   a 96 × 119 one out (the tile size this component uses) puts the label at x 15.5 w 65.5 y 90 h 19
 *   and the dot at x 3.5 y 95, i.e. the label stays centred in the tile and the dot hangs off its
 *   leading edge 3 away, vertically centred on the label's line. `_unreadIndicatorColor` picks between
 *   three colours and both of its branches are now settled:
 *   `isFilteredByFocus ? conversationListPinnedConversationFilteredByFocusIndicatorColor
 *    : isSelectedWithDarkAppearance ? readSelectedIndicatorColor : unreadIndicatorColor`.
 *   `isFilteredByFocus` is set from `-[CKConversationList updateFilteredByFocusStateForConversations:]`,
 *   the "a Focus is filtering this conversation out" dimming; this kit has no Focus, so it is always NO
 *   and the #000000@25.9% / #ffffff@24.7% colour it would pick is unreachable. `isSelectedWithDarkAppearance`
 *   is written in exactly one place, `-[CKPinnedConversationCollectionViewCell updateConfigurationUsingState:]`,
 *   as `useSelectedAppearanceForConversationCellState:traitCollection: && showsBackgroundViewWhenSelected`,
 *   and `-[CKUIBehaviorMac useSelectedAppearanceForConversationCellState:traitCollection:]` is
 *   `(state.isSelected || state.cellDropState == 2) && traitCollection.activeAppearance.isMainWindowForegroundActive`.
 *   So the name means "selected on the key window, while the tile paints its selected background", and
 *   `readSelectedIndicatorColor` is opaque **#ffffff** in both appearances, the same white the row dot
 *   takes. This component's pinned selection is a ring around the avatar, not the filled radius-8
 *   background view native draws (`conversationListPinnedCellSelectedBackgroundCornerRadius` 8), and
 *   its label does not go white either, so the second term is NO here and the dot always takes
 *   `unreadIndicatorColor`. Give the tile that background and the white branch turns on with it.
 *
 * **The row's four states: rest, hover, pressed, selected.**
 *
 * *Selected* is the measured one: fill **#3478f6** on the key window, **`--sb-inactive`** when it is
 * not, with the labels, the muted bell and the unread dot going white only in the first case (see
 * `active` below). Both come from the full-window frames "macOS Chrome" is measured from.
 *
 * *Hover draws nothing, and that is the reading, not a gap.* Four independent sources say so:
 * - `references/SPEC.md`, from the live session the sidebar numbers come from: "**No hover state**
 *   on sidebar rows or bubbles."
 * - `CKUIThemeMac` has no conversation-list hover, pressed or cell colour at all. Dumping every
 *   zero-argument `UIColor` getter on it (86 of them) turns up `conversationListCellSelectedText/
 *   Summary/DateColor` and nothing that could fill a row; `conversationListCellColor` and
 *   `conversationListSelectedCellColor` are both **null** on the Mac theme, where the phone theme
 *   answers #dcdcdc / #464646 and the Pad theme #0088ff / #0091ff.
 * - `+[UIBackgroundConfiguration listSidebarCellConfiguration]` and `listPlainCellConfiguration`,
 *   resolved for every combination of `highlighted` and `selected` at idiom 5, change **only** for
 *   `selected`. `highlighted` alone is byte-identical to rest in both appearances.
 * - ChatKit does implement hover — `appMenuCollectionViewCell:didHoverWithState:`,
 *   `contactsCell:didHoverWithState:` — for the app drawer and the contacts list, and for no cell in
 *   the conversation list. It is absent here on purpose, not by omission.
 *
 * So the hover fill is `--sb-row-hover`, and it is **`transparent`**. It is a seam rather than a
 * value: a product that wants a web-idiomatic hover sets that one custom property and gets it on
 * unselected, unpressed rows only. Nothing in this kit sets it, because native does not.
 *
 * *Pressed* is the selected look, arriving a beat early. `CKConversationListCell` is a
 * **`UITableViewCell`** (not a collection-view cell) whose `selectionStyle` is `Default`, and a
 * `UITableViewCell` paints the same `selectedBackgroundView` for `highlighted` as for `selected` —
 * so a row under a held mouse wears the row's own selected fill, and no second colour is invented.
 * The click still commits on release, and a press that wanders off the row before then puts the
 * fill out again.
 *
 * **UNMEASURED, and the one place this departs from the framework's own answer**: the *labels* go
 * white under the press too. `-[CKUIBehaviorMac useSelectedAppearanceForConversationCellState:
 * traitCollection:]` is `(state.isSelected || state.cellDropState == 2) && …isMainWindowForeground
 * Active` — it never reads `isHighlighted`, so on ChatKit's reading a held row would keep its dark
 * labels over the blue. No capture holds a pressed row to settle it, and dark-on-#3478f6 is not
 * something any macOS list draws, so the whole selected appearance travels together here.
 *
 * **Search** (`onSearch`, `searchQuery`). Typing in the field replaces the list *in place*:
 * `-[CKUIBehaviorMac searchControllerObscuresConversationList]` is **NO**, where the same selector on
 * `CKUIBehaviorPhone` is **YES** — which is why iOS covers its whole screen (`ios-search.tsx`) and the
 * Mac does not. The pinned strip goes with the list, a "Conversations" header takes its place, and
 * the rows underneath are the sidebar's own measured 80.5 rows, unchanged. Every number in
 * `macSidebarMetrics.results` is a Catalyst probe reading off `CKUIBehaviorMac` in ChatKit 26.5, with
 * the Phone value beside it so the two idioms can be told apart; what is **not** measured is where the
 * header sits horizontally (it takes the rows' own leading edge) and the "No Results" line, because no
 * capture in `references/macos/captures` holds a search in progress. The kit's own strings are used
 * verbatim: `SEARCH_CONVERSATIONS_TITLE` "Conversations" and `SEARCH_RESULTS_INDEXING_TITLE`
 * "No Results". ⌘F reaches the field from the window; that binding lives in `macos-messages-app.tsx`.
 *
 * **What the match looks like, settled out of ChatKit 26.5 rather than guessed.** A conversation
 * result on the Mac is `+[CKConversationSearchResultCell conversationListCellClass]` =
 * `CKConversationSearchResultEmbeddedCell`, a `CKConversationListStandardCell` subclass — this row.
 * Disassembling `-[CKConversationSearchResultEmbeddedCell configureWithQueryResult:searchText:]`
 * settles all three questions a highlight raises:
 * - **Which label.** It lets the base cell fill the row (`updateContentsForConversation:fastPreview:`
 *   between two `setFreezeSummaryText:` calls), then sends `-setAttributedText:` to **`summaryLabel`
 *   only**. The name label is never annotated, so a query that matches only a name shows no emphasis
 *   anywhere in the row. This component annotates the preview line and leaves the name alone.
 * - **Not bolded.** One font is fetched — `searchMessageBodyTextFont` when
 *   `CKIsRunningInMacCatalyst()` (which macOS Messages is), `conversationListSummaryFont` otherwise —
 *   and handed to
 *   `+annotatedResultStringWithSearchText:resultText:primaryTextColor:primaryFont:annotatedTextColor:annotatedFont:`
 *   as **both** the primary and the annotated font: the two argument registers are literally the same
 *   register (x5 and x7 are both x23). The match is recoloured and nothing else. That is the same
 *   thing `-[CKMessageSearchResultCell _annotatedResultStringForResult:searchText:]` does on iOS, and
 *   it is why `ios-search.tsx` recolours too.
 * - **Which two colours.** `primaryTextColor` is `theme.conversationListSummaryColor` and
 *   `annotatedTextColor` is `theme.conversationListSenderColor` — the row's own preview colour and
 *   the row's own **name** colour, the two this component already has measured off the capture as
 *   `--sb-secondary` and `--sb-name`. (`CKUIThemeMac` resolves them to black at 49.8% / 84.7% in
 *   light and white at 54.9% / 84.7% in dark; the capture's own #6e6e6d and #000000 win, because a
 *   capture beats a framework constant.) On a selected row the same pair becomes
 *   `conversationListCellSelectedSummaryColor` white@80% and `conversationListCellSelectedTextColor`
 *   white, so the match goes to the plain #ffffff the name takes there.
 *
 * `searchMessageBodyTextFont` is SF Regular **15** on `CKUIBehaviorMac`, against the 12 pt preview
 * this row measures. It is **not** applied: `conversationListSenderFont` is Semibold 17 on the same
 * class against a measured 13, so ChatKit's conversation-list font table is already known to
 * disagree with macOS 26's own sidebar. Only the structure above — one font, two colours, summary
 * label only — is taken from the framework; every size stays the capture's.
 *
 * **UNMEASURED: the clear button.** No capture holds a field with text in it, so the ✕ that a
 * `NSSearchField` shows once it has any is judgement, not a reading: it mirrors the measured
 * magnifier's own inset from the opposite edge and centres on the same line. It is drawn only when
 * there is a query, so every capture-matched state — the empty field — is byte for byte unchanged.
 *
 * **Group rows** (`members`). A group conversation's row draws the same `CKAvatarView` the one-to-one
 * row does (`CKConversationListStandardCell._avatarView`), handed every participant instead of one, and
 * `CNAvatarView` lays those out through `ContactsUICore.SnowglobeUIView` as a stack of circles inside
 * the same Ø40 box — `group-avatar.tsx`'s `snowglobeStack`, which this file used to carry its own copy
 * of. The two were identical to 0.000 across all seven rows on the same 44-unit box, so the merge moved
 * nothing; what the shared component adds is the `UIBlurEffect` plate behind the faces. On a **selected**
 * row that plate is not the generic translucent fill: the material lifts saturation over #3478f6 and a
 * flat overlay cannot, missing by up to 14/255 in blue (light) and 22/255 (dark), so the measured row of
 * `groupAvatarPlate` for that background is passed instead. The preview line is prefixed with
 * `sender`, in the same 12 pt type and the same gray as the rest of the preview: ChatKit does not
 * compose that prefix (`-[CKConversation previewText]` is the message's text alone, and the cell has
 * only a from-label and a summary label), so the wording is the caller's and only the metrics it has to
 * fit are measured.
 */
export type SidebarConversation = {
  id: string;
  name: string;
  initials: string;
  preview: string;
  time: string;
  pinned?: boolean;
  muted?: boolean;
  /**
   * Unread conversation: draws the dot. A number is announced ("3 unread messages") but never
   * painted, because macOS Messages draws no count on a row.
   */
  unread?: boolean | number;
  /** Photo variant of the avatar. */
  photo?: string;
  /**
   * Group conversation: its participants, drawn as the stacked group photo in place of one avatar.
   * Two or more entries make it a group; the stack shows the first seven.
   */
  members?: GroupMember[];
  /**
   * Who sent the last message. A group row prefixes its preview with it ("Sam Rivera: Tuesday…").
   * Ignored on a one-to-one row, which never carries a sender.
   */
  sender?: string;
};

export type GroupMember = {
  /** One or two letters. Ignored when `photo` is set. */
  initials: string;
  /** Accessible name, and the name the group photo announces. */
  name?: string;
  photo?: string;
};

export type MacSidebarProps = Omit<ComponentProps<"nav">, "onSelect"> & {
  conversations: SidebarConversation[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** Key window: blue selection. Otherwise the neutral inactive selection. */
  active?: boolean;
  /**
   * The row drawn as though the mouse were held down on it. Controlled; leave it out and the list
   * follows the real pointer. It exists so a scenario can hold the pressed state still for a
   * screenshot, the same way `searchQuery` lets one hold a filtered list still. `null` forces no row.
   */
  pressedId?: string | null;
  /** Footer line, e.g. "Syncing with iCloud Paused". */
  footer?: string;
  /**
   * The search field's text. Controlled; leave it out and the field holds its own, so the field works
   * with nothing wired. Either way a non-empty query replaces the list with the rows that match.
   */
  searchQuery?: string;
  defaultSearchQuery?: string;
  onSearch?: (query: string) => void;
  onOptions?: () => void;
  /** Whether the list-options menu is open, so `aria-haspopup` on the button is not the only half of it. */
  optionsExpanded?: boolean;
};

/** ChatKit's own strings, out of `ChatKit.loctable` (en). */
export const macSidebarSearchStrings = {
  /** `SEARCH_CONVERSATIONS_TITLE`. */
  conversations: "Conversations",
  /** `SEARCH_RESULTS_INDEXING_TITLE`. */
  noResults: "No Results",
  /** `SEARCH`. */
  placeholder: "Search",
} as const;

/**
 * Whether a conversation belongs in the results for `query`. Case-insensitive over the three strings
 * the row already draws — the name, the group sender prefix and the preview — which is what a row can
 * honestly claim to match on. It is **not** ChatKit's search: that indexes every message body through
 * Spotlight and returns five more sections (Messages, Photos, Links, Documents, Locations), none of
 * which this component holds the data for.
 */
export function conversationMatchesQuery(conversation: SidebarConversation, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [conversation.name, conversation.sender, conversation.preview]
    .some(field => field?.toLocaleLowerCase().includes(needle));
}

/**
 * Every run of `text` that matches `query`, as `[start, end)` pairs into `text` itself, so the caller
 * can recolour those characters without rebuilding the string. Non-overlapping and in order, on the
 * same case-insensitive comparison `conversationMatchesQuery` filters with, so a row that is in the
 * results always has at least one range in one of its three fields.
 *
 * Lower-casing can change a string's length (`ẞ` becomes `ss`), which would slide every index past
 * it; when it does, this returns nothing rather than annotating the wrong characters.
 */
export function searchMatchRanges(text: string, query: string): [number, number][] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle || !text) return [];
  const hay = text.toLocaleLowerCase();
  if (hay.length !== text.length) return [];
  const ranges: [number, number][] = [];
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
    ranges.push([at, at + needle.length]);
  }
  return ranges;
}

/**
 * One run of preview text with its matching characters recoloured. Same font, same weight, same size
 * throughout — see the file's note on
 * `+[CKConversationSearchResultEmbeddedCell annotatedResultStringWithSearchText:…]`, which is handed
 * one font for both the primary and the annotated slot and only swaps the colour.
 */
function Annotated({ text, query, color }: { text: string; query: string; color: string }) {
  const ranges = searchMatchRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], index) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<span key={`${start}-${index}`} data-slot="row-match" style={{ color }}>{text.slice(start, end)}</span>);
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

export const macSidebarMetrics = {
  /** The column the window reserves. The panel itself is inset inside it. */
  width: 330,
  panel: { left: 8, top: 8, bottom: 8, width: 320, radius: 18 },
  search: {
    left: 18, top: 52, width: 300, height: 36,
    /** Measured: the magnifier's ink box is 12.5 square at window (32.5, 63.5). */
    glyphLeft: 32.5, glyphTop: 63.5, glyph: 12.5,
    /** Measured: typed text starts on the placeholder's own origin, window x 53, top 61.75. */
    textLeft: 53, textTop: 61.75,
    /**
     * **UNMEASURED.** The ✕ an `NSSearchField` shows once it holds text. No capture has text in the
     * field, so this mirrors what *is* measured: the same 12.5 ink box the magnifier gets, the same
     * 14.5 inset from its own edge of the field that the magnifier has from the left (32.5 − 18), and
     * the same 69.75 centre line. `textRight` is what the typed run then keeps clear of it.
     */
    clear: 12.5, clearRight: 14.5, clearHit: 22, textRight: 33,
  },
  pinned: {
    top: 96, avatar: 73, centerX: 168, avatarCenterY: 142.5, height: 119, labelTop: 184.75,
    // CKPinnedConversationView: the dot is the same Ø9, and `unreadIndicatorPreferredPadding` puts 3
    // between it and the title label, which does not move to make room for it.
    unread: 9, unreadGap: 3,
  },
  row: {
    left: 18, width: 300, height: 80.5, radius: 8, avatar: 40, avatarLeft: 18,
    textLeft: 64, textRight: 10.5, separatorRight: 12, nameTop: 15.75, previewTop: 33, previewLine: 15,
    muted: 11.5, mutedTop: 36.3,
    // ChatKit's own unreadFrame: Ø9 centred in the 18 pt gutter left of the avatar, centred on the row.
    unread: 9, unreadLeft: 4.5,
  },
  footer: { height: 49, textTop: 17.75 },
  options: { centerX: 306, centerY: 25.85 },
  /**
   * Search results, in place of the list. Read out of ChatKit 26.5 with a Catalyst probe that
   * instantiates `CKUIBehaviorMac` directly (no idiom swizzle needed: the behaviour class *is* the
   * idiom), with `CKUIBehaviorPhone` read in the same run for contrast.
   */
  results: {
    /** `-[CKUIBehaviorMac searchHeaderHeight]` = 44 [Phone 44]. */
    headerHeight: 44,
    /** `-[CKUIBehaviorMac searchHeaderFont]` = SF Semibold 17, line 20.0215 [Phone SF Semibold 20]. */
    headerFontSize: 17,
    headerLineHeight: 20.0215,
    /** `-[CKUIBehaviorMac searchConversationSectionInsets]` = {10, 0, 16, 0} [Phone {20, 0, 20, 0}]. */
    sectionTop: 10,
    sectionBottom: 16,
    /** `-[CKUIBehaviorMac searchResultsTitleHeaderBottomPadding]` = 8 [Phone 12]. */
    headerBottomPadding: 8,
  },
  /**
   * How long a separator takes to cross when the selection moves: **zero**. This was 140 ms and
   * carried a note saying it was unverified because no capture held a switch. It is verified now, and
   * it is instant. The user-click path on the list — a `UICollectionView` of
   * `UICollectionViewListCell`, not the table it was first measured as — creates no `CAAnimation` for
   * the cell or for the separators either side of it, so a separator the selection uncovers appears in
   * the same frame the fill leaves. Kept as a named zero rather than deleted so
   * the reduced-motion rule below still has one thing to talk about, and so this note stays attached
   * to the number it corrects.
   */
  selectionFade: 0,
};

/**
 * The plate colour a group stack takes on this row. On an unselected row the component's own fitted
 * translucent fill is right; on a selected one the measured row of `groupAvatarPlate` for #3478f6 is,
 * because the material lifts saturation over the blue and a flat overlay cannot. An inactive window's
 * selection is the neutral `--sb-inactive`, which nothing measured covers, so that keeps the fit.
 */
/** `GroupMember` is this file's shape (`photo`); `GroupAvatar` takes the registry's (`src`). */
function toParticipants(members: readonly GroupMember[]) {
  return members.map(member => ({ name: member.name, initials: member.initials, src: member.photo }));
}

function groupPlateFor(filled: boolean, active: boolean): string | undefined {
  if (!filled || !active) return undefined;
  const measured = groupAvatarPlate.find(row => row.background === "#3478f6")!;
  // One CSS custom property per appearance rather than a media query: the sidebar's dark palette is
  // driven by the `dark` class, and `light-dark()` answers to `color-scheme`, not to that class.
  return `var(--sb-group-plate-selected, ${measured.light})`;
}

/**
 * ChatKit's group photo now lives in `group-avatar.tsx` as `snowglobeStack` / `GroupAvatar`. This file
 * used to carry its own probe of the same `ContactsUICore.SnowglobeUIView` layout and its own
 * `GroupPhoto`; converted to the shared 88-unit box the two tables agreed to 0.000 across all seven
 * rows and all 28 circles, so the merge changed no geometry. The plate the private copy declined to
 * draw is measured there, and `groupPlateFor` above supplies the one background it cannot fit.
 */

/** Sidebar list options: three centred bars, 16.5 / 12.5 / 9.5 wide, 1.25 thick, 4.1 apart. */
function OptionsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16.5 9.45" width="16.5" height="9.45" fill="currentColor">
      <rect x="0" y="0" width="16.5" height="1.25" rx="0.625" />
      <rect x="2" y="4.1" width="12.5" height="1.25" rx="0.625" />
      <rect x="3.5" y="8.2" width="9.5" height="1.25" rx="0.625" />
    </svg>
  );
}

/** Ø10 magnifier with a handle running to the corner: the native ink box is 12.5 square at (32.5, 63.5). */
function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12.5 12.5" width="12.5" height="12.5" fill="none" stroke="currentColor">
      <circle cx="5" cy="5" r="4.4" strokeWidth="1.2" />
      <path d="M8.4 8.4 11.9 11.9" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * xmark.circle.fill, the cancel button of a Mac search field: a filled disc with the cross knocked
 * out of it in the field's own fill, so it reads as a hole rather than as a second stroke.
 * **UNMEASURED** — see `macSidebarMetrics.search.clear`.
 */
function ClearIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12.5 12.5" width="12.5" height="12.5" fill="none">
      <circle cx="6.25" cy="6.25" r="6.25" fill="currentColor" />
      <path d="M4.15 4.15 8.35 8.35M8.35 4.15 4.15 8.35" stroke="var(--sb-field)" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** bell.slash.fill: a filled bell with the slash separated from it by a background-coloured stroke. */
function MutedIcon({ size, color, halo }: { size: number; color: string; halo: string }) {
  return (
    <svg aria-label="Muted" role="img" viewBox="0 0 10 10" width={size} height={size}>
      <path fill={color} d="M5 0.6a2.6 2.6 0 0 0-2.6 2.6c0 2.2-.6 2.9-1.1 3.4a.5.5 0 0 0 .35.85h6.7a.5.5 0 0 0 .35-.85c-.5-.5-1.1-1.2-1.1-3.4A2.6 2.6 0 0 0 5 .6Zm0 8.8a1.2 1.2 0 0 0 1.15-.9h-2.3A1.2 1.2 0 0 0 5 9.4Z" />
      <path stroke={halo} strokeWidth="1.9" strokeLinecap="round" d="M1.5 1.5 8.5 8.5" />
      <path stroke={color} strokeWidth="0.95" strokeLinecap="round" d="M1.5 1.5 8.5 8.5" />
    </svg>
  );
}

/**
 * What an unread row announces. Nothing in ChatKit builds this string, so the wording is ours; the
 * count comes from the caller because macOS Messages never paints one.
 */
function unreadLabel(unread: boolean | number): string {
  if (unread === true) return "Unread";
  return unread === 1 ? "1 unread message" : `${unread} unread messages`;
}

export function MacSidebar({ conversations, selectedId, onSelect, active = true, pressedId, footer, searchQuery, defaultSearchQuery = "", onSearch, onOptions, optionsExpanded, className, style, ...props }: MacSidebarProps) {
  const m = macSidebarMetrics;
  const headerId = useId();
  // The field owns its text unless the caller does, so it works with nothing wired — the same rule
  // the app shell follows for every surface it can open on its own.
  const [ownQuery, setOwnQuery] = useState(defaultSearchQuery);
  /**
   * The row the mouse is holding down. One id, not a flag per row, so a second button or a lost
   * pointer cannot leave a stale fill behind. It clears on release, on a cancel and on leaving the
   * row, so a press that wanders off commits nothing and paints nothing.
   */
  const [ownPressed, setOwnPressed] = useState<string | null>(null);
  const pressed = pressedId !== undefined ? pressedId : ownPressed;
  const release = () => setOwnPressed(current => (current === null ? current : null));
  const press = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    // Primary button only: a right click opens a menu, it does not light the row.
    if (event.button === 0) setOwnPressed(id);
  };
  const query = searchQuery ?? ownQuery;
  const searching = query.trim().length > 0;
  const matches = searching ? conversations.filter(c => conversationMatchesQuery(c, query)) : null;
  // Results replace the list outright, pinned tiles included: on the Mac the search does not cover the
  // window (`searchControllerObscuresConversationList` NO), it takes the list's place inside the panel.
  const pinned = searching ? [] : conversations.filter(c => c.pinned);
  const rows = matches ?? conversations.filter(c => !c.pinned);
  const listTop = searching
    ? m.pinned.top + m.results.sectionTop + m.results.headerHeight + m.results.headerBottomPadding
    : pinned.length ? m.pinned.top + m.pinned.height : m.pinned.top;
  const setQuery = (next: string) => { setOwnQuery(next); onSearch?.(next); };
  return (
    <nav
      data-slot="mac-sidebar"
      data-active={active ? "true" : "false"}
      aria-label="Conversations"
      className={cn(
        "mac-sidebar relative h-full select-none overflow-hidden bg-[#f8f8f8] text-black",
        // `--sb-row-hover` is transparent on purpose: macOS Messages draws no hover fill on a
        // conversation row (four sources in this file's note). It is here as the one seam a product
        // can set if it wants one.
        "[--sb-row-hover:transparent] [--sb-fill:#fafafa] [--sb-rim:#ffffff] [--sb-rim-inner:#fefefe] [--sb-inactive:#e2e2e2] [--sb-name:#000000] [--sb-secondary:#6e6e6d] [--sb-muted:#aeaeae] [--sb-glyph:#232323] [--sb-field:#eeeeee] [--sb-placeholder:#777777] [--sb-separator:#e1e1e1] [--sb-footer-line:#d0d2d7] [--sb-footer-top:#e4e6eb] [--sb-footer-bottom:#eff0f2] [--sb-footer-text:#000000] [--sb-unread:#0088ff] [--sb-group-plate-selected:#a2c7ff]",
        "dark:bg-[#1c1c1c] dark:text-[#f4f4f4]",
        "dark:[--sb-fill:#1b1b1b] dark:[--sb-rim:#424242] dark:[--sb-rim-inner:#323232] dark:[--sb-inactive:#3a3a3a] dark:[--sb-name:#f4f4f4] dark:[--sb-secondary:#a4a4a4] dark:[--sb-muted:#5b5b5b] dark:[--sb-glyph:#dddddd] dark:[--sb-field:#1e1e1e] dark:[--sb-placeholder:#9a9a9a] dark:[--sb-separator:#3a3a3a] dark:[--sb-footer-line:#43454a] dark:[--sb-footer-top:#27292e] dark:[--sb-footer-bottom:#27272a] dark:[--sb-footer-text:#f5f5f5] dark:[--sb-unread:#0091ff] dark:[--sb-group-plate-selected:#264a8f]",
        className,
      )}
      style={{ width: m.width, fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif", ...style }}
      {...props}
    >
      {/*
        Native draws continuous corners: a plain circle of radius 18 (panel) / 8 (row selection) is the
        closest circular fit, so browsers with `corner-shape` get the superellipse the capture shows.
      */}
      <style>{`
        .mac-sidebar-panel { border-radius: ${m.panel.radius}px; }
        .mac-sidebar-row { border-radius: ${m.row.radius}px; }
        @supports (corner-shape: superellipse(1.4)) {
          .mac-sidebar-panel { border-radius: 22px; corner-shape: superellipse(1.4); }
          .mac-sidebar-row { border-radius: 10px; corner-shape: superellipse(1.4); }
        }
        .mac-sidebar-separator { transition: opacity ${m.selectionFade}ms linear; }
        @media (prefers-reduced-motion: reduce) { .mac-sidebar-separator { transition: none; } }
        /* The hover fill is a child layer rather than the button's own background, because the
           button's background carries the selected and pressed fills inline and an inline value
           cannot be reached by a :hover rule. Only a row that is neither selected nor held takes it,
           and --sb-row-hover is transparent unless a product sets it. */
        .mac-sidebar-hover { background: var(--sb-row-hover); opacity: 0; }
        [data-slot="sidebar-row"][data-selected="false"]:not([data-pressed="true"]) .mac-sidebar-row:hover > .mac-sidebar-hover { opacity: 1; }
      `}</style>
      <div
        aria-hidden="true"
        data-slot="sidebar-panel"
        className="mac-sidebar-panel absolute bg-[var(--sb-fill)]"
        style={{ left: m.panel.left, top: m.panel.top, bottom: m.panel.bottom, width: m.panel.width, // The panel rim is two device pixels and they are not the same colour: #424242 outside,
          // #323232 inside on dark. One 1 pt ring paints both columns the same and reads too bright.
          boxShadow: "0 0 20px rgba(0,0,0,0.05), inset 0 0 0 0.5px var(--sb-rim), inset 0 0 0 1px var(--sb-rim-inner)" }}
      />

      <button type="button" data-slot="sidebar-options" aria-label="Conversation list options" aria-haspopup="menu" aria-expanded={optionsExpanded} onClick={onOptions}
        className="absolute flex size-[26px] items-center justify-center rounded-full text-[var(--sb-glyph)] hover:bg-black/5 dark:hover:bg-white/10"
        style={{ left: m.options.centerX - 13, top: m.options.centerY - 13 }}>
        <OptionsIcon />
      </button>

      <label data-slot="sidebar-search" className="absolute flex items-center bg-[var(--sb-field)] text-[var(--sb-placeholder)]"
        style={{ left: m.search.left, top: m.search.top, width: m.search.width, height: m.search.height, borderRadius: m.search.height / 2 }}>
        <span aria-hidden="true" className="absolute" style={{ left: m.search.glyphLeft - m.search.left, top: m.search.glyphTop - m.search.top }}><SearchIcon /></span>
        <span className="sr-only">Search conversations</span>
        {/* `data-slot="sidebar-search-input"` is how the window puts ⌘F on this field
            (`macos-messages-app.tsx`); nothing else keys off it. */}
        <input type="search" data-slot="sidebar-search-input" placeholder={macSidebarSearchStrings.placeholder} value={query}
          onChange={event => setQuery(event.target.value)}
          // Escape empties a Mac search field before it does anything else, which is why it stops here
          // rather than reaching the window's own Escape handling.
          onKeyDown={event => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }}
          className="absolute bg-transparent text-[13px] leading-[16px] text-[var(--sb-name)] outline-none placeholder:font-medium placeholder:text-[var(--sb-placeholder)] [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
          style={{ left: m.search.textLeft - m.search.left, right: searching ? m.search.textRight : 8, top: m.search.textTop - m.search.top }} />
        {/* Only while there is something to clear, so the empty field every capture holds is
            untouched. It clears the text and keeps the caret, which is what a Mac search field does. */}
        {searching && (
          <button type="button" data-slot="sidebar-search-clear" aria-label="Clear search"
            onClick={event => {
              setQuery("");
              (event.currentTarget.parentElement?.querySelector<HTMLInputElement>('[data-slot="sidebar-search-input"]'))?.focus();
            }}
            className="absolute flex items-center justify-center rounded-full text-[var(--sb-placeholder)] outline-offset-1 focus-visible:outline-2 focus-visible:outline-[#3478f6]"
            style={{ right: m.search.clearRight - (m.search.clearHit - m.search.clear) / 2, top: m.search.glyphTop + m.search.glyph / 2 - m.search.top - m.search.clearHit / 2, width: m.search.clearHit, height: m.search.clearHit }}>
            <ClearIcon />
          </button>
        )}
      </label>

      {/* The results header. `searchHeaderHeight` and `searchHeaderFont` are the framework's; the
          leading edge is the rows' own 18, which is a choice — no capture shows this state. */}
      {searching && (
        <h2 id={headerId} data-slot="sidebar-results-header"
          className="absolute m-0 flex items-center font-semibold text-[var(--sb-name)]"
          style={{ left: m.row.left, top: m.pinned.top + m.results.sectionTop, width: m.row.width,
            height: m.results.headerHeight, fontSize: m.results.headerFontSize, lineHeight: `${m.results.headerLineHeight}px` }}>
          {macSidebarSearchStrings.conversations}
        </h2>
      )}
      {/* Nothing moves on screen when the filter narrows, so the count is what tells a screen reader
          the list changed. ChatKit builds no such string; the wording is ours. */}
      {searching && rows.length > 0 && (
        <p role="status" className="sr-only">{rows.length === 1 ? "1 conversation found" : `${rows.length} conversations found`}</p>
      )}
      {/* UNMEASURED: nothing in `references/macos/captures` holds an empty result set, so this line
          borrows the header's own type and centres it in the space the rows would have taken. */}
      {searching && rows.length === 0 && (
        <p data-slot="sidebar-no-results" role="status"
          className="absolute m-0 text-center font-semibold text-[var(--sb-secondary)]"
          style={{ left: m.row.left, top: listTop + m.results.sectionBottom, width: m.row.width,
            fontSize: m.results.headerFontSize, lineHeight: `${m.results.headerLineHeight}px` }}>
          {macSidebarSearchStrings.noResults}
        </p>
      )}

      {pinned.length > 0 && (
        <ul data-slot="sidebar-pinned" aria-label="Pinned" className="absolute flex list-none justify-center gap-[24px] p-0"
          style={{ left: m.panel.left, top: m.pinned.top, width: m.panel.width, height: m.pinned.height }}>
          {pinned.map(c => {
            const selected = c.id === selectedId;
            return (
              <li key={c.id} className="flex w-[96px] flex-col items-center">
                <button type="button" aria-current={selected ? "true" : undefined} onClick={() => onSelect?.(c.id)}
                  className="flex flex-col items-center rounded-[14px] outline-offset-2 focus-visible:outline-2 focus-visible:outline-[#3478f6]"
                  style={{ paddingTop: m.pinned.avatarCenterY - m.pinned.top - m.pinned.avatar / 2 }}>
                  {c.unread ? <span className="sr-only">{unreadLabel(c.unread)}. </span> : null}
                  {c.members && c.members.length > 1
                    ? <GroupAvatar size={m.pinned.avatar} name={c.name} participants={toParticipants(c.members)}
                        style={selected ? { boxShadow: `0 0 0 2px ${active ? "#3478f6" : "#9a9a9a"}`, borderRadius: "50%" } : undefined} />
                    : <Avatar size={m.pinned.avatar} initials={c.initials} src={c.photo} name={c.name}
                        style={selected ? { boxShadow: `0 0 0 2px ${active ? "#3478f6" : "#9a9a9a"}` } : undefined} />}
                  {/* The tile's label stays centred whether or not there is a dot; the dot hangs off its
                      leading edge, which is what CKPinnedConversationView's own layout does. */}
                  <span className="relative flex max-w-[96px]" style={{ marginTop: m.pinned.labelTop - (m.pinned.avatarCenterY + m.pinned.avatar / 2) }}>
                    {c.unread ? (
                      <span aria-hidden="true" data-slot="pinned-unread" className="absolute rounded-full"
                        style={{ right: "100%", marginRight: m.pinned.unreadGap, top: (13 - m.pinned.unread) / 2, width: m.pinned.unread, height: m.pinned.unread, background: "var(--sb-unread)" }} />
                    ) : null}
                    <span data-slot="pinned-name" className="truncate text-[11px] leading-[13px] text-[var(--sb-secondary)]">{c.name}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <ul data-slot="sidebar-rows" role="list" aria-labelledby={searching ? headerId : undefined} className="absolute m-0 list-none p-0" style={{ left: m.row.left, top: listTop, width: m.row.width }}>
        {rows.map((c, index) => {
          const selected = c.id === selectedId;
          // A held row wears the selected fill: `CKConversationListCell` is a `UITableViewCell`, and
          // a table cell paints one `selectedBackgroundView` for `highlighted` and `selected` alike.
          const held = c.id === pressed;
          const filled = selected || held;
          const nextRow = rows[index + 1];
          const nextFilled = nextRow !== undefined && (nextRow.id === selectedId || nextRow.id === pressed);
          const fill = active ? "#3478f6" : "var(--sb-inactive)";
          // Inactive windows keep the neutral text colors on the gray selection.
          const highlighted = filled && active;
          const secondary = highlighted ? "#d6e4fd" : "var(--sb-secondary)";
          // The annotated run takes `conversationListSenderColor`, which is the colour the name label
          // takes on this row; on a selected row both go to the white the name goes to.
          const matched = highlighted ? "#ffffff" : "var(--sb-name)";
          return (
            <li key={c.id} data-slot="sidebar-row" data-selected={selected ? "true" : "false"} data-pressed={held ? "true" : undefined} className="relative" style={{ height: m.row.height }}>
              <button type="button" aria-current={selected ? "true" : undefined} onClick={() => onSelect?.(c.id)}
                onPointerDown={event => press(event, c.id)} onPointerUp={release} onPointerCancel={release} onPointerLeave={release}
                className="mac-sidebar-row absolute inset-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#3478f6]/60"
                style={{ background: filled ? fill : "transparent" } as CSSProperties}>
                {/* First child, so every avatar and label still paints over it. */}
                <span aria-hidden="true" data-slot="row-hover" className="mac-sidebar-hover pointer-events-none absolute inset-0 rounded-[inherit] [corner-shape:inherit]" />
                {c.unread ? (
                  <>
                    {/* First in the row so the announcement leads: "Unread, Alex Morgan, Yesterday, ...". */}
                    <span className="sr-only">{unreadLabel(c.unread)}. </span>
                    {/* The dot lies inside the selection fill, so it takes the same white the labels take. */}
                    <span aria-hidden="true" data-slot="row-unread" className="absolute rounded-full"
                      style={{ left: m.row.unreadLeft, top: (m.row.height - m.row.unread) / 2, width: m.row.unread, height: m.row.unread, background: highlighted ? "#ffffff" : "var(--sb-unread)" }} />
                  </>
                ) : null}
                {c.members && c.members.length > 1
                  ? <GroupAvatar size={m.row.avatar} name={c.name} participants={toParticipants(c.members)} plate={groupPlateFor(filled, active)}
                      className="absolute" style={{ left: m.row.avatarLeft, top: (m.row.height - m.row.avatar) / 2 }} />
                  : <Avatar size={m.row.avatar} initials={c.initials} src={c.photo} name={c.name} className="absolute" style={{ left: m.row.avatarLeft, top: (m.row.height - m.row.avatar) / 2 }} />}
                <span className="absolute flex items-baseline justify-between gap-2" style={{ left: m.row.textLeft, right: m.row.textRight, top: m.row.nameTop }}>
                  <span data-slot="row-name" className="truncate text-[13px] font-semibold leading-[16px]" style={{ color: highlighted ? "#ffffff" : "var(--sb-name)" }}>{c.name}</span>
                  <span data-slot="row-time" className="shrink-0 text-[12px] leading-[15px]" style={{ color: secondary }}>{c.time}</span>
                </span>
                <span data-slot="row-preview" className="absolute line-clamp-2 text-[12px] leading-[15px]"
                  style={{ left: m.row.textLeft, right: m.row.textRight, top: m.row.previewTop, color: secondary }}>
                  {/* A group row names the sender first. Same type and same gray: it is one run of
                      preview text, wrapping and clamping with the rest of it. While searching, the
                      characters that match are recoloured in place — the summary label is the only
                      one ChatKit annotates, so the name above stays exactly as it is. */}
                  {c.sender && c.members && c.members.length > 1
                    ? <span data-slot="row-sender">{searching ? <Annotated text={c.sender} query={query} color={matched} /> : c.sender}: </span>
                    : null}
                  {searching ? <Annotated text={c.preview} query={query} color={matched} /> : c.preview}
                </span>
                {c.muted && (
                  <span className="absolute" style={{ right: m.row.separatorRight, top: m.row.mutedTop }}>
                    <MutedIcon size={m.row.muted} color={highlighted ? "#d6e4fd" : "var(--sb-muted)"} halo={filled ? fill : "var(--sb-fill)"} />
                  </span>
                )}
              </button>
              {/* Native draws no separator above or below the selected row. Mounting it always and
                  crossing its opacity is what makes a switch read as one move: the pair the selection
                  is leaving fades up while the pair it is arriving at fades down, over the same span
                  the highlight travels. Mounting it conditionally instead pops one in at the departing
                  row and one out at the arriving row on the click, while the highlight is still in
                  flight. A transition, not a keyframe animation, so a seeked frame carries none of it
                  and `document.getAnimations()` still reaches the live one. */}
              {index < rows.length - 1 && (
                <span aria-hidden="true" data-slot="row-separator" className="mac-sidebar-separator absolute bottom-0 h-px bg-[var(--sb-separator)]"
                  style={{ left: m.row.textLeft, right: m.row.separatorRight, opacity: filled || nextFilled ? 0 : 1 }} />
              )}
            </li>
          );
        })}
      </ul>
      {footer && (
        <div data-slot="sidebar-footer" className="absolute overflow-hidden"
          style={{ left: m.panel.left, bottom: m.panel.bottom, width: m.panel.width, height: m.footer.height, borderRadius: `0 0 ${m.panel.radius}px ${m.panel.radius}px` }}>
          <div aria-hidden="true" className="absolute inset-0" style={{ background: "linear-gradient(to bottom, var(--sb-footer-top), var(--sb-footer-bottom))", boxShadow: "inset 0 1px 0 var(--sb-footer-line)" }} />
          <p className="absolute left-0 m-0 w-full text-center text-[10px] leading-[12px] text-[var(--sb-footer-text)]" style={{ top: m.footer.textTop }}>{footer}</p>
        </div>
      )}
    </nav>
  );
}
