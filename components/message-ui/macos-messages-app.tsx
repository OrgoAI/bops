"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { PlatformProvider } from "@/components/message-ui/platform";
import { PaletteStyle } from "@/components/message-ui/palette";
import { MacWindow, macWindowMetrics } from "@/components/message-ui/macos-window";
import { MacSidebar, macSidebarMetrics, type SidebarConversation } from "@/components/message-ui/macos-sidebar";
import { MacHeader, macHeaderMetrics, type MacHeaderMember } from "@/components/message-ui/macos-header";
import { MacComposer } from "@/components/message-ui/macos-composer";
import { MessageList, type Message, type MessageListHandle } from "@/components/message-ui/message-list";
import { ContextMenu, macosListFilterMenu, macosMessageMenu } from "@/components/message-ui/context-menu";
import { TapbackBar, type TapbackSelection } from "@/components/message-ui/tapback-bar";
import { MacPlusMenu, macPlusMenuMetrics } from "@/components/message-ui/macos-plus-menu";
import { MacDetails, type MacDetailsAction, type MacDetailsAttachment, type MacDetailsHandle, type MacDetailsLink, type MacDetailsParticipant, type MacDetailsPhoto, type MacDetailsTab } from "@/components/message-ui/macos-details";
import { PhotoPicker, photoPickerSamples, type PhotoPickerDetent, type PhotoPickerPhoto } from "@/components/message-ui/photo-picker";
import { StickerPicker, type Sticker, type StickerPlacement } from "@/components/message-ui/sticker-picker";
import { defaultReactions } from "@/components/message-ui/ios-messages-app";
import { prefersReducedMotion, useArrivalAnimation, type ArrivalAnimation } from "@/components/message-ui/message-motion";

/**
 * The pane's log is anchored to the bottom. `listBottom` 58.2 puts "Delivered" ink at y 573 with the
 * composer field starting at 596, matching conversation-pane-dark-2.png; the 52 it replaces pushed the
 * whole log 5pt down (8.6% pixel mismatch against that capture instead of 2.8%).
 */
export const macScreen = { width: macWindowMetrics.width, height: macWindowMetrics.height, sidebar: macWindowMetrics.sidebarWidth, listTop: 84.3, listBottom: 58.2 } as const;

/**
 * The window's own transitions: switching conversation, and the two popovers appearing.
 *
 * **NOT MEASURED.** `references/` holds no capture or recording of a macOS conversation switch, of the
 * "+" popover opening, or of a window losing key, so every number below is chosen to sit in the family
 * of the macOS motion that *is* measured: the 183 ms menu dissolve of
 * `tapback-apply-frames-100-123.png`, the 120 ms dismissal `context-menu.tsx` already ships, and the
 * 110 ms tapback rise. They sit at the short end of that range on purpose, because a switch moves
 * nothing but the pane's content: the window, the sidebar and the composer all stay where they are.
 * The one number here that came from a capture is the inactive panel fill below.
 */
export const macTransitions = {
  /** Conversation switch: the pane dissolves while the arriving content rises `shift` points into place. */
  conversation: { duration: 140, shift: 6, dissolve: 0.62 },
  /**
   * **The sidebar's selection does not animate, and this is why there is no constant for it.**
   *
   * This used to be `{ duration: 140, text: 110 }`, driving a blue tile that travelled between rows
   * while the two rows' text cross-faded. Nothing native does that.
   *
   * The container first: the Mac conversation list is a **`UICollectionView`**, not a table.
   * `-[CKUIBehavior conversationListTableViewClass]` answers nil at every idiom, and
   * `CKConversationListCollectionViewController` is the only conversation-list view controller in the
   * framework. Its cell is `CKConversationListCollectionViewConversationCell` :
   * `CKConversationListEmbeddedCollectionViewCell` : `UICollectionViewListCell`, and that base class
   * carries a `UITableViewCell` as *content* (`_embeddedTableViewCell`, `forwardStateToEmbeddedCell:`)
   * whose own `backgroundColor` is clear — the fill is painted by a `_UISystemBackgroundView` from a
   * `UIBackgroundConfiguration`. (This is worth spelling out because the first measurement of it read
   * the embedded table cell and took that for the list.)
   *
   * The finding survives the correction, and was reproduced on both containers at both idioms: the
   * user-click path creates **zero** `CAAnimation`s. The leaving fill, the arriving fill and the
   * separators either side all change in the same instant, and there is no shared highlight view
   * anywhere in the list to travel between them.
   *
   * UIKit does own an animated selection path, for callers that pass `animated:YES` — which the click
   * never does. On the collection list it runs **0.3 s** on `cubic-bezier(0.42, 0, 0.58, 1)`; 0.5 s is
   * the table's number, for the container the app does not use, and neither is the `CATransaction`
   * default of 0.25 s. Even that path is two in-place cross-fades with nothing travelling.
   *
   * The pane's own crossfade below is a different thing and stays; it was measured separately.
   */
  /**
   * The context menu appearing. Its dismissal is the 120 ms `context-menu.tsx` already owns, and the
   * plus popover owns both ends of its own presentation (`macPlusMenuMetrics.motion`), which grows
   * from this same 0.96 on this same curve.
   */
  menu: { open: 110, scale: 0.96 },
} as const;

/**
 * The two surfaces the "+" popover's own rows open, and the box each gets.
 *
 * The macOS "+" is a **menu**, not the iPhone's app strip: `-[CKUIBehaviorMac
 * browserButtonShouldUseMenu]` is YES where `CKUIBehaviorPhone`'s is NO, and
 * `-[CKUIBehaviorMac entryViewSupportsBrowserButton]` is NO. So a row is chosen and a popover opens,
 * which is what these are. Both sizes are Catalyst-probe readings off `CKUIBehaviorMac` in ChatKit
 * 26.5, with the Phone reading beside them so the swap is visible:
 *
 * - `stickerPopoverSize` = **{320, 480}** on the Mac and {393, 680} on the Phone. The iPhone sheet
 *   `sticker-picker.tsx` measures is that 393 wide one, which is why it is not simply re-used at its
 *   own size here.
 * - There is **no** photo-specific popover selector on either behaviour class — the whole
 *   `browser|picker|popover` selector list on `CKUIBehaviorMac` was dumped and it holds none — so the
 *   Photos row takes the generic Mac popover, `popOverWidth` = **252** by `popOverMaxHeight` = **400**.
 *
 * **UNMEASURED, and this is the honest part.** No capture in `references/macos/captures` holds either
 * popover, so only their *sizes* are sourced. Where they sit is a rule, not a reading: they take the
 * "+" menu's own measured leading edge (pane x 9, flush with the button) and open **upward**, their
 * bottom edge on the menu's measured top edge, because neither box fits below the button in a 640 pt
 * window and an AppKit popover flips rather than hangs. The corner is `macPlusMenuMetrics.radius`,
 * the one macOS popover corner a capture does hold; the iPhone sheets' own 40.42 / 60.33 corners are
 * struck off, because those are concentric with the iPhone 17 Pro's 62.9 display corner and mean
 * nothing on a desktop. Everything *inside* each popover is still the iPhone surface's measured
 * layout, re-flowed to the new width by each component's own `width` prop.
 *
 * The **chrome** each box wears is the one macOS popover a capture does hold: the fill, the bright
 * inset rim and the dark hairline outside it that `macos-plus-menu.tsx` measured off
 * `plus-menu-{light,dark}-2x.png`, copied here rather than imported the way that file's own note
 * describes. Each sheet's own iPhone fill is switched off in `macAppStyles` so this one shows: an
 * iPhone form sheet's glass over a Mac popover's glass would blur the pane twice.
 */
export const macAttachmentPopovers = {
  stickers: { width: 320, height: 480 },
  photos: { width: 252, height: 400 },
  left: macPlusMenuMetrics.left,
  bottom: macPlusMenuMetrics.top,
  radius: macPlusMenuMetrics.radius,
} as const;

/** `-[CKUIBehaviorMac popoverPadding]` = 7: what a Mac popover keeps clear inside its own box. */
const macPopoverPadding = 7;

/**
 * The window's own keyboard equivalents, read off the live macOS 26 Messages menu bar through the
 * accessibility API (`AXMenuItemCmdChar` and `AXMenuItemCmdModifiers` on each item; modifiers 0 is a
 * bare ⌘, 2 is ⌥⌘). Every one of them is a menu item this shell can actually carry out; the ones it
 * cannot — Edit ▸ Find ▸ Find Next ⌘G, View ▸ Messages/Spam/Recently Deleted ⌘1/2/3 — are left alone
 * rather than bound to something that only reports.
 */
export const macShortcuts = {
  /**
   * **File ▸ New Message**, "N" / 0. Read the same way as the other three, off the live macOS 26
   * Messages menu bar: the first item of the File menu, `AXMenuItemCmdChar` "N" and
   * `AXMenuItemCmdModifiers` 0 (a bare ⌘). On the Mac it opens no sheet and no window — the window
   * you are in becomes the compose window.
   */
  newMessage: "n",
  /** **Edit ▸ Find ▸ Find…**, "F" / 0. On the Mac that is the sidebar's search field, not an overlay. */
  find: "f",
  /** **Edit ▸ Select All**, "A" / 0. Selects every message in the transcript. */
  selectAll: "a",
  /** **Conversation ▸ Show Details**, "I" / 2. */
  details: "i",
} as const;

/**
 * New Message, the macOS way.
 *
 * **The Mac does not present anything.** iOS pushes a modal sheet over the list
 * (`ios-new-message-sheet.tsx`, measured off `newmsg-light.png`); the Mac has no sheet, no screen and
 * no second window. Composing replaces this window's *transcript* with a "To:" field
 * (`macos-header.tsx`, `compose`) over an empty log, and adds one row to the conversation list which
 * is the one selected. Nothing else about the window moves: the sidebar, the composer, the traffic
 * lights and the window's own chrome are exactly where they were, which is why this is a state of the
 * window rather than a surface presented over it.
 *
 * **No capture holds it**, so the two strings are ChatKit's own, out of `ChatKit.loctable` (en), and
 * the row's shape is this window's own measured row: the draft has no participant yet, so its avatar
 * is the `CKAvatarView` placeholder (`Avatar`'s silhouette) and it carries no preview and no time,
 * because a draft has neither. The row's id is a sentinel that cannot collide with a caller's:
 * `selectedId` while composing is this, not the conversation the pane was showing.
 */
export const macCompose = {
  /** `NEW_MESSAGE`. What the draft's row in the conversation list reads. */
  title: "New Message",
  /** The sentinel id the draft row takes in the sidebar. */
  rowId: "__com.apple.messages.new-message",
} as const;

/** An empty transcript, hoisted so a composing frame hands `MessageList` the same array every render. */
const noMessages: Message[] = [];

/**
 * Whether the keystroke belongs to a text field rather than to the window. ⌘A inside the composer or
 * the search field selects that field's text — AppKit's first responder gets it first — so the
 * transcript's ⌘A has to stand down for one.
 */
function isTextEntry(node: Element | null): boolean {
  const element = node as HTMLElement | null;
  if (!element) return false;
  return element.isContentEditable || element.tagName === "INPUT" || element.tagName === "TEXTAREA";
}

/** The measured popover fill, rim and outline of `macos-plus-menu.tsx`, on both appearances. */
const popoverChrome = cn(
  "bg-[var(--pm-fill)] shadow-[var(--pm-edge)] backdrop-blur-[20px]",
  "[--pm-edge:inset_0_0_0_1px_rgba(255,255,255,0.8),0_0_0_0.5px_rgba(0,0,0,0.28),0_4px_16px_rgba(0,0,0,0.12)] [--pm-fill:rgba(238,240,241,0.92)]",
  "dark:[--pm-edge:inset_0_0_0_1px_rgba(255,255,255,0.28),0_0_0_0.5px_rgba(0,0,0,0.85),0_4px_16px_rgba(0,0,0,0.35)] dark:[--pm-fill:rgba(37,39,40,0.94)]",
);

/**
 * Rules the app needs on elements it does not own: a sidebar row (`macos-sidebar.tsx`), the header it
 * clones while a conversation is leaving (`macos-header.tsx`), and the chrome of a window that is not
 * key. Everything is keyed on this component's own root or on a node only this file renders, so a
 * second app on the same page is untouched.
 *
 * The inactive window is half measured: **#292929** is the panel fill of an inactive dark window, read
 * off a full-window frame held outside the repo (SPEC, "Still unverified"), and the rest is AppKit's
 * convention rather than a capture: an inactive window draws its toolbar glyphs at about half strength,
 * and its accents (the traffic lights and the selected row) already go neutral in `macos-window.tsx`
 * and `macos-sidebar.tsx`. No capture of an inactive *light* window exists, so light keeps its fill.
 */
const macAppStyles = `
[data-slot="header-outgoing"] [data-slot="header-glass"],[data-slot="header-outgoing"] [data-slot="compose-button"],[data-slot="header-outgoing"] [data-slot="video-button"]{display:none}
:where(.dark,.dark *) [data-slot="macos-messages-app"][data-active="false"] [data-slot="mac-sidebar"]:not(:where([data-preview-theme="light"] *)){--sb-fill:#292929}
[data-slot="macos-messages-app"][data-active="false"] :is([data-slot="compose-button"],[data-slot="video-button"],[data-slot="add-recipient-button"],[data-slot="attach-button"],[data-slot="emoji-button"],[data-slot="sidebar-options"]){opacity:0.5}
[data-slot="mac-attachment-popover"] [data-slot="sheet"]{border-radius:${macAttachmentPopovers.radius}px!important;background:transparent!important;box-shadow:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
[data-slot="mac-attachment-popover"] [data-slot="photo-picker"]{clip-path:inset(0 round ${macAttachmentPopovers.radius}px)!important;background:transparent!important}
`;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** The monogram a name falls back to when nobody supplied one: its first two words' initials. */
function initialsOf(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0] ?? "").join("").toUpperCase();
}

/**
 * Click-to-select, the way a Mac list behaves: a plain click replaces the selection, cmd toggles one
 * message, and shift extends from the anchor, which is whichever message a plain or cmd click last
 * touched. `order` is the conversation in display order.
 */
export function nextMessageSelection(order: readonly string[], selected: readonly string[], id: string, modifiers: { shiftKey?: boolean; metaKey?: boolean }, anchor: string | null): string[] {
  if (modifiers.metaKey) return selected.includes(id) ? selected.filter(other => other !== id) : [...selected, id];
  if (modifiers.shiftKey) {
    const from = order.indexOf(anchor ?? id);
    const to = order.indexOf(id);
    if (from < 0 || to < 0) return [id];
    return order.slice(Math.min(from, to), Math.max(from, to) + 1);
  }
  return [id];
}

export type MacMessagesAppProps = {
  width?: number;
  height?: number;
  /** Key window: colored traffic lights and the blue selection. */
  active?: boolean;
  conversations?: SidebarConversation[];
  selectedId?: string;
  onSelectConversation?: (id: string) => void;
  contact: { name: string; initials?: string; photo?: string };
  group?: boolean;
  /**
   * Who else is in a group conversation. Two or more puts the Snowglobe stack in the header's Ø40
   * avatar slot, gives the sidebar row for *this* conversation the same stack, and fills the details
   * pane's participant list. Leave it out on a group and the shell reads it off the transcript
   * instead — one entry per person who has spoken, in the order they first did — so a caller that
   * only sets `group` still gets the group chrome rather than a monogram.
   */
  participants?: readonly MacHeaderMember[];
  messages: Message[];
  typing?: boolean | { sender?: string };
  now?: Date | number;
  composer?: { value?: string; disabled?: boolean; onChange?: (value: string) => void; onSend?: (text: string) => void | Promise<void>; onAttach?: () => void; onEmoji?: () => void; onAudio?: () => void };
  /**
   * A new message is being composed. Same `prop ?? shell-held` contract as every other surface here:
   * leave it out and the header's compose button and ⌘N open it themselves, so New Message works with
   * nothing wired; pass it (even `null`) to own that state. `recipient` is the text in the "To:" field.
   *
   * See `macCompose` for why this is a state of the window rather than something presented over it.
   */
  compose?: { recipient?: string } | null;
  /** The compose button, ⌘N, or a caller's own New Message. Fires as compose opens. */
  onCompose?: () => void;
  /** Typing in the "To:" field. */
  onComposeRecipientChange?: (value: string) => void;
  /** The ⊕ at the end of the "To:" field: on the Mac this is the system contact picker, which this kit cannot own. */
  onAddRecipient?: () => void;
  /** Compose was left — by choosing a conversation in the sidebar, which is what ends it natively. */
  onComposeClose?: () => void;
  onVideoCall?: () => void;
  onDetails?: () => void;
  /**
   * Omit to animate appended outgoing messages automatically; null disables automatic sends.
   * That message was just sent: the composer's text row becomes its bubble and flies to its slot.
   * With `progress` the animation is seeked to `progress * duration` instead of played.
   */
  sendAnimation?: ArrivalAnimation | null;
  /** That message just arrived: it pops in from the typing indicator's position. */
  receiveAnimation?: ArrivalAnimation | null;
  /** Called when a played (not seeked) send animation finishes. */
  onSendAnimationEnd?: () => void;
  /**
   * Messages a click has selected. Click-to-select is **always on** in the macOS pane, because that
   * is what a Mac list does and there is no mode to enter: a click selects one message, cmd toggles,
   * shift extends, ⌘A takes all of them, a click on anything else in the pane clears, and so does
   * Escape. Pass this (even empty) to own that state; leave it out and the shell holds it, the same
   * `prop ?? shell-held` contract every surface here follows, so the click that selects natively
   * selects here with nothing wired.
   *
   * iOS has no equivalent — its multi-select is the checkbox mode in `ios-select-mode.tsx`, entered
   * from a menu — which is why this is a macOS-only prop.
   */
  selectedMessageIds?: readonly string[];
  /** The selection a click, a right click or an arrow key just produced. `id` is the message it acted on. */
  onSelectMessage?: (ids: string[], context: { id: string | null; shiftKey: boolean; metaKey: boolean }) => void;
  /** Right-click menu anchored at a point inside the pane (pane coordinates). */
  contextMenu?: { id: string; x: number; y: number } | null;
  onContextMenu?: (id: string, x: number, y: number) => void;
  onContextMenuClose?: () => void;
  onTapback?: (id: string, selection: TapbackSelection) => void;
  onMenuAction?: (id: string, action: string) => void;
  /** Play a message's effect again — the Replay control under a message sent with one. */
  onReplayEffect?: (id: string) => void;
  /** The plus-button popover. */
  plusMenu?: boolean;
  onPlusMenuSelect?: (id: string) => void;
  onPlusMenuClose?: () => void;
  /**
   * The search field in the sidebar. It filters the list in place with nothing wired — on the Mac
   * `-[CKUIBehaviorMac searchControllerObscuresConversationList]` is NO, so the results *are* the
   * list — and this only reports what was typed. Pass `searchQuery` to own the text instead.
   * ⌘F (Edit ▸ Find ▸ Find…) puts the caret in that field and selects whatever is already in it;
   * Escape empties it, and the ✕ inside it clears it with the pointer.
   */
  searchQuery?: string;
  onSearch?: (query: string) => void;
  // ---------------------------------------------------------------------------------------------
  // The surfaces the window can present. Each takes a prop that states it — with `progress` where
  // there is a transition to seek — and, with that prop left out, is held by the shell, so the click
  // that opens it natively opens it here with nothing wired. Same contract as the iOS shell.
  // ---------------------------------------------------------------------------------------------
  /**
   * The conversation details inspector, open beside the transcript. Null (or absent while nothing has
   * opened it) leaves the pane alone. `progress` seeks the slide instead of playing it. `onDetails`
   * already fires from the header's name pill; ⌥⌘I toggles it, which is what Conversation ▸ Show
   * Details is bound to in macOS 26 Messages (read off the live app's menu bar:
   * `AXMenuItemCmdChar` "I", `AXMenuItemCmdModifiers` 2).
   */
  details?: { open: boolean; progress?: number; tab?: MacDetailsTab; width?: number; mode?: "push" | "overlay" } | null;
  onDetailsClose?: () => void;
  onDetailsTabChange?: (tab: MacDetailsTab) => void;
  onDetailsWidthChange?: (width: number) => void;
  /** What the inspector shows. Shared media the app already knows about goes here. */
  detailsContent?: {
    subtitle?: string;
    actions?: MacDetailsAction[];
    handles?: MacDetailsHandle[];
    photos?: MacDetailsPhoto[];
    links?: MacDetailsLink[];
    attachments?: MacDetailsAttachment[];
    hideAlerts?: boolean; onHideAlertsChange?: (next: boolean) => void;
    readReceipts?: boolean; onReadReceiptsChange?: (next: boolean) => void;
    sharedWithYou?: boolean; onSharedWithYouChange?: (next: boolean) => void;
    onLeave?: () => void; onBlock?: () => void; onDelete?: () => void;
    participants?: MacDetailsParticipant[];
  };
  /**
   * A photo in the transcript was opened — clicked, or Space pressed on the message that holds it.
   *
   * **There is no in-window photo viewer on macOS, and this shell deliberately does not draw one.**
   * `-[CKChatController(QuickLook) _displayPreviewItemForMediaObject:]` allocates `CKQLPreviewController`
   * and presents it modally only when `_CKIsRunningInMacCatalyst()` is false; on Catalyst it skips both
   * and calls `-presentPreview`, which is AppKit's Quick Look panel — a system window this kit cannot
   * own. macOS 26 Messages confirms it from the outside: its File menu carries **Quick Look** (read off
   * the live app), and the transcript has no full-screen viewer to open. `image-viewer.tsx` ships a
   * `chrome.macos` for the iOS viewer; that is the surface iOS presents, not the one the Mac does, so
   * it is not used here. Wire this to whatever stands in for the system panel.
   */
  onQuickLook?: (id: string, index: number) => void;
  /** The Photos popover the "+" menu's "Photos" row opens. `progress` seeks its entrance. */
  photoPicker?: { selected?: string[]; detent?: PhotoPickerDetent; progress?: number } | null;
  /** What that popover offers. Defaults to `photoPickerSamples`. */
  photos?: PhotoPickerPhoto[];
  onPhotoPickerSelectionChange?: (selected: string[]) => void;
  onPhotoPickerClose?: () => void;
  /** The Stickers popover the "+" menu's "Stickers" row opens. */
  stickerPicker?: { tab?: string; progress?: number } | null;
  /** The inbox chosen in the sidebar's list-options menu: "all", "known", "unknown", "unread" or "recently-deleted". */
  onListFilter?: (id: string) => void;
  onStickerPickerTab?: (tabId: string) => void;
  onStickerPickerClose?: () => void;
  onStickerSelect?: (sticker: Sticker) => void;
  /** A sticker let go over the transcript. `placement` is in the pane's own coordinates. */
  onStickerPlace?: (sticker: Sticker, placement: StickerPlacement) => void;
  /**
   * The conversation switch a change of `selectedId` starts: the pane crossfades, the header's name
   * pill crosses with it and the sidebar's selected row travels. With `progress` (0 to 1) it is seeked
   * to that fraction of `macTransitions.conversation.duration` and paused instead of played, which is
   * what makes a checkpoint of it reproducible; a seeked switch stays on that frame until the next one.
   */
  conversationTransition?: { progress?: number } | null;
  /**
   * The same, for the two popovers: it seeks the context menu's appearance (`macTransitions.menu`) and
   * whichever end of the plus popover's own presentation is running (`macPlusMenuMetrics.motion`).
   */
  menuTransition?: { progress?: number } | null;
  footer?: string;
  renderReactions?: (message: Message) => ReactNode;
  overlay?: ReactNode;
  className?: string;
  style?: CSSProperties;
  frameRef?: RefObject<HTMLDivElement | null>;
};

/** What the pane was drawing before a switch, kept mounted so the two conversations can cross. */
type OutgoingPane = {
  messages: Message[];
  contact: MacMessagesAppProps["contact"];
  group: boolean;
  /** Its own faces, so a group's stacked photo crosses to the next conversation's instead of popping. */
  members: MacHeaderMember[] | undefined;
  /** Indices of the row it left and the row it landed on, when both are unpinned sidebar rows. */
};

/**
 * The whole macOS 26 Messages window: sidebar, header, message log, composer, and the right-click menu.
 * The caller owns data and navigation; this component only draws state.
 *
 * Changing `selectedId` crossfades the pane and travels the sidebar's selected row; the plus and context
 * menus fade in and out. Every one of those timings is unmeasured, see `macTransitions`.
 */
export function MacMessagesApp({
  width = macScreen.width, height = macScreen.height, active = true, conversations = [], selectedId, onSelectConversation, contact, group = false, participants,
  messages, typing = false, now, composer, compose, onCompose, onComposeRecipientChange, onAddRecipient, onComposeClose,
  onVideoCall, onDetails, sendAnimation, receiveAnimation, onSendAnimationEnd,
  selectedMessageIds, onSelectMessage, contextMenu, onContextMenu, onContextMenuClose, onTapback, onMenuAction, onReplayEffect,
  plusMenu, onPlusMenuSelect, onPlusMenuClose, conversationTransition, menuTransition,
  searchQuery, onSearch,
  details, onDetailsClose, onDetailsTabChange, onDetailsWidthChange, detailsContent,
  onQuickLook, photoPicker, photos, onPhotoPickerSelectionChange, onPhotoPickerClose,
  onListFilter,
  stickerPicker, onStickerPickerTab, onStickerPickerClose, onStickerSelect, onStickerPlace,
  footer, renderReactions = defaultReactions, overlay, className, style, frameRef,
}: MacMessagesAppProps) {
  const shell = useRef<HTMLDivElement>(null);
  const localPane = useRef<HTMLDivElement>(null);
  const pane = frameRef ?? localPane;
  const list = useRef<MessageListHandle>(null);
  // A popover that is already open on the app's first commit did not just appear, so it is not
  // animated: the same rule a Tapback balloon follows for a reaction that predates the session. It is
  // also what keeps a scenario checkpoint of an open menu a still frame instead of a mid-fade one.
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  // Keep the menu mounted through its dismissal; derived during render so no committed frame is
  // missing it (an effect would drop it for a frame and the fade would never be seen).
  const [seenMenu, setSeenMenu] = useState<typeof contextMenu>(contextMenu ?? null);
  const [closingMenu, setClosingMenu] = useState<typeof contextMenu>(null);
  // A menu opened from the keyboard takes focus; one opened by a right click does not, which is what
  // the platform does and what keeps the pointer path's rendering identical.
  const [keyboardMenu, setKeyboardMenu] = useState(false);
  if ((seenMenu?.id ?? null) !== (contextMenu?.id ?? null)) {
    setSeenMenu(contextMenu ?? null);
    setClosingMenu(contextMenu ? null : seenMenu);
  }
  const menu = contextMenu ?? closingMenu;
  const target = menu ? messages.find(message => message.id === menu.id) : undefined;
  // A native menu closes on Escape and on a click anywhere outside it, whether or not it holds focus.
  const closeMenu = useRef(onContextMenuClose);
  useEffect(() => { closeMenu.current = onContextMenuClose; }, [onContextMenuClose]);
  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeMenu.current?.(); } };
    const onPointer = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.('[data-slot="context-menu"]')) closeMenu.current?.();
    };
    document.addEventListener("keydown", onKey, true);
    // Capture on the next tick so the right-click that opened it does not immediately close it.
    const timer = setTimeout(() => document.addEventListener("pointerdown", onPointer, true), 0);
    return () => { document.removeEventListener("keydown", onKey, true); clearTimeout(timer); document.removeEventListener("pointerdown", onPointer, true); };
  }, [contextMenu]);

  // `MacPlusMenu` owns the popover's presentation, but it can only play the dismissal while it is
  // still in the tree, so the app keeps it mounted until `onExited`. Derived during render for the
  // same reason the context menu's closing state is: an effect would leave one committed frame with
  // the popover already gone, and the dismissal would never be seen.
  const [ownPlusMenu, setOwnPlusMenu] = useState(false);
  const plusOpen = plusMenu ?? ownPlusMenu;
  const [seenPlusMenu, setSeenPlusMenu] = useState(plusOpen);
  const [closingPlusMenu, setClosingPlusMenu] = useState(false);
  if (seenPlusMenu !== plusOpen) {
    setSeenPlusMenu(plusOpen);
    setClosingPlusMenu(!plusOpen && seenPlusMenu);
  }
  const menuProgress = menuTransition?.progress;

  // ---------------------------------------------------------------------------------------------
  // The presented surfaces. Each is `prop ?? shell-held`, so a caller can state one and a caller who
  // states nothing still gets the click that opens it. Every "is it leaving" flag below is derived
  // during render, never in an effect: an effect leaves one committed frame with the surface already
  // unmounted, and its dismissal never runs. That is the same rule the two menus above follow.
  // ---------------------------------------------------------------------------------------------
  /**
   * New Message. There is no entrance to seek and nothing leaves the screen, so unlike the surfaces
   * below it this needs no "is it closing" flag: the window simply is composing or is not.
   */
  const [ownCompose, setOwnCompose] = useState<{ recipient?: string } | null>(null);
  const composeValue = compose === undefined ? ownCompose : compose;
  const composing = composeValue != null;
  const closeCompose = () => { setOwnCompose(null); if (composing) onComposeClose?.(); };
  const setRecipient = (value: string) => {
    setOwnCompose(current => (current ? { ...current, recipient: value } : current));
    onComposeRecipientChange?.(value);
  };
  /** What the log draws. A draft has no transcript, and its own composer is the only thing to type in. */
  const transcript = composing ? noMessages : messages;

  const [ownDetails, setOwnDetails] = useState(false);
  const detailsValue = details === undefined ? (ownDetails ? { open: true } : null) : details;
  const detailsOpen = detailsValue?.open ?? false;
  const [seenDetails, setSeenDetails] = useState(detailsOpen);
  const [closingDetails, setClosingDetails] = useState(false);
  if (seenDetails !== detailsOpen) {
    setSeenDetails(detailsOpen);
    setClosingDetails(!detailsOpen && seenDetails);
  }
  const detailsShown = detailsOpen || closingDetails;
  const closeDetails = () => { setOwnDetails(false); onDetailsClose?.(); };
  /** New Message. The inspector inspects a conversation and a draft has none, so it closes with the transcript. */
  const openCompose = () => {
    if (detailsOpen) closeDetails();
    if (compose === undefined) setOwnCompose(current => current ?? {});
    onCompose?.();
  };
  // The inspector's three switch rows. `MacDetails` draws each one only when it has a handler, so a
  // caller that owns them passes both halves and a caller that owns nothing still gets working rows
  // rather than an empty panel. These starting values are this component's, not a measurement: no
  // capture of the pane exists, and what a fresh conversation defaults to is the app's business.
  const [ownHideAlerts, setOwnHideAlerts] = useState(false);
  const [ownReadReceipts, setOwnReadReceipts] = useState(true);
  const [ownSharedWithYou, setOwnSharedWithYou] = useState(true);

  const [ownPhotoPicker, setOwnPhotoPicker] = useState<NonNullable<MacMessagesAppProps["photoPicker"]> | null>(null);
  const photoValue = photoPicker === undefined ? ownPhotoPicker : photoPicker;
  const [seenPhotos, setSeenPhotos] = useState(photoValue != null);
  const [closingPhotos, setClosingPhotos] = useState(false);
  if (seenPhotos !== (photoValue != null)) {
    setSeenPhotos(photoValue != null);
    setClosingPhotos(photoValue == null && seenPhotos);
  }
  const photoPickerShown = photoValue != null || closingPhotos;
  const closePhotoPicker = () => { setOwnPhotoPicker(null); onPhotoPickerClose?.(); };

  const [ownSticker, setOwnSticker] = useState<NonNullable<MacMessagesAppProps["stickerPicker"]> | null>(null);
  const stickerValue = stickerPicker === undefined ? ownSticker : stickerPicker;
  const [seenSticker, setSeenSticker] = useState(stickerValue != null);
  const [closingSticker, setClosingSticker] = useState(false);
  if (seenSticker !== (stickerValue != null)) {
    setSeenSticker(stickerValue != null);
    setClosingSticker(stickerValue == null && seenSticker);
  }
  const stickerShown = stickerValue != null || closingSticker;
  /**
   * Which composer button the sticker popover hangs off, so its arrow points at the one that was
   * pressed. The "+" menu's Stickers row and the composer's smiley both open the same browser.
   */
  const [stickerAnchor, setStickerAnchor] = useState("attach-button");
  /**
   * The sidebar's list-options menu, and which inbox it has chosen. The button declares
   * `aria-haspopup="menu"` and used to open nothing at all; see `macosListFilterMenu` for where its
   * rows come from and what about them is not measured.
   */
  const [listFilterOpen, setListFilterOpen] = useState(false);
  const [listFilter, setListFilter] = useState("all");
  const closeStickerPicker = () => { setOwnSticker(null); onStickerPickerClose?.(); };

  /**
   * Who is in this conversation. A caller that knows says so; a caller that only set `group` gets the
   * people the transcript names, in the order they first spoke, which is the honest reading of a log
   * — it cannot know about a member who has said nothing. You are not in it: `CKAvatarView` is handed
   * the conversation's *other* participants, so the stack never draws your own face.
   */
  const groupMembers = useMemo<MacHeaderMember[] | undefined>(() => {
    if (participants) return participants.length > 1 ? [...participants] : undefined;
    if (!group) return undefined;
    const seen = new Map<string, MacHeaderMember>();
    for (const message of messages) {
      if (message.direction !== "incoming" || !message.sender || seen.has(message.sender)) continue;
      seen.set(message.sender, { name: message.sender, initials: message.senderInitials ?? initialsOf(message.sender), photo: message.senderPhoto });
    }
    return seen.size > 1 ? [...seen.values()] : undefined;
  }, [participants, group, messages]);
  const isGroup = group || (groupMembers?.length ?? 0) > 1;
  /** The same people, in the shape the inspector's header pancake and participant list take. */
  const detailsParticipants = useMemo<MacDetailsParticipant[] | undefined>(() => groupMembers?.map((person, index) => ({
    id: person.name ?? person.initials ?? String(index),
    name: person.name ?? person.initials ?? "",
    initials: person.initials,
    photo: person.photo,
  })), [groupMembers]);

  // The context menu fades and grows out of the pointer. Only its appearance is animated here, because
  // `context-menu.tsx` already owns the dismissal; the transform origin set here is the corner that
  // dismissal then folds back into.
  const openMenuId = contextMenu?.id ?? null;
  useLayoutEffect(() => {
    if (!openMenuId || !mounted.current || prefersReducedMotion()) return;
    const element = pane.current?.querySelector<HTMLElement>('[data-slot="context-menu"]');
    if (!element) return;
    element.style.transformOrigin = "left top";
    const animation = element.animate(
      [{ opacity: 0, transform: `scale(${macTransitions.menu.scale})` }, { opacity: 1, transform: "scale(1)" }],
      { duration: macTransitions.menu.open, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)", fill: "both" },
    );
    if (menuProgress !== undefined) { animation.pause(); animation.currentTime = clamp01(menuProgress) * macTransitions.menu.open; }
    return () => { try { animation.cancel(); } catch { /* already gone */ } };
  }, [openMenuId, pane, menuProgress]);

  // Selection is the pane's own state unless the caller takes it, and it draws even without a
  // handler so a screenshot of a fixed selection needs no interaction. The anchor is what a
  // shift-click extends from.
  const [ownSelection, setOwnSelection] = useState<readonly string[]>([]);
  const selection = selectedMessageIds ?? ownSelection;
  const anchorId = useRef<string | null>(null);
  function commitSelection(next: string[], context: { id: string | null; shiftKey: boolean; metaKey: boolean }) {
    setOwnSelection(next);
    onSelectMessage?.(next, context);
  }
  function select(id: string | null, modifiers: { shiftKey: boolean; metaKey: boolean }) {
    if (id === null) { anchorId.current = null; commitSelection([], { id: null, ...modifiers }); return; }
    const next = nextMessageSelection(transcript.map(message => message.id), selection, id, modifiers, anchorId.current);
    if (!modifiers.shiftKey) anchorId.current = id;
    commitSelection(next, { id, ...modifiers });
  }
  /**
   * Edit ▸ Select All. Every message in display order, and the anchor is left where it was, so a
   * shift-click straight after still extends from whatever was last clicked — which is what an
   * AppKit list does. There is no message this acted on, so the context reports `id: null`, the same
   * way clearing does.
   */
  function selectAllMessages() {
    commitSelection(transcript.map(message => message.id), { id: null, shiftKey: false, metaKey: true });
  }
  const mine = target?.reactions?.find(reaction => reaction.byMe);
  const selected: TapbackSelection | undefined = mine ? (mine.emoji ? { emoji: mine.emoji } : { type: mine.type as never }) : undefined;
  useArrivalAnimation({ frame: pane, messages, send: sendAnimation, receive: receiveAnimation, onSendEnd: onSendAnimationEnd });

  /**
   * The conversation the pane is leaving. It cannot be derived during render the way the menus'
   * closing state is, because by then `messages` and `contact` are already the new conversation's and
   * the old ones live in a ref, which a render may not read. A **layout** effect is the one place that
   * can hold them: React flushes the state it sets before the browser paints, so the frame where the
   * arriving conversation is alone in the pane is never shown. A passive effect would lose exactly
   * that frame, which is why nothing here uses one.
   */
  const committed = useRef({ id: selectedId, messages: transcript, contact, group, members: groupMembers, composing });
  const [outgoingPane, setOutgoingPane] = useState<OutgoingPane | null>(null);
  useLayoutEffect(() => {
    const before = committed.current;
    committed.current = { id: selectedId, messages: transcript, contact, group, members: groupMembers, composing };
    // Opening the first conversation is an arrival, not a switch: there is nothing to cross with.
    if (before.id === selectedId || before.id === undefined || selectedId === undefined) return;
    // Leaving a draft is an arrival, not a switch, for the same reason opening the first conversation
    // is: there is nothing to cross with. The pane behind the draft was empty and its header carried a
    // "To:" field rather than a name, and the conversation the caller was still handing us all along
    // was never on screen — crossing that in would flash a conversation nobody had been looking at.
    // The sidebar has nothing to travel from either: the highlight was on the draft's row, and that
    // row leaves the list in this same commit.
    if (before.composing) return;
    setOutgoingPane({ messages: before.messages, contact: before.contact, group: before.group, members: before.members });
  }, [selectedId, transcript, contact, group, groupMembers, conversations, composing]);

  const switchProgress = conversationTransition?.progress;
  useLayoutEffect(() => {
    if (!outgoingPane) return;
    const root = pane.current;
    const clear = () => setOutgoingPane(current => (current === outgoingPane ? null : current));
    if (!root || prefersReducedMotion()) { clear(); return; }
    const D = macTransitions.conversation.duration;
    const animations: Animation[] = [];
    const add = (element: Element | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions) => {
      if (element) animations.push(element.animate(frames, { fill: "both", ...options }));
    };
    // The pane's content and the header's name pill cross together; the composer, the header's glass
    // and its two buttons belong to the window rather than to the conversation, so they hold still.
    const contacts = Array.from(root.querySelectorAll<HTMLElement>('[data-slot="header-contact"]'));
    const enter: Keyframe[] = [{ opacity: 0, transform: `translateY(${macTransitions.conversation.shift}px)` }, { opacity: 1, transform: "translateY(0px)" }];
    const leave: Keyframe[] = [{ opacity: 1, offset: 0 }, { opacity: 0, offset: macTransitions.conversation.dissolve }, { opacity: 0, offset: 1 }];
    const arriving = { duration: D, easing: "cubic-bezier(0.25, 0.8, 0.3, 1)" };
    const leaving = { duration: D, easing: "linear" };
    add(root.querySelector('[data-slot="pane-content"]'), enter, arriving);
    add(contacts.find(element => !element.closest('[data-slot="header-outgoing"]')), enter, arriving);
    add(root.querySelector('[data-slot="pane-outgoing"]'), leave, leaving);
    add(contacts.find(element => element.closest('[data-slot="header-outgoing"]')), leave, leaving);

    // Nothing happens to the sidebar here. The selected row's fill just changes, in the same frame
    // the click lands, because that is what the table does — see `macTransitions.selection` above.

    if (switchProgress === undefined) void Promise.all(animations.map(animation => animation.finished.catch(() => undefined))).then(clear);
    else { const t = clamp01(switchProgress) * D; animations.forEach(animation => { animation.pause(); animation.currentTime = t; }); }
    return () => {
      animations.forEach(animation => { try { animation.cancel(); } catch { /* already gone */ } });
    };
  }, [outgoingPane, pane, switchProgress, active]);

  /**
   * The sidebar's rows. The row for the conversation the pane is drawing *is* that conversation, so
   * when it carries no `members` of its own and this is a group it takes the same faces the header
   * does; otherwise one conversation would read as a group in the pane and as a monogram in the list.
   * Every other row is exactly what the caller passed.
   */
  const sidebarConversations = useMemo(() => (
    groupMembers
      ? conversations.map(item => (item.id === selectedId && !item.members ? { ...item, members: groupMembers } : item))
      : conversations
  ), [conversations, selectedId, groupMembers]);

  /**
   * The list the sidebar draws while composing: the draft's row first, then everything the caller
   * passed. First among the *unpinned* rows is where a new conversation lands — the pinned strip is a
   * separate collection above the list and a draft is not pinned — and `MacSidebar` splits the two on
   * `pinned`, so prepending is enough to put it at the top of the rows without touching the tiles.
   *
   * The draft carries no `initials`, `preview` or `time`: `Avatar` draws its silhouette for a contact
   * with neither initials nor a photo, which is what `CKAvatarView` shows for a conversation with no
   * participants, and a draft has no last message to preview and no date to stamp.
   */
  const composeRows = useMemo(() => {
  /**
   * What each inbox leaves in the list. "Unread Messages" is the only one this data can answer: a
   * row carries `unread`, and nothing in a conversation fixture says whether its sender is known, so
   * Known and Unknown Senders report through `onListFilter` and leave the list alone rather than
   * pretending to a distinction the rows do not carry.
   */
    if (!composing) return sidebarConversations;
    const draft: SidebarConversation = { id: macCompose.rowId, name: macCompose.title, initials: "", preview: "", time: "" };
    const pinned = sidebarConversations.filter(item => item.pinned);
    return [...pinned, draft, ...sidebarConversations.filter(item => !item.pinned)];
  }, [composing, sidebarConversations]);

  /**
   * What each inbox leaves in the list. "Unread Messages" is the only one this data can answer: a row
   * carries `unread`, and nothing in a conversation fixture says whether its sender is known, so
   * Known and Unknown Senders report through `onListFilter` and leave the list alone rather than
   * pretending to a distinction the rows do not carry. Recently Deleted is a screen, not a filter.
   */
  const filteredRows = listFilter === "unread" ? composeRows.filter(row => row.unread) : composeRows;

  const closePlusMenu = () => { setOwnPlusMenu(false); onPlusMenuClose?.(); };
  /**
   * A row of the "+" menu. The two that have a surface in this registry open it; the rest only report,
   * because there is nothing measured to open. The menu folds back into the "+" either way, which is
   * what an AppKit menu does once a row has been chosen.
   */
  const selectPlusItem = (id: string) => {
    closePlusMenu();
    if (id === "photos") { setOwnSticker(null); setOwnPhotoPicker({ selected: [], detent: "collapsed" }); }
    if (id === "stickers") { setOwnPhotoPicker(null); setStickerAnchor("attach-button"); setOwnSticker({}); }
    onPlusMenuSelect?.(id);
  };

  /**
   * A photo was opened. On the Mac that is a Quick Look, so the shell selects the message the way a
   * click on it would and reports; it draws nothing. See `onQuickLook` for why there is no viewer.
   */
  const quickLook = (id: string, index: number) => {
    select(id, { shiftKey: false, metaKey: false });
    onQuickLook?.(id, index);
  };

  // A popover the "+" menu opened closes on Escape and on a press outside it, the way an AppKit
  // popover does. The sticker sheet answers Escape itself; this covers the photos panel, which has no
  // dismissal of its own, and the press-outside both of them need.
  const photoUp = photoValue != null;
  const stickerUp = stickerValue != null;
  const popoverUp = photoUp || stickerUp;
  const dismissPopovers = () => {
    if (photoUp) closePhotoPicker();
    if (stickerUp) closeStickerPicker();
  };
  useEffect(() => {
    if (!photoUp && !stickerUp) return;
    const dismiss = () => {
      if (photoUp) { setOwnPhotoPicker(null); onPhotoPickerClose?.(); }
      if (stickerUp) { setOwnSticker(null); onStickerPickerClose?.(); }
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); dismiss(); } };
    const onPointer = (event: PointerEvent) => {
      // The two buttons that open one of these are exempt, or a click on either would be dismissed
      // here and re-opened by its own handler in the same gesture — which is what left the smiley
      // unable to close what it had just opened.
      const hit = (event.target as HTMLElement | null)?.closest?.('[data-slot="mac-attachment-popover"], [data-slot="attach-button"], [data-slot="emoji-button"]');
      if (!hit) dismiss();
    };
    document.addEventListener("keydown", onKey, true);
    // Next tick, so the click on "+" that opened it does not immediately close it.
    const timer = setTimeout(() => document.addEventListener("pointerdown", onPointer, true), 0);
    return () => { document.removeEventListener("keydown", onKey, true); clearTimeout(timer); document.removeEventListener("pointerdown", onPointer, true); };
  }, [photoUp, stickerUp, onPhotoPickerClose, onStickerPickerClose]);

  const pickerPhotos = photos ?? photoPickerSamples;
  const picked = photoValue?.selected ?? [];

  /**
   * The transcript, the header, the composer and the two popovers: everything the window's content
   * area holds when the inspector is closed. Hoisted so `MacDetails` can take it as its
   * `conversation` and push it aside — the same node either way, so the pane's ref, its handlers and
   * `pane.current.getBoundingClientRect()` all survive the inspector opening, which is what keeps the
   * right-click menu landing correctly beside it.
   */
  const paneNode = (
            <div ref={pane} data-slot="pane" className="absolute inset-0 overflow-hidden" style={{ background: "var(--im-bg)" }}
              // A single click selects the message it lands on and deselects the rest; a click on the
              // rest of the pane clears. Right-clicking selects first, then opens the menu.
              onClick={event => {
                const hit = (event.target as HTMLElement).closest?.('[data-message-id], [data-slot="context-menu"]');
                // The menu acts on the message it opened over, so using it must not clear the selection.
                if (hit?.getAttribute("data-slot") === "context-menu") return;
                select(hit?.getAttribute("data-message-id") ?? null, { shiftKey: event.shiftKey, metaKey: event.metaKey });
              }}
              onContextMenu={event => {
                const id = (event.target as HTMLElement).closest?.("[data-message-id]")?.getAttribute("data-message-id");
                if (id) select(id, { shiftKey: false, metaKey: false });
                if (!id || !onContextMenu || !pane.current) return;
                event.preventDefault();
                setKeyboardMenu(false);
                const rect = pane.current.getBoundingClientRect();
                onContextMenu(id, event.clientX - rect.left, event.clientY - rect.top);
              }}
              // The keyboard equivalent of the right click: the log's arrow keys focus a message and
              // these keys open its menu, anchored to the message rather than to a pointer.
              onKeyDown={event => {
                // Escape only clears once nothing else has claimed it, so an open menu still closes
                // first. The window carries the same clear for a press that lands outside the pane.
                if (event.key === "Escape" && !event.defaultPrevented && selection.length) { event.preventDefault(); select(null, { shiftKey: false, metaKey: false }); return; }
                // The log's own arrow keys have already moved focus by the time this bubbles up (and
                // have called preventDefault on the way), so following the focused row here is what
                // makes selection reachable without a pointer.
                if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
                  const focused = (document.activeElement as HTMLElement | null)?.closest?.("[data-message-id]")?.getAttribute("data-message-id");
                  if (focused) select(focused, { shiftKey: event.shiftKey, metaKey: false });
                }
                const row = event.target as HTMLElement;
                if (!row.matches?.('[data-slot="message-row"][data-message-id]')) return;
                const id = row.getAttribute("data-message-id");
                // Space is Quick Look on the Mac — File ▸ Quick Look, which macOS 26 Messages draws
                // with no ⌘ equivalent — and only on a message that has something to preview, which
                // is why that menu item reads disabled with nothing selected. Anything else falls
                // through to the menu, so Enter and the context-menu key still open it.
                if (event.key === " " && id && transcript.find(message => message.id === id)?.images?.length) {
                  event.preventDefault();
                  quickLook(id, 0);
                  return;
                }
                if (event.key !== "Enter" && event.key !== " " && event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
                if (!id || !onContextMenu || !pane.current) return;
                event.preventDefault();
                setKeyboardMenu(true);
                const rect = pane.current.getBoundingClientRect();
                const at = row.getBoundingClientRect();
                onContextMenu(id, at.left + at.width / 2 - rect.left, at.bottom - rect.top);
              }}>
              <div data-slot="pane-content" className="absolute inset-0">
                <MessageList ref={list} frameRef={pane} messages={transcript} typing={composing ? false : typing} group={isGroup} now={now} anchor="bottom" selectedIds={selection}
                  insetTop={macScreen.listTop} insetBottom={macScreen.listBottom} renderReactions={renderReactions} messageActions={Boolean(onContextMenu)} openMenuId={menu?.id ?? null} onReplayEffect={onReplayEffect}
                  onOpenImage={(id, index) => quickLook(id, index)} className="absolute inset-0" />
              </div>
              {/* The conversation that is leaving, under the header's glass so it is washed like the one
                  arriving. It carries no composer and nothing interactive: it is a picture for 140 ms. */}
              {outgoingPane && (
                <div data-slot="pane-outgoing" aria-hidden="true" inert className="pointer-events-none absolute inset-0">
                  <MessageList frameRef={pane} messages={outgoingPane.messages} group={outgoingPane.group || (outgoingPane.members?.length ?? 0) > 1} now={now} anchor="bottom"
                    insetTop={macScreen.listTop} insetBottom={macScreen.listBottom} renderReactions={renderReactions} className="absolute inset-0" />
                </div>
              )}
              {/* The name pill is the details trigger, and it opens the pane itself when the caller
                  is not holding that state. ⌥⌘I on the window does the same. */}
              <MacHeader name={contact.name} initials={contact.initials} photo={contact.photo} members={groupMembers}
                compose={composing} recipient={composeValue?.recipient ?? ""} onRecipientChange={setRecipient} onAddRecipient={onAddRecipient}
                onCompose={openCompose} onVideoCall={onVideoCall} onOpenDetails={() => { setOwnDetails(true); onDetails?.(); }}
                className="absolute left-0 top-0 w-full" style={{ height: macHeaderMetrics.height }} />
              {/* The name pill it is leaving, over the live header so the two cross where the real one
                  sits. `macAppStyles` drops this copy's glass and buttons: only the contact is leaving. */}
              {outgoingPane && (
                <div data-slot="header-outgoing" aria-hidden="true" inert className="pointer-events-none absolute left-0 top-0 w-full">
                  <MacHeader name={outgoingPane.contact.name} initials={outgoingPane.contact.initials} photo={outgoingPane.contact.photo}
                    members={outgoingPane.members} style={{ height: macHeaderMetrics.height }} />
                </div>
              )}
              <MacComposer className="absolute bottom-0 left-0 w-full" value={composer?.value} disabled={composer?.disabled} onChange={composer?.onChange}
                // `aria-haspopup` on the "+" is only half a statement without this beside it.
                attachExpanded={plusOpen || popoverUp}
                onSend={composer?.onSend ?? (() => {})} onAudio={composer?.onAudio}
                /* The smiley is the sticker browser, the same surface the "+" menu's Stickers row
                   opens, and it toggles like the "+" does rather than stacking a second popover on
                   whatever is already up. It used to call a callback the shell never passed, so on
                   this app the button was dead: it took a click, kept its pressed look, and opened
                   nothing. A consumer's own `onEmoji` still runs after. */
                onEmoji={() => {
                  if (stickerUp) closeStickerPicker();
                  else { setOwnPhotoPicker(null); setOwnPlusMenu(false); setStickerAnchor("emoji-button"); setOwnSticker({}); }
                  composer?.onEmoji?.();
                }}
                onAttach={() => {
                  // "+" is a toggle: it closes whatever it opened, and otherwise raises the menu.
                  if (popoverUp) dismissPopovers();
                  else if (plusMenu === undefined) setOwnPlusMenu(current => !current);
                  composer?.onAttach?.();
                }} />
              {/* The two popovers a "+" row opens. Both are the iPhone surfaces re-flowed into the
                  Mac's own popover box — see `macAttachmentPopovers` for what is measured and what is
                  not. The sticker sheet is laid out in pane coordinates inside a full-pane layer, so
                  a dragged sticker can travel over the transcript and `onPlace` reports where it
                  landed in the pane; the photos panel is a plain box. */}
              {stickerShown && (
                <div data-slot="mac-attachment-popover" className="pointer-events-none absolute inset-0" style={{ zIndex: 25 }}>
                  {/* The popover's own box, under the sheet, because the sheet's layer has to stay the
                      whole pane for a dragged sticker to travel across the transcript. */}
                  {/* The chrome behind the sheet only when the shell is placing the box itself. Off
                      the smiley the picker places its own — the "+" is the only anchor a capture
                      holds, so the left edge here is measured for that one button and nothing else. */}
                  {stickerAnchor === "attach-button" && (
                    <div aria-hidden="true" className={cn("absolute", popoverChrome)} style={{
                      left: macAttachmentPopovers.left,
                      top: macAttachmentPopovers.bottom - macAttachmentPopovers.stickers.height,
                      width: macAttachmentPopovers.stickers.width, height: macAttachmentPopovers.stickers.height,
                      borderRadius: macAttachmentPopovers.radius,
                    }} />
                  )}
                  <StickerPicker
                    open={stickerValue != null}
                    progress={stickerValue?.progress}
                    tab={stickerValue?.tab}
                    scrim={false}
                    anchorSlot={stickerAnchor}
                    left={stickerAnchor === "attach-button" ? macAttachmentPopovers.left : undefined}
                    top={stickerAnchor === "attach-button" ? macAttachmentPopovers.bottom - macAttachmentPopovers.stickers.height : undefined}
                    width={macAttachmentPopovers.stickers.width}
                    height={macAttachmentPopovers.stickers.height}
                    onTabChange={tabId => { setOwnSticker(current => (current ? { ...current, tab: tabId } : current)); onStickerPickerTab?.(tabId); }}
                    onDismiss={closeStickerPicker}
                    onExited={() => setClosingSticker(false)}
                    onSelect={onStickerSelect}
                    onPlace={onStickerPlace} />
                </div>
              )}
              {photoPickerShown && (
                <div data-slot="mac-attachment-popover" className={cn("absolute", popoverChrome)} style={{
                  left: macAttachmentPopovers.left,
                  top: macAttachmentPopovers.bottom - macAttachmentPopovers.photos.height,
                  width: macAttachmentPopovers.photos.width, height: macAttachmentPopovers.photos.height,
                  borderRadius: macAttachmentPopovers.radius, zIndex: 25,
                }}>
                  <PhotoPicker
                    open={photoValue != null}
                    progress={photoValue?.progress}
                    selected={picked}
                    onSelectionChange={next => {
                      setOwnPhotoPicker(current => (current ? { ...current, selected: next } : current));
                      onPhotoPickerSelectionChange?.(next);
                    }}
                    detent="collapsed"
                    // A popover has no sheet to drag, so it has no grabber either. The grid is inset
                    // by `-[CKUIBehaviorMac popoverPadding]` = 7 so it clears the popover's corners.
                    grabber={false}
                    inset={macPopoverPadding}
                    width={macAttachmentPopovers.photos.width - macPopoverPadding * 2}
                    height={macAttachmentPopovers.photos.height - macPopoverPadding * 2}
                    photos={pickerPhotos}
                    onExited={() => setClosingPhotos(false)} />
                </div>
              )}
              {target && menu && (
                <ContextMenu variant="macos" items={macosMessageMenu} open={!closingMenu} onExited={() => setClosingMenu(null)} autoFocus={keyboardMenu}
                  style={{ position: "absolute", left: Math.min(menu.x, width - macScreen.sidebar - 310), top: Math.min(menu.y, height - 300), zIndex: 30 }}
                  onAction={action => onMenuAction?.(target.id, action)} onClose={onContextMenuClose}
                  header={<TapbackBar layout="macos" selected={selected} onSelect={selection => onTapback?.(target.id, selection)} />} />
              )}
              {overlay}
            </div>
  );

  return (
    <PlatformProvider platform="macos">
      <PaletteStyle platform="macos" />
      <div ref={shell} data-im-platform="macos" className={cn("relative", className)} style={{ width, height, ...style }}
        // The window's menu-bar equivalents (`macShortcuts`, read off the live macOS 26 Messages menu
        // bar). All three are bound on the window rather than on the document, so a second app on the
        // same page keeps its own.
        onKeyDown={event => {
          // Escape clears the transcript's selection from anywhere in the window, not only from
          // inside the pane, and only once nothing nearer has claimed it: an open menu, an open
          // popover and a search field with text in it all call `preventDefault` first.
          if (event.key === "Escape") {
            if (event.defaultPrevented || !selection.length) return;
            event.preventDefault();
            select(null, { shiftKey: false, metaKey: false });
            return;
          }
          if (!event.metaKey || event.ctrlKey) return;
          const key = event.key.toLowerCase();
          // Conversation ▸ Show Details, ⌥⌘I. A draft has no conversation to show details for, so the
          // item is inert while composing — the same reason the name pill is not drawn there.
          if (event.altKey) {
            if (key !== macShortcuts.details || composing) return;
            event.preventDefault();
            if (detailsOpen) closeDetails();
            else { setOwnDetails(true); onDetails?.(); }
            return;
          }
          // File ▸ New Message, ⌘N. Idempotent: pressing it again in a draft keeps the draft, which is
          // what the Mac does — there is only ever one New Message row in the list.
          if (key === macShortcuts.newMessage) {
            event.preventDefault();
            openCompose();
            return;
          }
          // Edit ▸ Find ▸ Find…, ⌘F. On the Mac the search field *is* the results
          // (`searchControllerObscuresConversationList` NO), so this focuses the sidebar's field and
          // takes its text, the way ⌘F into a filled search field does — it does not open a screen.
          if (key === macShortcuts.find) {
            const field = shell.current?.querySelector<HTMLInputElement>('[data-slot="sidebar-search-input"]');
            if (!field) return;
            event.preventDefault();
            field.focus();
            field.select();
            return;
          }
          // Edit ▸ Select All, ⌘A. Not while a text field has it: there the platform's own ⌘A wins.
          if (key === macShortcuts.selectAll) {
            if (isTextEntry(document.activeElement) || !transcript.length) return;
            event.preventDefault();
            selectAllMessages();
          }
        }}>
        <style>{macAppStyles}</style>
        <MacWindow width={width} height={height} active={active} data-slot="macos-messages-app"
          sidebar={
            // While composing, the draft's row is the selected one and the conversation the pane was
            // showing gives up its highlight. Choosing any row leaves compose, which is what ends it
            // natively — there is no other way out of a Mac draft than going somewhere else.
            <>
            <MacSidebar conversations={filteredRows} selectedId={composing ? macCompose.rowId : selectedId}
              onSelect={id => { if (id === macCompose.rowId) return; closeCompose(); onSelectConversation?.(id); }} active={active} footer={footer}
              searchQuery={searchQuery} onSearch={onSearch} onOptions={() => setListFilterOpen(open => !open)} optionsExpanded={listFilterOpen} className="absolute inset-0" />
            {/* Under the button, inside the sidebar, in the sidebar's own coordinates: the menu's box
                is `contextMenuMetrics.macos`, and 302 is wider than the sidebar, so it is pulled back
                to the sidebar's trailing edge the way AppKit pulls a menu inside its window. */}
            {listFilterOpen && (
              <ContextMenu variant="macos" items={macosListFilterMenu} open
                style={{ position: "absolute", right: 8, top: macSidebarMetrics.options.centerY + 18, zIndex: 30 }}
                onAction={id => { setListFilterOpen(false); if (id !== "recently-deleted") setListFilter(id); onListFilter?.(id); }}
                onClose={() => setListFilterOpen(false)} />
            )}
            </>
          }
          content={detailsShown ? (
            // The inspector takes the whole content area and hands the pane back as its `conversation`,
            // which it insets by the panel's footprint while it slides in. It paints a window ground
            // behind that, so it is only in the tree while the panel is there.
            <MacDetails
              name={contact.name} initials={contact.initials} photo={contact.photo}
              participants={detailsContent?.participants ?? detailsParticipants}
              // A group opens with its members showing: naming who is in the conversation is the
              // reason the pane is open. A one-to-one has no list to disclose.
              defaultParticipantsOpen={isGroup}
              subtitle={detailsContent?.subtitle}
              // The one quick action this shell can actually perform is the FaceTime call the header
              // already offers; anything else would be a button that reports nothing.
              actions={detailsContent?.actions ?? (onVideoCall ? [{ id: "video", label: `FaceTime ${contact.name}`, icon: "video", onPress: onVideoCall }] : undefined)}
              handles={detailsContent?.handles}
              photos={detailsContent?.photos}
              links={detailsContent?.links}
              attachments={detailsContent?.attachments}
              hideAlerts={detailsContent?.hideAlerts ?? ownHideAlerts}
              onHideAlertsChange={next => { setOwnHideAlerts(next); detailsContent?.onHideAlertsChange?.(next); }}
              readReceipts={detailsContent?.readReceipts ?? ownReadReceipts}
              onReadReceiptsChange={next => { setOwnReadReceipts(next); detailsContent?.onReadReceiptsChange?.(next); }}
              sharedWithYou={detailsContent?.sharedWithYou ?? ownSharedWithYou}
              onSharedWithYouChange={next => { setOwnSharedWithYou(next); detailsContent?.onSharedWithYouChange?.(next); }}
              // A group offers Leave where a one-to-one offers Block, which is what `MacDetails` keys
              // off the presence of each handler, so only the one that belongs is passed.
              onLeave={isGroup ? detailsContent?.onLeave : undefined}
              onBlock={isGroup ? undefined : detailsContent?.onBlock}
              onDelete={detailsContent?.onDelete}
              onClose={closeDetails}
              tab={detailsValue?.tab} onTabChange={onDetailsTabChange}
              mode={detailsValue?.mode ?? "push"}
              width={detailsValue?.width} onWidthChange={onDetailsWidthChange}
              open={detailsOpen} progress={detailsValue?.progress}
              onExited={() => setClosingDetails(false)}
              conversation={paneNode} />
          ) : paneNode} />
        {/* Kept in the tree while it is leaving: `MacPlusMenu` plays its own dismissal and says when
            it is over. A seeked one never reports, so a scrubbed frame holds. */}
        {(plusOpen || closingPlusMenu) && (
          <MacPlusMenu open={plusOpen} progress={menuProgress} onExited={() => setClosingPlusMenu(false)}
            onSelect={selectPlusItem} onClose={closePlusMenu} style={{ position: "absolute", zIndex: 40 }} left={macScreen.sidebar + macPlusMenuMetrics.left} top={macPlusMenuMetrics.top} />
        )}
      </div>
    </PlatformProvider>
  );
}
