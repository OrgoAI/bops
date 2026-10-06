"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { PlatformProvider } from "@/components/message-ui/platform";
import { PaletteStyle } from "@/components/message-ui/palette";
import { IosStatusBar } from "@/components/message-ui/ios-status-bar";
import { IosNavBar } from "@/components/message-ui/ios-nav-bar";
import { IosScrollEdge } from "@/components/message-ui/ios-scroll-edge";
import { IosComposer } from "@/components/message-ui/ios-composer";
import { IosConversationList, type IosConversation } from "@/components/message-ui/ios-conversation-list";
import { IosNewMessageSheet, iosSheetDismissal, iosSheetDismissKeyframes } from "@/components/message-ui/ios-new-message-sheet";
import { MessageList, messageListMetrics, type Message, type MessageListHandle } from "@/components/message-ui/message-list";
import { isEmojiOnly, MessageBubble } from "@/components/message-ui/message-bubble";
import { LinkPreview } from "@/components/message-ui/link-preview";
import { MessageAttachment } from "@/components/message-ui/message-attachment";
import { MessageAudio } from "@/components/message-ui/message-audio";
import { MessageImages } from "@/components/message-ui/message-image";
import { bubbleMetrics, emojiFontStack, fontStack } from "@/components/message-ui/tokens";
import { ReplyThread, replyThreadMetrics, replyThreadMotion } from "@/components/message-ui/message-reply";
import { Tapback, type TapbackType } from "@/components/message-ui/tapback";
import { MessageActions, messageActionsMetrics, photoLiftScale, type Rect } from "@/components/message-ui/message-actions";
import { iosPhotoMenu } from "@/components/message-ui/context-menu";
import { useArrivalAnimation, type ArrivalAnimation } from "@/components/message-ui/message-motion";
import { IosEffectsPicker, type EffectsPickerSelection } from "@/components/message-ui/ios-effects-picker";
import type { TapbackSelection } from "@/components/message-ui/tapback-bar";
import { ImageViewer, type ImageViewerRect } from "@/components/message-ui/image-viewer";
import { IosPlusMenu, defaultPlusMenuItems, type PlusMenuItem } from "@/components/message-ui/ios-plus-menu";
import { PhotoPicker, PhotoPickerAttachments, photoPickerChipMetrics, photoPickerSamples, type PhotoPickerDetent, type PhotoPickerPhoto } from "@/components/message-ui/photo-picker";
import { StickerPicker, stickerPickerMetrics, type Sticker, type StickerPlacement } from "@/components/message-ui/sticker-picker";
import { AudioRecorder, audioRecorderMetrics, type AudioRecorderState, type AudioTake } from "@/components/message-ui/audio-recorder";
import { IosDetails, type IosDetailsAction, type IosDetailsItem, type IosDetailsPhoto, type IosDetailsSection } from "@/components/message-ui/ios-details";
import { GroupDetails } from "@/components/message-ui/group-details";
import { TapbackDetailsPlatter, tapbackDetailsPlatterMetrics, type TapbackReactor } from "@/components/message-ui/tapback-details";
import { IosSearch, type IosSearchResult, type IosSearchSection, type IosSearchSectionKind } from "@/components/message-ui/ios-search";
import { GroupAvatar, groupAvatarMetrics, type GroupParticipant } from "@/components/message-ui/group-avatar";
import { IosSelectMode, IosSelectionCloseButton, IosSelectionToolbar, SelectionCircle, selectModeMotion, selectionMetrics, useSelectModeTransition } from "@/components/message-ui/ios-select-mode";
import type { SystemMessageEvent } from "@/components/message-ui/system-message";

/**
 * `listTop` puts the first date header's ink at y 172.67 (conv3-light.png). `listBottom` is the composer's
 * 68pt band plus the 28pt it keeps clear: in the one scrolled iOS capture (dateheader-mid-light.png) the
 * last row's ink bottom is at 778 with the composer field starting at 806.
 */
export const iosScreen = { width: 402, height: 874, statusBar: 54, navBar: 94, listTop: 169.5, composer: 68, listBottom: 96 } as const;

export type IosScreen = "list" | "conversation" | "new-message";

/**
 * Moving between screens. A conversation is pushed in from the trailing edge while the list follows
 * it part of the way out and dims under it; going back plays that backwards; the New Message sheet
 * comes up from the bottom while its dim fades in, and leaves on `iosSheetDismissal`'s table.
 *
 * UNVERIFIED, except `dismiss` and `represent`. Nothing in `references/` captures a push, a pop or a
 * sheet arriving, so those three numbers are not measured: they are kept in the family of the motion
 * that is (the send flight that settles by ~520 ms, the 380 ms long-press entrance, the 260 ms
 * effects screen and its 320 ms move). Replace them from a recording before describing any of it as
 * measured.
 *
 * `dismiss` **is** measured — 200 ms, twice, off an iPhone 17 Pro on iOS 26 — and the duration is
 * the lesser half of what was measured: the panel's travel is a table of recorded samples rather
 * than an ease, so the sheet branch below plays `iosSheetDismissKeyframes()` linearly instead of the
 * presentation reversed.
 *
 * `represent` is 0 because the device does not animate one. `newmsg-sheet-open` re-opens this sheet
 * by deep link with the list bare from 216 to 613 ms and the sheet fully in place at 643 ms, with no
 * intermediate frames at all — on a recorder that emits a frame per screen change, where a 300 ms
 * slide would have left ~18 of them. So a sheet the app has already built snaps back into place.
 * NOT MEASURED: the recording re-opens it by **deep link**, and nothing records a second tap of
 * Compose. This treats the two alike, which is a guess about the tap and a reading about the link.
 *
 * Each one is a Web Animations timeline rather than a transition or a rAF loop, so
 * `screenTransition.progress` can seek a frame instead of playing it, and `document.getAnimations()`
 * reaches it (which is how the harness freezes a checkpoint).
 */
export const iosScreenTransition = {
  push: 350,
  pop: 320,
  present: 400,
  dismiss: iosSheetDismissal.duration,
  represent: 0,
  /** How far the screen underneath follows the one on top, as a share of the screen width. */
  parallax: 0.3,
  /** Black over the screen that slid back, at the end of the push. */
  dim: 0.14,
  ease: "cubic-bezier(0.32, 0.72, 0, 1)",
} as const;

export type IosScreenTransitionKind = "push" | "pop" | "present" | "dismiss" | "represent";

/**
 * Which transition takes the app from one screen to another. The list and a conversation are a
 * navigation stack; the sheet is presented over whichever of them is showing. Going from the sheet
 * straight into a conversation (a recipient was chosen) pushes from the list underneath it, so the
 * sheet leaves with the screen it was presented over.
 *
 * `built` is whether this app has put the New Message sheet up before. A second presentation of a
 * sheet the app has already built is a **represent**, which the device does not animate — see
 * `iosScreenTransition.represent`.
 */
export function screenTransitionKind(from: IosScreen, to: IosScreen, options?: { built?: boolean }): IosScreenTransitionKind | null {
  if (from === to) return null;
  if (to === "new-message") return options?.built ? "represent" : "present";
  if (from === "new-message" && to === "list") return "dismiss";
  return to === "conversation" ? "push" : "pop";
}

export type IosMessagesAppProps = {
  width?: number;
  height?: number;
  /** Status bar clock. */
  time?: string;
  screen?: IosScreen;
  conversations?: IosConversation[];
  contact: { name: string; initials?: string; photo?: string };
  group?: boolean;
  /**
   * The people in the conversation, when it is a group. Two or more of them turn the nav bar's Ø60
   * slot into `group-avatar.tsx`'s Snowglobe stack — which is also the shape the details screen's
   * entrance morphs out of — and mark the conversation as a group without a separate `group` flag.
   */
  participants?: readonly GroupParticipant[];
  messages: Message[];
  typing?: boolean | { sender?: string };
  /** Reference time for "Today"/"Yesterday". */
  now?: Date | number;
  composer?: { value?: string; placeholder?: string; disabled?: boolean; onChange?: (value: string) => void; onSend?: (text: string, photos: PhotoPickerPhoto[]) => void | Promise<void>; onAttach?: () => void; onMic?: () => void };
  /**
   * Scrub a screen change instead of playing it: the app is on `screen`, arriving from `from`, and
   * `progress` (0..1) seeks the push, the pop or the sheet. Leave it out and the app runs the
   * transition itself whenever `screen` changes, which is what an application wants; a harness that
   * renders one frame at a time has nothing to observe changing and states it instead.
   *
   * `represent` states the one thing a single frame cannot show: that this presentation is of a
   * sheet the app has already built, which is not animated. Playing the transitions, the app knows
   * that for itself; scrubbing, nothing has happened for it to remember.
   */
  screenTransition?: { from: IosScreen; progress: number; represent?: boolean } | null;
  onBack?: () => void;
  onSelectConversation?: (conversation: IosConversation) => void;
  onCompose?: () => void;
  onCloseNewMessage?: () => void;
  onDetails?: () => void;
  /**
   * The open thread: the message whose replies are showing. The conversation blurs behind it. Its
   * members are the message itself and every message replying to it, so the caller only names the
   * root. `progress` (0..1) seeks the entrance rather than playing it.
   */
  thread?: { rootId: string; progress?: number } | null;
  /** The reply count under a message was activated. */
  onOpenThread?: (id: string) => void;
  /** The thread was dismissed. The overlay stays up for its exit after `thread` clears. */
  onCloseThread?: () => void;
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
  /** Open the long-press overlay on a message; `progress` scrubs the entrance (0–1). */
  longPress?: { id: string; progress?: number } | null;
  onLongPress?: (id: string) => void;
  onLongPressClose?: () => void;
  onTapback?: (id: string, selection: TapbackSelection) => void;
  onMenuAction?: (id: string, action: string) => void;
  /** Play a message's effect again — the Replay control under a message sent with one. */
  onReplayEffect?: (id: string) => void;
  /**
   * Select mode: the checkbox multi-select the long-press menu's "Select" row opens, drawn by
   * `ios-select-mode.tsx` and measured on `select-mode-dark.png` — a circle in the leading gutter of
   * every row, the nav bar's back button replaced by a ✕, and the composer replaced by the trash and
   * forward toolbar.
   *
   * It follows the same two-mode contract as the presented surfaces below: left out entirely, the
   * shell owns it and choosing "Select" enters it with nothing wired; passed (a value or `null`) the
   * caller owns it and `progress` (0..1) seeks the entrance instead of playing it. Either way the
   * caller still hears about the action through `onMenuAction(id, "select")`.
   */
  selectMode?: { progress?: number } | null;
  /** "Select" was chosen on that message; it is also the message the mode opens with ticked. */
  onOpenSelectMode?: (id: string) => void;
  /** The ✕, Escape, or a toolbar action that ends the mode. The selection clears with it. */
  onCloseSelectMode?: () => void;
  /**
   * The messages select mode has ticked — the same surface macOS takes for its click-to-select, so a
   * caller keeps one selection state for both platforms. Left out, the shell keeps the set itself.
   *
   * `context.id` is the message the tap acted on, or `null` when the whole selection was cleared.
   * There is no `shiftKey`/`metaKey` here as there is on the Mac: a tap on a phone carries no
   * modifier, so a tap toggles exactly one message and nothing extends a range.
   */
  selectedMessageIds?: readonly string[];
  onSelectMessage?: (ids: string[], context: { id: string | null }) => void;
  /**
   * The toolbar's trash and forward, on the ticked messages. Neither one touches `messages`: this
   * shell still only draws state. Deleting leaves select mode, the way it does natively; forwarding
   * does not, because the sheet it would open is not in this registry to open.
   */
  onDeleteMessages?: (ids: string[]) => void;
  onForwardMessages?: (ids: string[]) => void;
  /**
   * The "Send with effect" screen. iOS opens it on a press and hold of the send button, which is what
   * `onEffectsPickerOpen` reports; pass the state back here to show it.
   */
  effectsPicker?: { tab?: "bubble" | "screen"; selection?: EffectsPickerSelection; draft?: string; progress?: number } | null;
  onEffectsPickerOpen?: (draft: string) => void;
  onEffectsTabChange?: (tab: "bubble" | "screen") => void;
  onEffectSelect?: (selection: EffectsPickerSelection) => void;
  onSendWithEffect?: (text: string, selection: EffectsPickerSelection) => void;
  onEffectsPickerClose?: () => void;
  /*
   * ------------------------------------------------------------------------------------------
   * The presented surfaces: the plus menu, the Photos picker, the sticker sheet, the voice
   * recorder, the details screen, the Tapback Details platter, the photo viewer and search.
   *
   * Every one of them follows the same two-mode contract, and it is the contract that lets one
   * component be both an application and a harness fixture:
   *
   *   - **Left out entirely** (`undefined`), the shell owns the surface. The gesture that opens it
   *     natively opens it here: the composer's `+`, its mic, the nav bar's name pill, a tap on a
   *     photo, a tap on a tapback balloon, the list's search field. Nothing has to be wired for the
   *     app to behave like Messages.
   *   - **Passed** (a value or `null`), the caller owns it, and `progress` (0..1) seeks the
   *     surface's own entrance instead of playing it. A scrubbed checkpoint is then a pure function
   *     of its props, which is what makes two runs render the same frame.
   *
   * Each one stays mounted after its prop clears so its exit has frames to run in, and each is
   * derived during render rather than in an effect — see the long-press overlay above for why.
   * ------------------------------------------------------------------------------------------
   */
  /** The `+` menu over the composer. */
  plusMenu?: { progress?: number } | null;
  /** A row of the plus menu was chosen. "photos", "stickers" and "audio" open their own surfaces. */
  onPlusMenuSelect?: (id: string) => void;
  onPlusMenuClose?: () => void;
  /** Replaces the seven rows of the plus menu. Handlers on a row run before the shell's own. */
  plusMenuItems?: PlusMenuItem[];
  /**
   * The full-screen photo viewer. `id` is the message that was TAPPED; the viewer pages over that
   * photo's whole RUN — see `photoRun`, and `references/image-viewer.md` for the ChatKit reading
   * behind it — so `index` counts photos across the run, not inside `id`. For the ordinary case of a
   * message with one photo in a run of one, the two are the same number. `dismiss` holds the
   * drag-to-dismiss pose without a synthesised drag; `chrome` states the bar visibility.
   */
  photoViewer?: { id: string; index: number; progress?: number; chrome?: boolean; dismiss?: number; pageOffset?: number } | null;
  /** A photo was tapped. `index` is its index inside `id`'s own message, which is what the tile knows. */
  onOpenPhoto?: (id: string, index: number) => void;
  /** The viewer paged. `index` counts photos across the run, the same way `photoViewer.index` does. */
  onPhotoIndexChange?: (index: number) => void;
  onClosePhoto?: () => void;
  /** Share the photo ON SCREEN: after a page that is a different message from the one that was tapped. */
  onSharePhoto?: (id: string, index: number) => void;
  /** Save the photo ON SCREEN, with its index inside its own message. */
  onSavePhoto?: (id: string, index: number) => void;
  /** The Photos picker under the composer, which the plus menu's "Photos" row opens. */
  photoPicker?: { selected?: string[]; detent?: PhotoPickerDetent; progress?: number } | null;
  /** What the picker shows. Defaults to the registry's own gradient placeholders. */
  photos?: PhotoPickerPhoto[];
  onPhotoPickerSelectionChange?: (selected: string[]) => void;
  onPhotoPickerDetentChange?: (detent: PhotoPickerDetent) => void;
  onPhotoPickerClose?: () => void;
  /** The sticker sheet, which the plus menu's "Stickers" row opens. */
  stickerPicker?: { tab?: string; progress?: number; drag?: { id: string; to: { x: number; y: number }; progress: number } } | null;
  onStickerPickerTab?: (tabId: string) => void;
  onStickerPickerClose?: () => void;
  onStickerSelect?: (sticker: Sticker) => void;
  /** A sticker let go over the transcript. `placement.size` is ChatKit's landed 48. */
  onStickerPlace?: (sticker: Sticker, placement: StickerPlacement) => void;
  onStickerEdit?: () => void;
  /** The voice recorder in place of the composer, which the composer's mic opens. */
  audioRecorder?: { state: AudioRecorderState; position?: number; progress?: number; transition?: { from: AudioRecorderState; progress: number }; levels?: number[]; duration?: number } | null;
  onAudioRecorderClose?: () => void;
  /** A finished take was sent. `audioTakeToPeaks(take.levels)` is what `MessageAudio` draws. */
  onAudioSend?: (take: AudioTake) => void;
  /**
   * The details screen the nav bar's name pill pushes: `IosDetails` for one person, `GroupDetails`
   * for a group. `progress` seeks the presentation, `scroll` (points) the header collapse.
   */
  details?: { progress?: number; scroll?: number } | null;
  onCloseDetails?: () => void;
  /** What that screen shows beyond the name and the participants. */
  detailsContent?: {
    phoneLabel?: string;
    phone?: string;
    tag?: string;
    hideAlerts?: boolean;
    onHideAlertsChange?: (next: boolean) => void;
    photos?: IosDetailsSection<IosDetailsPhoto>;
    sharedLinks?: IosDetailsSection<IosDetailsItem>;
    attachments?: IosDetailsSection<IosDetailsItem>;
    onAddContact?: () => void;
    onLeave?: () => void;
    /** Blocking is a toggle; the row reports which way it went. */
    onBlock?: (blocked: boolean) => void;
    /**
     * The three glass circles under the name. Leave it out and the screen still draws all three,
     * which is what `details-light.png` shows: an action this contact cannot take keeps its circle
     * and drops the glyph to the tertiary label colour, it does not disappear. FaceTime picks up
     * Each of the three becomes live when it is given a handler here.
     */
    actions?: IosDetailsAction[];
    onAudioCall?: () => void;
    onFaceTime?: () => void;
    onMail?: () => void;
  };
  /** The group's name was committed from the details screen. */
  onGroupNameChange?: (name: string) => void;
  /**
   * A group edit the caller should answer by appending a status line. The screen itself never
   * appends anything: this shell does not own `messages`.
   */
  onGroupEvent?: (event: SystemMessageEvent) => void;
  /** The Tapback Details platter: who reacted to `id`. */
  tapbackDetails?: { id: string; progress?: number; filter?: string | null } | null;
  onOpenTapbackDetails?: (id: string) => void;
  onCloseTapbackDetails?: () => void;
  onRemoveTapback?: (id: string, reactor: TapbackReactor) => void;
  /**
   * Search over the conversation list. `closing` runs the measured close table rather than the open
   * one played backwards — the two are different animations and the recordings disprove reversing.
   */
  search?: { query?: string; sections?: IosSearchSection[]; maxResults?: number; progress?: number; closing?: boolean } | null;
  onOpenSearch?: () => void;
  onCloseSearch?: () => void;
  onSearchQueryChange?: (query: string) => void;
  onSearchSelect?: (result: IosSearchResult, kind: IosSearchSectionKind) => void;
  onSearchSeeAll?: (kind: IosSearchSectionKind) => void;
  /** A status line arriving in the transcript, its entrance seeked by `progress`. */
  systemArrival?: { id: string; progress?: number } | null;
  /** Extra overlays (a call card, a screen effect, a selection toolbar) rendered above everything. */
  overlay?: ReactNode;
  /** Render reactions for a message; defaults to the message's `reactions` as Tapback balloons. */
  renderReactions?: (message: Message) => ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Exposes the device frame element (for screen-space measurements and overlays). */
  frameRef?: RefObject<HTMLDivElement | null>;
};

/**
 * Several people reacting to one message is **one** balloon, not one per person.
 *
 * ChatKit collapses them into a `CKAggregateAcknowledgmentChatItem`, and that item carries a single
 * `acknowledgmentImageName` and `acknowledgmentImageColor` next to `latestTapback`,
 * `latestAcknowledgmentType`, `latestIsFromMe` and `includesMultiple`. One image name means one
 * glyph: the transcript shows the most recent reaction, tinted by whether that one is yours, and
 * says how many there are. Two glyphs would need two names, and there is no second name.
 *
 * `-[CKUIBehaviorPhone aggregateAcknowledgmentTranscriptBalloonSize]` is `{46, 40}` against
 * `messageAcknowledgmentTranscriptBalloonSize` `{36, 36}` for a single, so the aggregate balloon is
 * 10 wider and 4 taller. `Tapback`'s count pill grows the width and not the height; the extra 4 pt
 * is not applied yet, and no capture of a multi-person reaction exists to settle how the count is
 * set inside it.
 */
export function defaultReactions(message: Message): ReactNode {
  const all = message.reactions;
  if (!all?.length) return undefined;
  const outgoing = message.direction === "outgoing";
  const latest = all[all.length - 1];
  return (
    <div data-slot="reaction-stack" className="flex">
      <Tapback reaction={latest.emoji ? undefined : (latest.type as TapbackType)} emoji={latest.emoji}
        own={latest.byMe ?? true} side={outgoing ? "left" : "right"} count={all.length > 1 ? all.length : undefined} />
    </div>
  );
}

/**
 * A message's body box, whichever kind it is. Every kind draws its own slot and only a text or audio
 * message has a `bubble`, so measuring that alone left an emoji-only message, a photo, a link card and
 * a file card with no rect at all, and the long-press overlay never opened on any of them.
 * `ios-select-mode.tsx`, `ios-swipe-times.tsx` and `message-motion.tsx` measure the same way.
 */
const messageBodySelector = ['[data-slot="bubble"]', '[data-slot="emoji"]', '[data-slot="image-grid"]', '[data-slot="link-preview"]', '[data-slot="message-attachment"]'].join(", ");

/**
 * What the lifted copy replaces, so the original is not drawn twice. One entry per body above, taking
 * the whole wrapper where the body has one (`bubble-frame` carries the tail and the balloons,
 * `message-images` carries the photo tail), plus the delivery label, which the overlay does not lift.
 */
const messageBodyHiddenSlots = ["bubble-frame", "emoji", "message-images", "link-preview", "message-attachment", "status"];

/**
 * A quoted reply stub draws a scaled copy of the quoted message, tail and all, above the message that
 * replies. It is the row's first `[data-slot="bubble"]`, so the overlay used to lift the quotation
 * instead of the message: measured on the harness's `reply` scene, the stub's 157.97×30.39 box at
 * y 570.36 instead of the message's own 133.44×40 at y 605.08.
 */
const insideQuotedStub = (element: HTMLElement) => Boolean(element.closest("[data-stub]"));

/**
 * Where the composer sits while the Photos picker is up, measured rather than derived: at this top
 * the composer's painted white ends on device row 1391 in the render and on device row 1391 in
 * `references/ios/captures/photo-picker-light.png`, which is `photoPickerMetrics.composer.fieldBottom`
 * = 463.6667 pt, leaving the measured `photoPickerMetrics.composer.gap` of backdrop above the panel's
 * own 485. The composer keeps its `+`, its placeholder and its mic; the picker is not the plus menu.
 */
const photoPickerComposerTop = 424;

/** The value a surface with no state of its own takes while it is open. One object, so it is stable. */
const openMarker: { progress?: number; scroll?: number } = {};

/**
 * How far an incoming row steps out of the selection circles' way. **DERIVED from ChatKit, not
 * measured**: `select-mode-dark.png` is one side of an SMS thread, so the only rows it shows are
 * outgoing ones, and those do not move at all in it — which is why nothing here shifts them, and why
 * `MessageSelectionRow`'s own `shift` defaults to 0.
 *
 * `-[CKUIBehaviorPhone editingCheckmarkLeadingPadding]` is 11 and `editingCheckmarkTrailingPadding`
 * is 20, around a `transcriptEditingUnselectedImage` (SF Symbol `circle`, tertiaryLabelColor) whose
 * box is 26×26 with 2 pt of content inset on every edge. That puts the ink of the circle at x 13 at
 * Ø22 — the capture's own 13.0 and Ø21.667, which is 65/3 at 3x, so the two describe one circle —
 * and the content after it at 11 + 26 + 20 = 57. A balloon already begins at `edgeInset`, so an
 * incoming row owes the difference.
 *
 * The log's own content box is deliberately left alone: widening its leading padding to 57 would
 * narrow `maxWidthRatio`'s 280.33 to 251.7 and rewrap the capture's long outgoing bubble, which the
 * capture disproves.
 */
const selectModeRowShift = 11 + 26 + 20 - bubbleMetrics.ios.edgeInset;

/**
 * The rules select mode adds to the conversation layer, all of them driven by `--ios-sel-t` so they
 * ride `IosSelectMode`'s one timeline rather than a second one.
 *
 * The composer is dropped by a rule instead of being handed to `IosSelectionToolbar`'s `composer`
 * slot: moving it into that slot would move it in the React tree, and remounting `IosComposer` loses
 * an uncontrolled draft. The travel is the slot's own — a whole height down, the fade spent in the
 * first 40% — so the two still cross the same way.
 */
function selectModeRules(timing: string) {
  const move = timing ? `transform ${timing}, opacity ${timing}` : "none";
  const fade = timing ? `opacity ${timing}` : "none";
  const scope = '[data-slot="ios-select-mode"] ';
  return [
    `${scope}[data-slot="ios-composer"]{transform:translateY(calc(var(--ios-sel-t) * 100%));opacity:max(0, 1 - var(--ios-sel-t) * 2.5);transition:${move}}`,
    // `select-mode-dark.png` carries no delivery label under its last bubble where every other
    // capture of the same thread does. Fading rather than hiding it moves nothing either way: the
    // label is the last thing in a top-anchored log.
    `${scope}[data-slot="message-row"] [data-slot="status"]{opacity:calc(1 - var(--ios-sel-t));transition:${fade}}`,
    `${scope}[data-slot="message-row"][data-direction="incoming"]{transform:translateX(calc(var(--ios-sel-t) * ${selectModeRowShift}px));transition:${move}}`,
  ].join("");
}

/** `CSS.escape` is browser-only and this file renders on the server too. */
function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/**
 * Keeps a presented surface mounted while it plays its exit, and reports when the exit is over.
 *
 * `key` is what identifies the thing on screen; when it clears, the last value stays mounted with
 * `open: false` until the surface calls `exited`. Derived during render, never in an effect: an
 * effect leaves one committed frame with the surface already unmounted and the exit never runs.
 * That is the same rule the long-press overlay, the effects screen and the thread overlay follow,
 * written once so eight more surfaces do not each repeat it.
 */
function useExit(key: string | null) {
  const [seen, setSeen] = useState<string | null>(key);
  const [leaving, setLeaving] = useState<string | null>(null);
  if (seen !== key) {
    setSeen(key);
    setLeaving(key === null ? seen : null);
  }
  const exited = useCallback(() => setLeaving(null), []);
  // `mounted` is the key of whatever is on screen, open or leaving; `open` is whether it is staying.
  // A surface that is leaving draws with its state already gone, which is the same thing the effects
  // screen and the thread overlay above do, and is why their props are all read with `?.`.
  return { open: key !== null, mounted: key ?? leaving, exited };
}

/**
 * The photos the viewer pages over when one of them is tapped. It is NOT the tapped message's
 * photos — it is the whole RUN those photos belong to, and each photo of a multi-photo send is its
 * own message.
 *
 * MEASURED, in ChatKit on this Mac (macOS 26.5.2), by disassembling the loaded iOSSupport image the
 * way `references/image-viewer.md` describes:
 * `-[CKChatController _displayPreviewItemForMediaObject:]` — the method that puts the viewer up —
 * calls `-previewItemsForMediaObject:currentItemIndex:containsRestoring:`, sets the result on
 * `CKQLPreviewControllerDataSource.previewItems` (its only ivar, and what
 * `-numberOfPreviewItemsInPreviewController:` counts), and then sets the mock scene's
 * `currentPreviewItemIndex` to the index that call handed back.
 * `-[CKChatController(QuickLook) previewItemsForMediaObject:currentItemIndex:containsRestoring:]`
 * takes `-_chatItemForMediaObject:`, reads its `layoutGroupIdentifier`, and enumerates
 * `self.collectionViewController.chatItems` — **the whole transcript** — keeping every chat item
 * whose own `layoutGroupIdentifier` is `isEqualToString:` that one, skipping
 * `itemIsReplyContextPreview` items, and appending each kept item's `mediaObject`. The index it
 * reports back is the position of the item whose `transferGUID` matches the one that was tapped.
 * So the viewer pages ACROSS MESSAGES, over the tapped photo's layout group, and opens on the
 * photo that was tapped inside it.
 *
 * (Read there too: when the tapped item's `layoutGroupIdentifier` has zero length the identifier
 * test is skipped and every media chat item in the transcript is taken instead.)
 *
 * WHAT IS NOT MEASURED is how `layoutGroupIdentifier` is derived —
 * `-[IMOrganicAttachmentMessagePartChatItem layoutGroupIdentifier]` is two chained IMCore calls
 * into functions with no symbol. The run below is this kit's analogue of it: the maximal stretch of
 * adjacent photo messages around the tapped one, same direction and same sender, unbroken by any
 * other kind of message. That matches what a send of N photos produces — N adjacent photo messages
 * laid out as one group — but the rule itself is JUDGEMENT, not a reading.
 */
export type PhotoRun = { ids: string[]; photos: NonNullable<Message["images"]>; offsets: number[] };
/** One entry per photo of a run; `null` where that photo's tile is not in the DOM to fly out of. */
type TileRects = Array<ImageViewerRect | null>;
/** How many photos each message of the run owns, in run order. */
function runSizes(run: PhotoRun): number[] {
  return run.ids.map((_, index) => (run.offsets[index + 1] ?? run.photos.length) - run.offsets[index]);
}

export function photoRun(messages: Message[], id: string): PhotoRun {
  const centre = messages.findIndex(message => message.id === id);
  const empty = { ids: [] as string[], photos: [] as NonNullable<Message["images"]>, offsets: [] as number[] };
  if (centre < 0) return empty;
  // The same test `messageShape` uses for the image row, so the run can only ever contain messages
  // the log actually drew as photos — a message carrying `images` without `kind: "image"` draws as a
  // bubble, and a viewer that paged into it would be showing something the transcript never did.
  const isPhoto = (message: Message | undefined) =>
    Boolean(message && message.kind === "image" && message.images?.length);
  if (!isPhoto(messages[centre])) return empty;
  const joins = (a: Message, b: Message) =>
    isPhoto(b) && a.direction === b.direction && (a.sender ?? "") === (b.sender ?? "");
  let first = centre;
  while (first > 0 && joins(messages[first], messages[first - 1])) first--;
  let last = centre;
  while (last + 1 < messages.length && joins(messages[last], messages[last + 1])) last++;
  const ids: string[] = [];
  const photos: NonNullable<Message["images"]> = [];
  const offsets: number[] = [];
  for (let i = first; i <= last; i++) {
    ids.push(messages[i].id);
    offsets.push(photos.length);
    photos.push(...(messages[i].images ?? []));
  }
  return { ids, photos, offsets };
}

/**
 * Where each of the run's photo tiles sits inside the device frame, in the frame's own coordinates,
 * concatenated in the same order as `photoRun`'s photos. Read out of the DOM rather than carried in
 * the open event: only the log knows where a tile ended up after wrapping and scrolling, and a rect
 * captured at open time is stale the moment the log moves under it. `rectForIndex` is what stops the
 * fourth photo flying back into the first photo's thumbnail; a tile that is not in the DOM (past
 * `MAX_TILES`, or scrolled out of the log) has no rect, and the viewer fades for it, which is what
 * native does for an off-screen item.
 */
function useTileRects(frame: RefObject<HTMLDivElement | null>, run: PhotoRun) {
  const key = run.ids.join(" ");
  const counts = runSizes(run).join(",");
  const [measured, setMeasured] = useState<{ id: string; rects: TileRects } | null>(null);
  useLayoutEffect(() => {
    if (!key) return;
    const ids = key.split(" ");
    const sizes = counts.split(",").map(Number);
    const measure = () => {
      const next = readTileRects(frame.current, ids, sizes);
      if (next) setMeasured(current => (current?.id === key && sameRects(current.rects, next) ? current : { id: key, rects: next }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    const root = frame.current;
    if (root) observer.observe(root);
    return () => observer.disconnect();
  }, [frame, key, counts]);
  // The setter is handed back so the tap that opens the viewer can seed it in the same event, before
  // the state that mounts the viewer commits: without that seed the viewer's first frame has no
  // source rect and it opens on the fade path instead of growing out of the tile that was tapped.
  return [measured?.id === key ? measured.rects : [], setMeasured] as const;
}

/**
 * Every photo tile of a run of messages, in the frame's own coordinates and in run order — one entry
 * per photo of the run, `null` where that tile is not in the DOM.
 *
 * The nulls are the point. A run spans messages and the log only keeps the rows near the viewport, so
 * packing the survivors would slide every later photo's rect onto the wrong photo and the exit would
 * fly the third photo back into the second one's balloon. `sizes` says how many slots each message
 * owns, so a row that is not drawn leaves holes instead of closing the gap, and `rectForIndex`
 * already reads a missing rect as "fade instead of fly" — which is what native does for an
 * off-screen item anyway.
 */
// DOM rectangles include an embedding preview's transform; overlay positions use local CSS pixels.
function rectInFrame(root: HTMLElement, box: Pick<DOMRect, "left" | "top" | "width" | "height">): Rect {
  const host = root.getBoundingClientRect();
  const scaleX = host.width / root.clientWidth || 1;
  const scaleY = host.height / root.clientHeight || 1;
  return { x: (box.left - host.left) / scaleX, y: (box.top - host.top) / scaleY, width: box.width / scaleX, height: box.height / scaleY };
}

function readTileRects(root: HTMLElement | null, ids: readonly string[], sizes: readonly number[]): TileRects | null {
  if (!root || !ids.length) return null;
  const rects: TileRects = [];
  let drewAny = false;
  ids.forEach((id, index) => {
    const row = root.querySelector<HTMLElement>(`[data-message-id="${cssEscape(id)}"]`);
    const tiles = row ? Array.from(row.querySelectorAll<HTMLElement>('[data-slot="photo-tile"]')) : [];
    if (row) drewAny = true;
    for (let slot = 0; slot < (sizes[index] ?? 0); slot++) {
      const tile = tiles[slot];
      if (!tile) { rects.push(null); continue; }
      const box = tile.getBoundingClientRect();
      rects.push(rectInFrame(root, box));
    }
  });
  return drewAny ? rects : null;
}

function sameRects(a: TileRects, b: TileRects): boolean {
  return a.length === b.length && a.every((rect, index) => {
    const other = b[index];
    if (!rect || !other) return rect === other;
    return Math.abs(rect.x - other.x) < 0.5 && Math.abs(rect.y - other.y) < 0.5 &&
      Math.abs(rect.width - other.width) < 0.5 && Math.abs(rect.height - other.height) < 0.5;
  });
}

/** The top edge of one element inside the frame, in the frame's own coordinates. */
function useFrameTop(frame: RefObject<HTMLDivElement | null>, selector: string | null | false) {
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!selector) { return; }
    const measure = () => {
      const root = frame.current;
      const target = root?.querySelector<HTMLElement>(selector);
      if (!root || !target) return;
      const next = rectInFrame(root, target.getBoundingClientRect()).y;
      setTop(current => (current !== null && Math.abs(current - next) < 0.5 ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    const root = frame.current;
    if (root) observer.observe(root);
    return () => observer.disconnect();
  }, [frame, selector]);
  return selector ? top : null;
}

/** Your own reaction on a message, in the shape both the tapback bar and the viewer take. */
function ownReactionOf(message: Message | undefined): TapbackSelection | null {
  const mine = message?.reactions?.find(reaction => reaction.byMe);
  if (!mine) return null;
  return mine.emoji ? { emoji: mine.emoji } : { type: mine.type as TapbackType };
}

/**
 * Who reacted to a message, as the Tapback Details platter wants them. A reaction that names nobody
 * is yours or the person you are talking to, which is the only pair a one-to-one conversation has;
 * a group names its own people through `MessageReaction.by`.
 */
function reactorsOf(message: Message | undefined, contactName: string): TapbackReactor[] {
  if (!message?.reactions?.length) return [];
  return message.reactions.map((reaction, index) => ({
    id: `${message.id}-r${index}`,
    name: reaction.by ?? (reaction.byMe ?? true ? "You" : contactName),
    initials: reaction.byInitials,
    reaction: reaction.emoji ? undefined : (reaction.type as TapbackType),
    emoji: reaction.emoji,
    own: reaction.byMe ?? true,
  }));
}

/**
 * The whole iOS 26 Messages app in a 402×874 frame: status bar, the conversation list, the
 * conversation screen (nav bar, message log, composer), the New Message sheet, and every surface
 * those reach — the long-press overlay and the select mode its "Select" row opens, the effects
 * screen, a reply thread, the `+` menu and the
 * Photos picker, sticker sheet and voice recorder it opens, the details screen (`GroupDetails` for
 * a group, `IosDetails` for one person), the Tapback Details platter, search over the list, and the
 * full-screen photo viewer.
 *
 * Data stays with the caller: this component still only draws state, and it appends nothing to
 * `messages`. What it does own is *presentation*. Every one of those surfaces is either stated by a
 * prop — with `progress` to seek its entrance instead of playing it, which is what a harness needs —
 * or, with that prop left out, held by the shell, so the gesture that opens it natively opens it
 * here with nothing wired. See the block of surface props on `IosMessagesAppProps` for the contract.
 */
export function IosMessagesApp({
  width = iosScreen.width, height = iosScreen.height, time = "9:41", screen = "conversation", conversations = [], contact, group = false, participants,
  messages, typing = false, now, composer, screenTransition, onBack, onSelectConversation, onCompose, onCloseNewMessage, onDetails,
  thread, onOpenThread, onCloseThread,
  sendAnimation, receiveAnimation, onSendAnimationEnd,
  longPress, onLongPress, onLongPressClose, onTapback, onMenuAction, onReplayEffect,
  selectMode, onOpenSelectMode, onCloseSelectMode, selectedMessageIds, onSelectMessage, onDeleteMessages, onForwardMessages,
  effectsPicker, onEffectsPickerOpen, onEffectsTabChange, onEffectSelect, onSendWithEffect, onEffectsPickerClose,
  plusMenu, onPlusMenuSelect, onPlusMenuClose, plusMenuItems = defaultPlusMenuItems,
  photoViewer, onOpenPhoto, onPhotoIndexChange, onClosePhoto, onSharePhoto, onSavePhoto,
  photoPicker, photos, onPhotoPickerSelectionChange, onPhotoPickerDetentChange, onPhotoPickerClose,
  stickerPicker, onStickerPickerTab, onStickerPickerClose, onStickerSelect, onStickerPlace, onStickerEdit,
  audioRecorder, onAudioRecorderClose, onAudioSend,
  details, onCloseDetails, detailsContent, onGroupNameChange, onGroupEvent,
  tapbackDetails, onOpenTapbackDetails, onCloseTapbackDetails, onRemoveTapback,
  search, onOpenSearch, onCloseSearch, onSearchQueryChange, onSearchSelect, onSearchSeeAll,
  systemArrival,
  overlay, renderReactions = defaultReactions, className, style, frameRef,
}: IosMessagesAppProps) {
  const localFrame = useRef<HTMLDivElement>(null);
  const frame = frameRef ?? localFrame;
  const list = useRef<MessageListHandle>(null);
  const [pressedRect, setPressedRect] = useState<{ id: string; rect: Rect; tail: boolean } | null>(null);
  const pressed = longPress ? messages.find(message => message.id === longPress.id) : undefined;
  const pressedId = pressed?.id;
  // The overlay stays mounted for its exit timeline after `longPress` clears. Deriving this during
  // render rather than in an effect matters: an effect would leave one committed frame with the
  // overlay already gone, and the dismissal would never be seen.
  const [seenPressedId, setSeenPressedId] = useState<string | null>(pressedId ?? null);
  const [closing, setClosing] = useState<string | null>(null);
  if (seenPressedId !== (pressedId ?? null)) {
    setSeenPressedId(pressedId ?? null);
    setClosing(pressedId ? null : seenPressedId);
  }
  const overlayId = pressedId ?? closing;
  const overlayMessage = overlayId ? messages.find(message => message.id === overlayId) : undefined;

  // Same derive-during-render rule as the long-press overlay: the effects screen has to outlive the
  // prop that opened it or its exit never gets a committed frame to run in.
  const pickerOpen = effectsPicker != null;
  const [seenPickerOpen, setSeenPickerOpen] = useState(pickerOpen);
  const [pickerClosing, setPickerClosing] = useState(false);
  const [capturedDraft, setCapturedDraft] = useState("");
  if (seenPickerOpen !== pickerOpen) {
    setSeenPickerOpen(pickerOpen);
    setPickerClosing(!pickerOpen && seenPickerOpen);
  }
  const draft = effectsPicker?.draft ?? composer?.value ?? capturedDraft;

  // A screen change is a transition, not a cut, so the screen that is leaving has to outlive the
  // prop that dismissed it. Same rule as the two overlays above: the previous screen is captured
  // during render, because an effect would leave one committed frame with it already unmounted and
  // the push out would never run.
  const [seenScreen, setSeenScreen] = useState<IosScreen>(screen);
  // Whether the New Message sheet has ever been up in this app. The device animates the first
  // presentation and snaps every one after it (`iosScreenTransition.represent`), so the difference
  // is not which screen is arriving but whether the sheet already exists to arrive.
  const [sheetBuilt, setSheetBuilt] = useState(false);
  const [nav, setNav] = useState<{ from: IosScreen; to: IosScreen; run: number; built: boolean } | null>(null);
  if (seenScreen !== screen) {
    setSeenScreen(screen);
    // `built` is frozen into the transition rather than read back on every render: the sheet becomes
    // built the moment this presentation puts it up, and re-deriving the kind from that would turn
    // the presentation into a re-present halfway through and cut its own animation off.
    setNav(screenTransition ? null : current => ({ from: seenScreen, to: screen, run: (current?.run ?? 0) + 1, built: sheetBuilt }));
  }
  // A stated transition replaces a derived one. Leaving the derived one behind would replay it the
  // moment the caller stopped stating transitions.
  if (screenTransition && nav) setNav(null);
  const moving = screenTransition
    ? { from: screenTransition.from, kind: screenTransitionKind(screenTransition.from, screen, { built: screenTransition.represent }), run: -1, progress: screenTransition.progress }
    : nav
      ? { from: nav.from, kind: screenTransitionKind(nav.from, nav.to, { built: nav.built }), run: nav.run, progress: undefined }
      : null;
  const kind = moving?.kind ?? null;
  const from = kind ? moving!.from : null;
  const showList = screen === "list" || screen === "new-message" || from === "list" || from === "new-message";
  const showConversation = screen === "conversation" || from === "conversation";
  const showSheet = screen === "new-message" || kind === "dismiss";
  // Recorded after `kind`, never before: the presentation that builds the sheet has to see `false`.
  if (showSheet && !sheetBuilt) setSheetBuilt(true);
  // A re-present has no timeline, so nothing ever finishes to clear `nav` the way every other kind
  // does — it is over in the frame it starts in.
  if (nav && kind === "represent") setNav(null);
  const listLayer = useRef<HTMLDivElement>(null);
  const conversationLayer = useRef<HTMLDivElement>(null);
  const screenDim = useRef<HTMLDivElement>(null);
  const movingRun = moving?.run;
  const movingProgress = moving?.progress;
  useLayoutEffect(() => {
    if (!kind) return;
    // A re-present is not animated on the device, so there is nothing to run and nothing to seek:
    // the sheet is simply there, at rest, in the frame it appears in.
    if (kind === "represent") return;
    const t = iosScreenTransition;
    const duration = t[kind];
    const running: Animation[] = [];
    const play = (element: Element | null | undefined, keyframes: Keyframe[], easing: string = t.ease) => {
      if (element) running.push(element.animate(keyframes, { duration, easing, fill: "both" }));
    };
    // A pop is the push played backwards, so that pair is written once, in the forward direction,
    // and the frames are swapped. The sheet's *panel* is no longer such a pair — the dismissal is
    // measured and the presentation is not — but its dim still is, so `order` still serves both.
    const forward = kind === "push" || kind === "present";
    const order = (a: Keyframe, b: Keyframe) => (forward ? [a, b] : [b, a]);
    if (kind === "push" || kind === "pop") {
      play(conversationLayer.current, order({ transform: "translateX(100%)" }, { transform: "translateX(0%)" }));
      play(listLayer.current, order({ transform: "translateX(0%)" }, { transform: `translateX(${-100 * t.parallax}%)` }));
      play(screenDim.current, order({ opacity: 0 }, { opacity: t.dim }));
    } else {
      // The sheet paints its own dim on its root and holds the panel inside it, so the panel slides
      // and the dim fades separately. Reading the resting colour keeps the fade theme-correct
      // without this file knowing what the sheet's dim is.
      const sheet = frame.current?.querySelector<HTMLElement>('[data-slot="ios-new-message-sheet"]');
      const panel = sheet?.querySelector<HTMLElement>('[data-slot="sheet"]');
      const dim = sheet ? getComputedStyle(sheet).backgroundColor : "rgba(0, 0, 0, 0)";
      // Leaving, the panel runs the recorded table — linearly, because the curve is in the samples
      // and an ease over the whole effect would re-time them. Arriving, it runs the shell's guess.
      if (kind === "dismiss") play(panel, iosSheetDismissKeyframes(), "linear");
      else play(panel, [{ transform: "translateY(100%)" }, { transform: "translateY(0%)" }]);
      play(sheet, order({ backgroundColor: "rgba(0, 0, 0, 0)" }, { backgroundColor: dim }));
    }
    if (movingProgress !== undefined) {
      // Seeked, not played: a scrubbed checkpoint has to land on the same frame every run.
      const at = Math.max(0, Math.min(1, movingProgress)) * duration;
      for (const animation of running) { animation.pause(); animation.currentTime = at; }
      return () => { for (const animation of running) animation.cancel(); };
    }
    const last = running[running.length - 1];
    const done = () => setNav(null);
    last?.addEventListener("finish", done);
    // Reduced motion cuts to the destination: the same timelines, jumped to their end, so the screen
    // that is leaving still unmounts through the same finish.
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      for (const animation of running) animation.finish();
    }
    return () => {
      last?.removeEventListener("finish", done);
      for (const animation of running) animation.cancel();
    };
  }, [kind, from, movingRun, movingProgress, frame]);

  // The thread overlay follows the same derive-during-render rule so its exit gets a frame to run in.
  const threadRootId = thread?.rootId ?? null;
  const [seenThread, setSeenThread] = useState<string | null>(threadRootId);
  const [threadClosing, setThreadClosing] = useState<string | null>(null);
  if (seenThread !== threadRootId) {
    setSeenThread(threadRootId);
    setThreadClosing(threadRootId ? null : seenThread);
  }
  const threadId = threadRootId ?? threadClosing;
  const threadRoot = threadId ? messages.find(message => message.id === threadId) : undefined;
  const threadReplies = threadId ? messages.filter(message => message.replyTo?.id === threadId) : [];
  const threadOpen = threadRootId !== null;
  const threadShown = Boolean(threadRoot);
  const threadProgress = thread?.progress;
  // The thread's blur belongs to the conversation, not to the overlay. `ReplyThread` blurs either a
  // copy of the conversation passed as `backdrop` or, with neither, whatever `backdrop-filter`
  // samples, and it documents why the second is unreliable in a capture. This is the third way: the
  // conversation is already its own layer here, so blurring that layer is a real filter with no
  // second copy of the log in the DOM (a copy would duplicate every `data-message-id`, which the
  // long-press measurement below looks up by). `blur={0}` on the overlay leaves the job here, and
  // the ramp copies the overlay's own: the dim's duration, seeked on the entrance's clock.
  useLayoutEffect(() => {
    const element = conversationLayer.current;
    if (!element || !threadShown) return;
    const blur = replyThreadMetrics.ios.blur;
    const animation = threadOpen
      ? element.animate([{ filter: "blur(0px)" }, { filter: `blur(${blur}px)` }], { duration: replyThreadMotion.dim, easing: "ease-out", fill: "both" })
      : element.animate([{ filter: `blur(${blur}px)` }, { filter: "blur(0px)" }], { duration: replyThreadMotion.exit, easing: replyThreadMotion.exitEase, fill: "both" });
    if (threadOpen && threadProgress !== undefined) {
      animation.pause();
      animation.currentTime = Math.max(0, Math.min(1, threadProgress)) * replyThreadMotion.enter;
    } else if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      // The overlay jumps to its settled frame under reduced motion; the blur goes with it.
      animation.finish();
    }
    return () => animation.cancel();
  }, [threadShown, threadOpen, threadProgress]);

  useArrivalAnimation({ frame: conversationLayer, messages, send: sendAnimation, receive: receiveAnimation, onSendEnd: onSendAnimationEnd });

  // Measure the pressed bubble's body inside the frame so the overlay can lift a copy of it in place.
  // The first render after `longPress` opens has no layout yet, so measure on the next frame; the
  // observer keeps the rect right when the list scrolls, wraps, or fonts settle.
  useLayoutEffect(() => {
    if (!pressedId) return;
    let raf = 0;
    const measure = () => {
      const root = frame.current;
      const row = root?.querySelector<HTMLElement>(`[data-message-id="${pressedId}"]`);
      if (!root || !row) return;
      // Every body this message drew, minus anything inside its quoted stub. A file message can carry
      // several cards, so take the union rather than the first: the lift covers all of them.
      const bodies = Array.from(row.querySelectorAll<HTMLElement>(messageBodySelector)).filter(element => !insideQuotedStub(element));
      if (!bodies.length) return;
      const boxes = bodies.map(element => element.getBoundingClientRect());
      const left = Math.min(...boxes.map(b => b.left)), top = Math.min(...boxes.map(b => b.top));
      const rect = rectInFrame(root, { left, top, width: Math.max(...boxes.map(b => b.right)) - left, height: Math.max(...boxes.map(b => b.bottom)) - top });
      // Read the tail off the message rather than assuming one: a bubble in the middle of a cluster
      // has none, and an emoji-only message has no bubble to hang one from.
      const tail = Array.from(row.querySelectorAll<HTMLElement>('[data-slot="tail"]')).some(element => !insideQuotedStub(element));
      // Height is part of "the same rect": it used to be left out, so a body that grew without moving
      // its top-left corner or changing its width was never picked up — which is exactly what a photo
      // does when it loads and swaps the 4:3 placeholder for its own aspect.
      setPressedRect(current => (current?.id === pressedId && current.tail === tail && Math.abs(current.rect.x - rect.x) < 0.5 && Math.abs(current.rect.y - rect.y) < 0.5 && Math.abs(current.rect.width - rect.width) < 0.5 && Math.abs(current.rect.height - rect.height) < 0.5 ? current : { id: pressedId, rect, tail }));
    };
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    // Measure synchronously so the overlay is on screen at the first paint after the press. Deferring
    // it to a frame makes the opened menu appear one frame late, which is invisible to a person but
    // makes a screenshot of the opening checkpoint depend on timing.
    measure();
    const observer = new ResizeObserver(schedule);
    if (frame.current) observer.observe(frame.current);
    const row = frame.current?.querySelector(`[data-message-id="${pressedId}"]`);
    if (row) observer.observe(row);
    window.addEventListener("resize", schedule);
    document.fonts?.ready.then(schedule).catch(() => {});
    return () => { observer.disconnect(); cancelAnimationFrame(raf); window.removeEventListener("resize", schedule); };
  }, [pressedId, frame, messages, width, height]);
  const pressedBody = pressedRect && pressedRect.id === overlayId ? pressedRect : null;

  // ---------------------------------------------------------------------------------------------
  // The presented surfaces. Each resolves to `the prop, if it was passed, otherwise the shell's own
  // state`, so leaving a prop out does not disable the surface — it hands it to the shell, and the
  // gesture that opens it natively opens it here. `useExit` keeps each one mounted for its exit.
  // ---------------------------------------------------------------------------------------------
  const isGroup = group || (participants?.length ?? 0) > 1;
  // The Ø60 slot the details screen's entrance morphs out of, so a group grows out of its own faces.
  const navAvatar = participants && participants.length > 1
    ? <GroupAvatar participants={participants} size={groupAvatarMetrics.phone.groupAvatar} name={contact.name} />
    : contact.photo ? (
      // eslint-disable-next-line @next/next/no-img-element -- framework-neutral registry component
      <img src={contact.photo} alt="" className="size-full object-cover" draggable={false} />
    ) : undefined;

  const [ownPlusMenu, setOwnPlusMenu] = useState(false);
  const plusValue = plusMenu === undefined ? (ownPlusMenu ? openMarker : null) : plusMenu;
  const plusLatch = useExit(plusValue ? "open" : null);

  const [ownViewer, setOwnViewer] = useState<NonNullable<IosMessagesAppProps["photoViewer"]> | null>(null);
  const viewerValue = photoViewer === undefined ? ownViewer : photoViewer;
  const viewerLatch = useExit(viewerValue?.id ?? null);
  const viewerId = viewerLatch.mounted;
  // The photo that is showing, held by the shell whether or not the caller controls the viewer, so
  // the exit lands on the tile of the photo the reader paged to rather than the one it opened on.
  // The number counts photos in the RUN, not in one message — see `photoRun`.
  const [viewerIndex, setViewerIndex] = useState(0);
  const viewerRun = useMemo(() => photoRun(messages, viewerId ?? ""), [messages, viewerId]);
  const shownIndex = Math.min(Math.max(viewerValue?.index ?? viewerIndex, 0), Math.max(viewerRun.photos.length - 1, 0));
  // Which message of the run the photo on screen belongs to: the share, the save, the reply and the
  // tapback all act on the item that is showing, not on the one the reader happened to tap.
  const shownRunIndex = viewerRun.offsets.reduce((found, offset, index) => (offset <= shownIndex ? index : found), 0);
  const shownMessageId = viewerRun.ids[shownRunIndex] ?? viewerId;
  const shownMessage = shownMessageId ? messages.find(message => message.id === shownMessageId) : undefined;
  const shownPhotoIndex = shownIndex - (viewerRun.offsets[shownRunIndex] ?? 0);
  const [viewerRects, seedTileRects] = useTileRects(frame, viewerRun);

  const [ownPhotoPicker, setOwnPhotoPicker] = useState<NonNullable<IosMessagesAppProps["photoPicker"]> | null>(null);
  const photoPickerValue = photoPicker === undefined ? ownPhotoPicker : photoPicker;
  const photoPickerLatch = useExit(photoPickerValue ? "open" : null);
  const pickerPhotos = photos ?? photoPickerSamples;
  const picked = photoPickerValue?.selected ?? [];

  const [ownSticker, setOwnSticker] = useState<NonNullable<IosMessagesAppProps["stickerPicker"]> | null>(null);
  const stickerValue = stickerPicker === undefined ? ownSticker : stickerPicker;
  const stickerLatch = useExit(stickerValue ? "open" : null);
  // Where a dropped sticker landed, when nothing above this shell is keeping them. `onPlace` hands
  // over the settled pose, so drawing it here takes over from the ghost with no jump.
  const [placed, setPlaced] = useState<Array<{ key: string; sticker: Sticker; placement: StickerPlacement }>>([]);

  const [ownRecorder, setOwnRecorder] = useState<{ state: AudioRecorderState; take?: AudioTake } | null>(null);
  const recorderValue: NonNullable<IosMessagesAppProps["audioRecorder"]> | null = audioRecorder === undefined
    ? (ownRecorder ? { state: ownRecorder.state, levels: ownRecorder.take?.levels, duration: ownRecorder.take?.duration } : null)
    : audioRecorder;
  const recorderLatch = useExit(recorderValue ? "open" : null);

  const [ownDetails, setOwnDetails] = useState(false);
  const detailsValue = details === undefined ? (ownDetails ? openMarker : null) : details;
  const detailsLatch = useExit(detailsValue ? "open" : null);

  const [ownTapbackDetails, setOwnTapbackDetails] = useState<string | null>(null);
  const tapbackDetailsValue = tapbackDetails === undefined ? (ownTapbackDetails ? { id: ownTapbackDetails } : null) : tapbackDetails;
  const tapbackDetailsLatch = useExit(tapbackDetailsValue?.id ?? null);
  const reactedId = tapbackDetailsLatch.mounted;
  const reactedMessage = reactedId ? messages.find(message => message.id === reactedId) : undefined;
  const reactors = useMemo(() => reactorsOf(reactedMessage, contact.name), [reactedMessage, contact.name]);
  // ChatKit's `votingViewTargetFrame`: y = max(minPadding, the tapback's own frame origin). The
  // balloon is the thing the platter is about, so its own top is what anchors it.
  const platterTop = useFrameTop(frame, reactedId && `[data-message-id="${cssEscape(reactedId)}"] [data-slot="tapback"]`);

  const [ownSelectMode, setOwnSelectMode] = useState(false);
  const selectValue = selectMode === undefined ? (ownSelectMode ? openMarker : null) : selectMode;
  const selecting = selectValue !== null;
  const selectLatch = useExit(selecting ? "open" : null);
  // Mounted while the mode is open or playing its exit, and never over another screen.
  const selectShown = selectLatch.mounted !== null && showConversation;
  // The same timeline as the `IosSelectMode` below, for the two things that are not select-mode
  // components: the rules that drop the composer and step the incoming rows aside.
  const selectTransition = useSelectModeTransition({ active: selecting, progress: selectValue?.progress });
  const [ownSelected, setOwnSelected] = useState<readonly string[]>([]);
  const selectedIds = selectedMessageIds ?? ownSelected;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  /** Selection is the caller's if it owns it and the shell's otherwise; both are told either way. */
  const changeSelection = (ids: string[], id: string | null) => {
    setOwnSelected(ids);
    onSelectMessage?.(ids, { id });
  };
  const toggleSelected = (id: string) => changeSelection(selectedSet.has(id) ? selectedIds.filter(entry => entry !== id) : [...selectedIds, id], id);
  const closeSelectMode = () => {
    setOwnSelectMode(false);
    changeSelection([], null);
    onCloseSelectMode?.();
  };
  /**
   * "Select" on a message: the menu folds away and the mode opens with that message already ticked,
   * which is the one state `select-mode-dark.png` shows — exactly one circle filled.
   */
  const openSelectMode = (id: string) => {
    setOwnSelectMode(true);
    changeSelection([id], id);
    onLongPressClose?.();
    onOpenSelectMode?.(id);
  };

  const [ownSearch, setOwnSearch] = useState<NonNullable<IosMessagesAppProps["search"]> | null>(null);
  const searchValue = search === undefined ? ownSearch : search;
  const searchLatch = useExit(searchValue ? "open" : null);
  const searchShown = searchLatch.mounted !== null && showList;
  const searchListLayer = useRef<HTMLDivElement>(null);

  const closePlusMenu = () => { setOwnPlusMenu(false); onPlusMenuClose?.(); };
  /**
   * `index` arrives as the tile's index inside `id`'s own message, because that is all the tile
   * knows. The viewer counts in run photos, so it is rebased here — and `onOpenPhoto` keeps
   * reporting the message-local index it was handed, which is the number its caller can act on.
   */
  const openPhoto = (id: string, index: number) => {
    const run = photoRun(messages, id);
    const runIndex = (run.offsets[run.ids.indexOf(id)] ?? 0) + index;
    // Read the tiles in the same event that mounts the viewer, so its very first frame already has
    // the box it grows out of; both writes batch into one commit.
    const rects = readTileRects(frame.current, run.ids, runSizes(run));
    if (rects) seedTileRects({ id: run.ids.join(" "), rects });
    setViewerIndex(runIndex);
    setOwnViewer({ id, index: runIndex });
    onOpenPhoto?.(id, index);
  };
  const openTapbackDetails = (id: string) => { setOwnTapbackDetails(id); onOpenTapbackDetails?.(id); };
  const changePhotoSelection = (next: string[]) => {
    setOwnPhotoPicker(current => (current ? { ...current, selected: next } : current));
    onPhotoPickerSelectionChange?.(next);
  };
  /**
   * A row of the plus menu. The three that have a surface in this registry open it; the rest only
   * report, because there is nothing measured to open. The menu folds back into the `+` either way,
   * which is what it does natively once a row has been chosen.
   */
  const selectPlusItem = (id: string) => {
    closePlusMenu();
    if (id === "photos") setOwnPhotoPicker({ selected: [], detent: "collapsed" });
    if (id === "stickers") setOwnSticker({});
    if (id === "audio") setOwnRecorder({ state: "recording" });
    onPlusMenuSelect?.(id);
  };
  const menuItems = plusMenuItems.map(item => ({ ...item, onSelect: () => { item.onSelect?.(); selectPlusItem(item.id); } }));

  const recorderUp = recorderLatch.mounted !== null;
  const pickerUp = photoPickerLatch.mounted !== null;
  // Keep the measured gap above the bottom-anchored picker in shorter app previews too.
  const pickerComposerTop = photoPickerComposerTop + height - iosScreen.height;
  /**
   * The composer's own band is 68 tall and the recorder's root is
   * `composer.bottom + rowHeight` = 80, so the log gives up another 12 while a take is being made.
   *
   * The picker's number is a derivation, not a reading: the composer's measured top plus the 28 the
   * band already keeps clear. Nothing in `references/` shows the transcript with the picker up, so
   * how far the log is really pushed is UNMEASURED.
   */
  const listBottom = recorderUp
    ? iosScreen.listBottom + (audioRecorderMetrics.ios.composer.bottom + audioRecorderMetrics.ios.rowHeight - iosScreen.composer)
    : pickerUp
      ? iosScreen.height - photoPickerComposerTop + (iosScreen.listBottom - iosScreen.composer)
      : iosScreen.listBottom;

  /**
   * The conversation drawn again for the details screen to blur and push back. A second copy rather
   * than the layer itself because the screen owns that filter and its scale; it is `inert`, so the
   * duplicate carries no tab stops, and it comes after the live layer in the document, so every
   * `[data-message-id]` lookup in this file still finds the real row first.
   */
  // Native always draws all three circles; `details-light.png` has Call live and FaceTime and Mail
  // in the tertiary label colour, circle intact. So the default is the row, not an empty space.
  const detailsActions: IosDetailsAction[] = detailsContent?.actions ?? [
    { id: "call", label: "Call", icon: "phone", disabled: !detailsContent?.onAudioCall, onPress: detailsContent?.onAudioCall },
    { id: "facetime", label: "FaceTime", icon: "video", disabled: !detailsContent?.onFaceTime, onPress: detailsContent?.onFaceTime },
    { id: "mail", label: "Mail", icon: "mail", disabled: !detailsContent?.onMail, onPress: detailsContent?.onMail },
  ];

  const detailsBackdrop = () => (
    <div inert className="absolute inset-0" style={{ background: "var(--im-bg)" }}>
      <MessageList messages={messages} typing={typing} group={isGroup} now={now} anchor="top"
        insetTop={iosScreen.listTop} insetBottom={iosScreen.listBottom} renderReactions={renderReactions}
        className="absolute inset-0" />
      <IosScrollEdge />
      <IosNavBar name={contact.name} initials={contact.initials} avatar={navAvatar} className="absolute left-0" style={{ top: iosScreen.statusBar }} />
      {/* `attachExpanded` even here: the backdrop is `inert` and `aria-hidden`, but a `+` that says it
          has a menu and never says whether the menu is open is half an attribute wherever it sits. */}
      <IosComposer className="absolute bottom-0 left-0" value={composer?.value} placeholder={composer?.placeholder} attachExpanded={false} disabled />
    </div>
  );

  return (
    <PlatformProvider platform="ios">
      <PaletteStyle platform="ios" />
      <div ref={frame} data-slot="ios-messages-app" data-im-platform="ios" data-screen={screen} data-transition={kind ?? undefined}
        className={cn("relative isolate overflow-hidden select-none", className)}
        style={{ width, height, background: "var(--im-bg)", color: "var(--im-incoming-text)", fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif", ...style }}>
        {/* Each screen is its own layer so a transition has something to move. At rest a layer
            carries no transform: a transform node makes Chrome snap its descendants to whole CSS px,
            which would move text by a fraction of a point against the captures. */}
        {showList && (
          <div ref={listLayer} data-slot="screen-list" className="absolute inset-0" inert={screen !== "list" || searchShown || undefined} aria-hidden={screen !== "list" || searchShown || undefined} style={{ pointerEvents: screen === "conversation" ? "none" : undefined }}>
            {/* The layer search rises and falls: the list itself, without its bottom bar, because
                `IosSearch` draws that bar. Leaving both would paint the glass fill and its
                `0 6px 36px spread 4` shadow twice, which measures 1.04% against `list-light.png`
                with a -2.24 uniform darkening; hidden, the same band diffs 0.02%. */}
            <div ref={searchListLayer} className="absolute inset-0">
              <IosConversationList conversations={conversations} onSelect={onSelectConversation} onCompose={onCompose}
                onSearch={() => { setOwnSearch({ query: "" }); onOpenSearch?.(); }}
                topInset={iosScreen.statusBar} className={cn("absolute inset-0", searchShown && "[&_[data-slot=bottom-bar]]:hidden")} />
            </div>
            {(kind === "push" || kind === "pop") && <div ref={screenDim} aria-hidden="true" data-slot="screen-dim" className="pointer-events-none absolute inset-0" style={{ background: "#000000", opacity: 0 }} />}
          </div>
        )}
        {/* Search is an overlay on the list, not a fifth screen: the list stays mounted underneath
            and the two measured tables move it. `closing` picks the close table rather than playing
            the open one backwards — the recordings show they are different animations. */}
        {searchShown && (
          <IosSearch
            query={searchValue?.query}
            onQueryChange={query => { setOwnSearch({ query }); onSearchQueryChange?.(query); }}
            sections={searchValue?.sections ?? []}
            maxResults={searchValue?.maxResults}
            onSelect={onSearchSelect}
            onSeeAll={onSearchSeeAll}
            onCancel={() => { setOwnSearch(null); onCloseSearch?.(); }}
            open={searchLatch.open && !search?.closing}
            onExited={searchLatch.exited}
            progress={searchValue?.progress}
            topInset={iosScreen.statusBar}
            listRef={searchListLayer} />
        )}
        {showConversation && (
          <div ref={conversationLayer} data-slot="screen-conversation" inert={screen !== "conversation" || !!viewerLatch.mounted || undefined} aria-hidden={screen !== "conversation" || !!viewerLatch.mounted || undefined} className="absolute inset-0" style={{ background: "var(--im-bg)", pointerEvents: screen === "conversation" ? undefined : "none" }}>
            {/* Select mode wraps the whole screen rather than being mounted beside it: it generates
                no box (`display: contents`), it publishes the one `--ios-sel-t` every piece below
                animates off, and it is what cross-fades the nav bar's back button out. It stays
                wrapped whether or not the mode is on, because moving the log in or out of it would
                remount `MessageList` and lose the scroll position. */}
            <IosSelectMode active={selecting} progress={selectValue?.progress} onExited={selectLatch.exited}>
            {selectShown && <style>{selectModeRules(selectTransition.timing)}</style>}
            <MessageList ref={list} frameRef={frame} messages={messages} typing={typing} group={isGroup} now={now} anchor="top"
              insetTop={iosScreen.listTop} insetBottom={listBottom} renderReactions={renderReactions} messageActions={Boolean(onLongPress)} openMenuId={overlayMessage?.id ?? null} onReplayEffect={onReplayEffect}
              onOpenThread={onOpenThread} onOpenImage={openPhoto} systemArrival={systemArrival} className="absolute inset-0" />
            {/* Over the log and under the nav bar, so a circle scrolled up behind the bar is covered
                by it the way the bubbles are. */}
            {selectShown && (
              <SelectionCircleLayer frame={frame} messages={messages} selected={selectedSet} onToggle={toggleSelected}
                active={selecting} progress={selectValue?.progress} />
            )}
            {/* Stickers that were let go over the transcript, at the pose `onPlace` settled on: root
                coordinates, ChatKit's landed Ø48 and the angle the drop finished at, so the ghost
                unmounting is invisible. They sit over the log rather than inside a bubble, because
                nothing in `references/` measures where a landed sticker attaches. */}
            {placed.length > 0 && (
              <div aria-hidden="true" data-slot="placed-stickers" className="pointer-events-none absolute inset-0">
                {placed.map(({ key, sticker, placement }) => (
                  // `placement.x/y` is the sticker's centre, and the two font ratios are the ones
                  // `StickerArt` draws a cell with, so the landed sticker is the same artwork at the
                  // same proportions the sheet showed.
                  <span key={key} data-slot="placed-sticker" className="absolute flex items-center justify-center"
                    style={{ left: placement.x - placement.size / 2, top: placement.y - placement.size / 2, width: placement.size, height: placement.size,
                      transform: `rotate(${placement.rotation}deg)`, fontFamily: emojiFontStack,
                      fontSize: placement.size * (sticker.kind === "emoji" ? 0.78 : 0.68), lineHeight: 1,
                      background: sticker.fill, borderRadius: sticker.fill ? stickerPickerMetrics.grid.tileRadius : undefined }}>
                    {sticker.glyph}
                  </span>
                ))}
              </div>
            )}
            {/* Between the transcript and the bar: a message scrolling up under the floating glass is
                washed toward the page rather than arriving at full contrast. See `ios-scroll-edge`. */}
            <IosScrollEdge />
            <IosNavBar name={contact.name} initials={contact.initials} avatar={navAvatar} onBack={onBack}
              onDetails={() => { setOwnDetails(true); onDetails?.(); }} className="absolute left-0" style={{ top: iosScreen.statusBar }} />
            {/* The recorder replaces the field rather than sitting beside it: the two boxes overlap,
                and native swaps them. While the Photos picker is up the composer moves to its
                measured top instead, keeping its `+`, its placeholder and its mic. */}
            {recorderUp ? (
              <AudioRecorder platform="ios"
                state={recorderValue?.state ?? "recording"}
                levels={recorderValue?.levels}
                duration={recorderValue?.duration}
                position={recorderValue?.position}
                progress={recorderValue?.progress}
                transition={recorderValue?.transition}
                open={recorderLatch.open}
                onExited={recorderLatch.exited}
                onCancel={() => { setOwnRecorder(null); onAudioRecorderClose?.(); }}
                onStop={take => setOwnRecorder({ state: "stopped", take })}
                onAppend={() => setOwnRecorder(current => ({ state: "recording", take: current?.take }))}
                onPlayChange={playing => setOwnRecorder(current => (current ? { ...current, state: playing ? "playing" : "stopped" } : current))}
                onSend={take => { onAudioSend?.(take); setOwnRecorder(null); onAudioRecorderClose?.(); }} />
            ) : (
              <IosComposer className={cn("absolute left-0", !pickerUp && "bottom-0")} style={pickerUp ? { top: pickerComposerTop } : undefined}
                // Dropped by `selectModeRules`, not unmounted: it has to be on screen to be seen
                // leaving. `inert` once it has, so the toolbar over it is the only thing reachable.
                inert={(selecting && selectTransition.t > 0.5) || undefined}
                value={composer?.value} placeholder={composer?.placeholder} disabled={composer?.disabled}
                onChange={composer?.onChange} hasAttachments={picked.length > 0}
                onSend={async text => {
                  if (!composer?.onSend) return;
                  const attachments = pickerPhotos.filter((photo, index) => picked.includes(photo.id ?? String(index)));
                  await composer.onSend(text, attachments);
                  if (attachments.length) {
                    changePhotoSelection([]);
                    setOwnPhotoPicker(null);
                    if (photoPicker !== undefined) onPhotoPickerClose?.();
                  }
                }}
                attachExpanded={plusLatch.open}
                // The picker and the sticker sheet have no dismissal of their own in the capture, so
                // the control that opened them is the way back out; otherwise the `+` opens the menu.
                onAttach={() => {
                  composer?.onAttach?.();
                  if (pickerUp) { setOwnPhotoPicker(null); return; }
                  if (stickerLatch.open) { setOwnSticker(null); onStickerPickerClose?.(); return; }
                  setOwnPlusMenu(true);
                }}
                onMic={() => { composer?.onMic?.(); setOwnRecorder({ state: "recording" }); }} />
            )}
            {/* The picker's own chips over the composer. `IosComposer` has no attachment slot, so the
                shell places them; their geometry is `photoPickerChipMetrics`, which is invented. */}
            {pickerUp && picked.length > 0 && (
              // UNMEASURED: the capture that pins the panel and the composer has no chips in it, so
              // the row's own 8 pt of air above the composer is invented, as is every number in
              // `photoPickerChipMetrics` it sits on.
              <div className="absolute" style={{ left: photoPickerChipMetrics.rowInset, top: pickerComposerTop - photoPickerChipMetrics.size - 8 }}>
                <PhotoPickerAttachments photos={pickerPhotos.filter((photo, index) => picked.includes(photo.id ?? String(index)))}
                  onRemove={id => changePhotoSelection(picked.filter(entry => entry !== id))} />
              </div>
            )}
            {pickerUp && (
              <PhotoPicker
                photos={pickerPhotos}
                selected={picked}
                onSelectionChange={next => changePhotoSelection(next)}
                detent={photoPickerValue?.detent}
                onDetentChange={detent => { setOwnPhotoPicker(current => (current ? { ...current, detent } : current)); onPhotoPickerDetentChange?.(detent); }}
                open={photoPickerLatch.open}
                progress={photoPickerValue?.progress}
                onExited={() => { photoPickerLatch.exited(); onPhotoPickerClose?.(); }} />
            )}
            {/* No holding a message while selecting: in select mode every gesture on the log is the
                tick, which is what `SelectionCircleLayer`'s own capture-phase click does. */}
            {onLongPress && !selecting && <LongPressLayer frame={frame} onLongPress={onLongPress} />}
            {/* `-[CKUIBehavior canTapAssociatedAcknowledgment]` is 1: the balloon is a tap target, and
                the tap opens the platter. Delegated on the log, in the bubble phase, so it lands
                before React's own root listener and the same click cannot also open a thread. */}
            <TapbackTapLayer frame={frame} onOpen={openTapbackDetails} />
            {onEffectsPickerOpen && (
              <SendHoldLayer
                frame={frame}
                onHold={value => {
                  setCapturedDraft(value);
                  onEffectsPickerOpen(value);
                }}
              />
            )}
            {/* Last in the layer, so the ✕ sits over the nav bar it replaces the back button in and
                the toolbar over the composer it drops. Escape is the close button's own. */}
            {selectShown && (
              <>
                <IosSelectionCloseButton onClose={closeSelectMode} />
                <IosSelectionToolbar count={selectedIds.length}
                  onDelete={() => { onDeleteMessages?.([...selectedIds]); closeSelectMode(); }}
                  onForward={() => onForwardMessages?.([...selectedIds])} />
              </>
            )}
            </IosSelectMode>
          </div>
        )}
        {/* The attachments sheet, over the composer it grows out of. It draws no composer of its own
            here: the shell already has one, and the menu's own rule fades that `+` out. */}
        {plusLatch.mounted && (
          <IosPlusMenu items={menuItems} open={plusLatch.open} progress={plusValue?.progress}
            onExited={plusLatch.exited} onDismiss={closePlusMenu} />
        )}
        {/* The sticker sheet sits in the frame's own coordinate space rather than inside `overlay`,
            because the drag ghost has to travel over the transcript in the space the transcript is in. */}
        {stickerLatch.mounted && (
          <StickerPicker
            open={stickerLatch.open}
            progress={stickerValue?.progress}
            tab={stickerValue?.tab}
            dragPreview={stickerValue?.drag ?? null}
            onTabChange={tabId => { setOwnSticker(current => (current ? { ...current, tab: tabId } : current)); onStickerPickerTab?.(tabId); }}
            onDismiss={() => { setOwnSticker(null); onStickerPickerClose?.(); }}
            onExited={stickerLatch.exited}
            onSelect={onStickerSelect}
            onPlace={(sticker, placement) => {
              onStickerPlace?.(sticker, placement);
              if (!onStickerPlace) setPlaced(current => [...current, { key: `${sticker.id}-${current.length}`, sticker, placement }]);
            }}
            onEdit={onStickerEdit} />
        )}
        {(pickerOpen || pickerClosing) && (
          <IosEffectsPicker
            tab={effectsPicker?.tab}
            selection={effectsPicker?.selection ?? null}
            open={pickerOpen}
            progress={effectsPicker?.progress}
            onExited={() => setPickerClosing(false)}
            onTabChange={onEffectsTabChange}
            onSelect={onEffectSelect}
            onSend={selection => onSendWithEffect?.(draft, selection)}
            onClose={onEffectsPickerClose}
            preview={<MessageBubble direction="outgoing" tail>{draft}</MessageBubble>}
          />
        )}
        {/* The thread the reply count opened: the message it hangs off, then every message replying
            to it, over the conversation layer the effect above blurs. Its bubbles are laid out by
            the overlay rather than by the log, so they carry no screen-space fill position and take
            the mid-screen colour; no capture shows a thread, so that is provisional with the rest. */}
        {threadRoot && (
          <ReplyThread open={threadOpen} progress={threadProgress} onExited={() => setThreadClosing(null)} onClose={onCloseThread} blur={0}
            root={<ThreadRow message={threadRoot} tail />}>
            {threadReplies.map((message, index) => (
              // The measured cluster rule: only the last bubble of a run by one sender is tailed.
              <ThreadRow key={message.id} message={message} tail={index === threadReplies.length - 1 || threadReplies[index + 1].direction !== message.direction} />
            ))}
          </ReplyThread>
        )}
        {/* The details screen the name pill pushes. A group gets `GroupDetails`, one person gets
            `IosDetails`; the two take the same `progress` / `scroll` / `open` / `onExited` contract,
            so the branch is the only difference. `onBack` covers all three ways out — the Ø44 back
            circle, Escape and a committed drag-down — and the screen stays mounted until `onExited`,
            because unmounting on the back would leave its dismissal no frames to run in. */}
        {detailsLatch.mounted && (isGroup ? (
          <GroupDetails className="absolute inset-0 z-30"
            name={contact.name}
            onNameChange={onGroupNameChange && (next => { onGroupNameChange(next); onGroupEvent?.({ type: "conversationNamed", name: next }); })}
            participants={(participants ?? []).map((person, index) => ({
              id: person.name ?? person.initials ?? String(index),
              name: person.name ?? person.initials ?? "",
              initials: person.initials,
              src: person.src,
            }))}
            onAddContact={detailsContent?.onAddContact}
            hideAlerts={detailsContent?.hideAlerts} onHideAlertsChange={detailsContent?.onHideAlertsChange}
            photos={detailsContent?.photos} sharedLinks={detailsContent?.sharedLinks} attachments={detailsContent?.attachments}
            onLeave={detailsContent?.onLeave && (() => { detailsContent.onLeave!(); onGroupEvent?.({ type: "participantLeft" }); })}
            onBack={() => { setOwnDetails(false); onCloseDetails?.(); }}
            open={detailsLatch.open} progress={detailsValue?.progress} scroll={detailsValue?.scroll}
            onExited={detailsLatch.exited}
            backdrop={detailsBackdrop()} />
        ) : (
          <IosDetails className="absolute inset-0 z-30"
            name={contact.name} initials={contact.initials} avatar={navAvatar} actions={detailsActions}
            phone={detailsContent?.phone} phoneLabel={detailsContent?.phoneLabel} tag={detailsContent?.tag}
            hideAlerts={detailsContent?.hideAlerts} onHideAlertsChange={detailsContent?.onHideAlertsChange}
            photos={detailsContent?.photos} sharedLinks={detailsContent?.sharedLinks} attachments={detailsContent?.attachments}
            onBlock={detailsContent?.onBlock}
            onBack={() => { setOwnDetails(false); onCloseDetails?.(); }}
            open={detailsLatch.open} progress={detailsValue?.progress} scroll={detailsValue?.scroll}
            onExited={detailsLatch.exited}
            backdrop={detailsBackdrop()} />
        ))}
        {/* The status bar stays crisp above the effects screen, the way it does natively. */}
        <IosStatusBar time={time} className="absolute left-0 top-0" />
        {showSheet && (
          <IosNewMessageSheet onClose={onCloseNewMessage} caret style={{ pointerEvents: screen === "new-message" ? undefined : "none" }}>
            <IosComposer placeholder="" value={composer?.value} onChange={composer?.onChange} onSend={text => composer?.onSend?.(text, [])} />
          </IosNewMessageSheet>
        )}
        {/* The overlay lifts a copy of the pressed message at the same spot, so hide the original. */}
        {overlayMessage && pressedBody && <style>{messageBodyHiddenSlots.map(slot => `[data-message-id="${overlayMessage.id}"] [data-slot="${slot}"]`).join(",")}{"{visibility:hidden}"}</style>}
        {overlayMessage && pressedBody && (
          <MessageActions rect={pressedBody.rect} frame={{ width, height }} direction={overlayMessage.direction} service={overlayMessage.service ?? "imessage"}
            progress={longPress?.progress} autoFocus={longPress?.progress === undefined && !closing}
            open={!closing} onExited={() => setClosing(null)}
            // A photo's menu is Save / Copy / More…, not the text bubble's Copy / Translate / Select /
            // More… — measured on the device, see `iosPhotoMenu`.
            items={messageShape(overlayMessage) === "image" ? iosPhotoMenu : undefined}
            // Measured on the device, and both photo-only: a photo's preview lifts to a fixed 326 pt
            // width rather than by the bubble rule, its tapback pill starts 6 from the screen edge
            // rather than 10.83, and the preview carries NO TAIL even when the balloon it came from
            // has one (so the menu's gap is taken from the preview's own bottom edge — passing
            // `tail={false}` is what stops the layout adding the scaled 6.8 pt hang below it).
            {...(messageShape(overlayMessage) === "image"
              ? { scale: photoLiftScale(pressedBody.rect), barEdgeInset: messageActionsMetrics.photoBarEdgeInset, tail: false }
              : { tail: pressedBody.tail })}
            // The menu's glass picks up the bubble behind it, and a message with no bubble has none to
            // give: an emoji-only message, a photo, a link card and a file card all take the plain glass.
            wash={liftsABubble(overlayMessage) ? undefined : null}
            selected={overlayMessage.reactions?.find(r => r.byMe) ? (overlayMessage.reactions.find(r => r.byMe)!.emoji ? { emoji: overlayMessage.reactions.find(r => r.byMe)!.emoji! } : { type: overlayMessage.reactions.find(r => r.byMe)!.type as TapbackType }) : undefined}
            onSelect={selection => onTapback?.(overlayMessage.id, selection)}
            // "Select" is the one row the shell answers itself, so the mode is reachable with
            // nothing wired; the caller still hears the action, as it does for every other row.
            onAction={action => { if (action === "select") openSelectMode(overlayMessage.id); onMenuAction?.(overlayMessage.id, action); }}
            onClose={onLongPressClose}>
            {/* A photo's preview drops its tail: the last balloon of a run carries one at rest and the
                capture shows a plain rounded corner in its place once it is lifted. */}
            <LiftedMessage message={overlayMessage} tail={pressedBody.tail && messageShape(overlayMessage) !== "image"} screenBottom={pressedBody.rect.y + pressedBody.rect.height} />
          </MessageActions>
        )}
        {/* Who reacted. It paints its own `--im-dim` scrim over the whole frame and traps Tab, so it
            goes after the log and after the long-press overlay. `top` is the balloon's own top, which
            is `votingViewTargetFrame`'s rule; with nothing measured yet it falls back to `minPadding`. */}
        {reactedId && reactors.length > 0 && (
          <TapbackDetailsPlatter
            reactors={reactors}
            platform="ios"
            top={platterTop === null ? undefined : Math.max(tapbackDetailsPlatterMetrics.ios.minPadding, platterTop)}
            filter={tapbackDetailsValue?.filter}
            open={tapbackDetailsLatch.open}
            progress={tapbackDetailsValue?.progress}
            autoFocus={tapbackDetailsValue?.progress === undefined}
            onRemove={reactor => { onRemoveTapback?.(reactedId, reactor); setOwnTapbackDetails(null); onCloseTapbackDetails?.(); }}
            onClose={() => { setOwnTapbackDetails(null); onCloseTapbackDetails?.(); }}
            onExited={tapbackDetailsLatch.exited} />
        )}
        {/* The photo viewer is last: it fills the frame, draws its own status bar (`allowStatusBar`
            is 1) and covers everything, including the shell's. `rectForIndex` is what lands the exit
            on the photo that is showing rather than on the tile the entrance grew out of.
            `photos` is the whole run, not the tapped message's: measured in ChatKit, the viewer
            pages across the tapped photo's layout group. See `photoRun`. Every callback below
            reports the message the photo ON SCREEN belongs to, which after a page is not the one
            that was tapped. */}
        {viewerId && viewerRun.photos.length ? (
          <ImageViewer
            photos={viewerRun.photos}
            index={shownIndex}
            onIndexChange={index => { setViewerIndex(index); setOwnViewer(current => (current ? { ...current, index } : current)); onPhotoIndexChange?.(index); }}
            open={viewerLatch.open}
            progress={viewerValue?.progress}
            chrome={viewerValue?.chrome}
            dismissProgress={viewerValue?.dismiss}
            pageOffset={viewerValue?.pageOffset}
            sourceRect={viewerRects[shownIndex] ?? null}
            rectForIndex={index => viewerRects[index] ?? null}
            time={time}
            onClose={() => { setOwnViewer(null); onClosePhoto?.(); }}
            onExited={viewerLatch.exited}
            onShare={onSharePhoto && (() => onSharePhoto(shownMessageId, shownPhotoIndex))}
            onSave={onSavePhoto && (() => onSavePhoto(shownMessageId, shownPhotoIndex))}
            onReply={onOpenThread && (() => onOpenThread(shownMessageId))}
            reaction={ownReactionOf(shownMessage)}
            onReact={onTapback && (selection => onTapback(shownMessageId, selection))} />
        ) : null}
        {overlay}
      </div>
    </PlatformProvider>
  );
}

/**
 * Which of the log's row shapes a message takes. `message-list.tsx` picks in exactly this order, so a
 * photo whose caption happens to be one emoji is still a photo, and this has to agree with it or the
 * overlay would lift something the log never drew.
 */
type MessageShape = "link" | "image" | "audio" | "attachment" | "emoji" | "bubble";

function messageShape(message: Message): MessageShape {
  if (message.kind === "link" && message.link) return "link";
  if (message.kind === "image" && message.images?.length) return "image";
  if (message.kind === "audio" && message.audio) return "audio";
  if (message.kind === "attachment" && message.attachments?.length) return "attachment";
  return message.kind !== "link" && isEmojiOnly(message.text) ? "emoji" : "bubble";
}

/** Only these two shapes draw a coloured bubble; the rest carry their own surface, or none at all. */
function liftsABubble(message: Message): boolean {
  const shape = messageShape(message);
  return shape === "bubble" || shape === "audio";
}

/**
 * The copy the long-press overlay lifts. It has to be the same thing the log drew, so it is built the
 * same way `message-list.tsx` builds a row: a photo message lifts its photos, a file message its cards,
 * an emoji-only message a bare glyph at the log's emoji metrics, and only text and audio lift a bubble.
 * Lifting `message.text` as a bubble for every kind put a balloon reading "Photos" where the picture is.
 *
 * The glyph drops the log's `emojiShift`: the shift moves the whole element box, the overlay measured
 * the box after it moved, and the copy is placed at that measured box, so re-applying it would double it.
 */
function LiftedMessage({ message, tail, screenBottom }: { message: Message; tail: boolean; screenBottom: number }) {
  const outgoing = message.direction === "outgoing";
  switch (messageShape(message)) {
    case "link":
      return <LinkPreview href={message.link!.url} title={message.link!.title} host={message.link!.host} image={message.link!.image} />;
    case "image":
      return <MessageImages images={message.images!} direction={message.direction} tail={tail} />;
    case "audio":
      return <MessageAudio duration={message.audio!.duration} peaks={message.audio!.peaks} direction={message.direction} tail={tail} />;
    case "attachment":
      return (
        <>
          {message.attachments!.map((file, index) => (
            <MessageAttachment key={file.name + index} name={file.name} size={file.size} href={file.href}
              direction={message.direction} tail={tail && index === message.attachments!.length - 1}
              style={index ? { marginTop: bubbleMetrics.ios.gapInGroup } : undefined} />
          ))}
        </>
      );
    case "emoji":
      return (
        <div data-slot="message-bubble" data-direction={message.direction} data-platform="ios" data-emoji-only="true"
          className={cn("flex min-w-0 flex-col", outgoing ? "items-end" : "items-start")} style={{ width: "100%", fontFamily: fontStack }}>
          <div data-slot="emoji" style={{ fontSize: messageListMetrics.ios.emojiSize, lineHeight: `${messageListMetrics.ios.emojiLineHeight}px`, fontFamily: emojiFontStack, padding: `0 ${messageListMetrics.ios.emojiPadX}px`, whiteSpace: "nowrap" }}>
            <span className="sr-only">{outgoing ? "You: " : `${message.sender ?? "Contact"}: `}</span>{message.text.trim()}
          </div>
        </div>
      );
    default:
      return <MessageBubble direction={message.direction} service={message.service ?? "imessage"} tail={tail} screenBottom={screenBottom}>{message.text}</MessageBubble>;
  }
}

/** One message inside the thread overlay, on its own edge. */
function ThreadRow({ message, tail }: { message: Message; tail: boolean }) {
  return (
    <div data-slot="thread-row" data-direction={message.direction} className={cn("flex w-full", message.direction === "outgoing" ? "justify-end" : "justify-start")}>
      <MessageBubble direction={message.direction} service={message.service ?? "imessage"} tail={tail}>{message.text}</MessageBubble>
    </div>
  );
}

/**
 * Turns a press and hold on the composer's send button into `onHold(draft)`, and swallows the click
 * that a pointer release would otherwise fire so the message is not also sent.
 */
function SendHoldLayer({ frame, onHold }: { frame: RefObject<HTMLDivElement | null>; onHold: (draft: string) => void }) {
  const latest = useRef(onHold);
  useEffect(() => { latest.current = onHold; }, [onHold]);
  useEffect(() => {
    const composer = frame.current?.querySelector<HTMLElement>('[data-slot="ios-composer"]');
    if (!composer) return;
    // Delegate from the form, not the button: the send button only exists while the field has text,
    // so a listener bound to it at mount would never see the composer's first message.
    const sendAt = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.('[data-slot="send"]') ?? null;
    const draft = () => composer.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let held = false;
    const cancel = () => { if (timer) clearTimeout(timer); timer = null; };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !sendAt(event.target)) return;
      held = false;
      cancel();
      timer = setTimeout(() => { cancel(); held = true; latest.current(draft()); }, 500);
    };
    const onClick = (event: MouseEvent) => {
      if (!held || !sendAt(event.target)) return;
      // The hold already opened the effects screen; do not also send the message.
      event.preventDefault();
      event.stopPropagation();
      held = false;
    };
    const onContextMenu = (event: MouseEvent) => {
      if (!sendAt(event.target)) return;
      event.preventDefault();
      cancel();
      latest.current(draft());
    };
    composer.addEventListener("pointerdown", onPointerDown);
    composer.addEventListener("pointerup", cancel);
    composer.addEventListener("pointercancel", cancel);
    composer.addEventListener("pointerleave", cancel);
    composer.addEventListener("click", onClick, true);
    composer.addEventListener("contextmenu", onContextMenu);
    return () => {
      cancel();
      composer.removeEventListener("pointerdown", onPointerDown);
      composer.removeEventListener("pointerup", cancel);
      composer.removeEventListener("pointercancel", cancel);
      composer.removeEventListener("pointerleave", cancel);
      composer.removeEventListener("click", onClick, true);
      composer.removeEventListener("contextmenu", onContextMenu);
    };
  }, [frame]);
  return null;
}

/**
 * Turns a tap on a tapback balloon into `onOpen(messageId)`, which is what
 * `-[CKUIBehavior canTapAssociatedAcknowledgment]` = 1 makes the balloon: a control.
 *
 * Delegated on the log rather than handed to `renderReactions`, so it works for whatever balloons a
 * caller's own renderer draws, and so it can stop the click. React attaches its handlers at the app
 * root, above this element, so a native listener here runs first: stopping the click is what keeps
 * the same tap from also opening the message's thread or running a click-to-select.
 */
function TapbackTapLayer({ frame, onOpen }: { frame: RefObject<HTMLDivElement | null>; onOpen: (id: string) => void }) {
  const latest = useRef(onOpen);
  useEffect(() => { latest.current = onOpen; }, [onOpen]);
  useEffect(() => {
    const log = frame.current?.querySelector<HTMLElement>('[data-slot="message-list"]');
    if (!log) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.('[data-slot="tapback"]')) return;
      const id = target.closest("[data-message-id]")?.getAttribute("data-message-id");
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      latest.current(id);
    };
    log.addEventListener("click", onClick);
    return () => log.removeEventListener("click", onClick);
  }, [frame]);
  return null;
}

/**
 * The leading gutter of selection circles, over the log, plus the tap that ticks a row.
 *
 * `MessageSelectionRow` is one of these rows written the other way round, and every number here is
 * its number: `MessageList` builds its own rows and takes no per-row wrapper, so the shell cannot
 * wrap one, and a second log to wrap would be a second log. The geometry all comes from
 * `selectionMetrics` and `selectModeMotion`, so the overlay and the row component stay one
 * measurement rather than two.
 *
 * A circle is centred on the message **body**, not on the row — `MessageSelectionRow` explains why: a
 * reaction balloon adds headroom above the body and a status line a row of type below it, and the
 * capture moves the circle for neither. The reacted "Ok" bubble is where that shows: its body runs
 * y 552.67–592.33 and the capture's circle is centred on 572.33, the body's centre, 13.83 below the
 * row's.
 *
 * Positions are read in the log's own **content** coordinates (the body's box plus `scrollTop`), so
 * scrolling only writes this layer's transform and never re-measures.
 */
function SelectionCircleLayer({ frame, messages, selected, onToggle, active, progress }: {
  frame: RefObject<HTMLDivElement | null>;
  messages: Message[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  active: boolean;
  progress?: number;
}) {
  // The same timeline `IosSelectMode` is running around this layer. Both are pure functions of
  // `active` and `progress`, so the two calls cannot disagree; the context that would have carried
  // it is private to `ios-select-mode.tsx`.
  const transition = useSelectModeTransition({ active, progress });
  const arrived = transition.t > 0.5;
  const [spots, setSpots] = useState<{ id: string; y: number }[]>([]);
  const track = useRef<HTMLDivElement>(null);
  const latest = useRef(onToggle);
  useEffect(() => { latest.current = onToggle; }, [onToggle]);

  // A passive effect, not a layout one, for `LongPressLayer`'s reason: React attaches a child's ref
  // before its ancestors', so `frame.current` is still null while this layer's own layout effect
  // runs and the log would never be found. The circles start at opacity 0 either way.
  useEffect(() => {
    const log = frame.current?.querySelector<HTMLElement>('[data-slot="message-list"]');
    if (!log) return;
    let raf = 0;
    const follow = () => { if (track.current) track.current.style.transform = `translateY(${-log.scrollTop}px)`; };
    const measure = () => {
      // The content's own origin: where row 0 would sit however far the log is scrolled.
      const bounds = log.getBoundingClientRect();
      const scaleY = bounds.height / log.clientHeight || 1;
      const next = Array.from(log.querySelectorAll<HTMLElement>('[data-slot="message-row"][data-message-id]')).map(row => {
        // Every body this message drew, minus anything inside its quoted stub — a file message can
        // carry several cards, and the circle belongs on the middle of all of them.
        const boxes = Array.from(row.querySelectorAll<HTMLElement>(messageBodySelector))
          .filter(element => !insideQuotedStub(element)).map(element => element.getBoundingClientRect());
        const top = boxes.length ? Math.min(...boxes.map(box => box.top)) : row.getBoundingClientRect().top;
        const bottom = boxes.length ? Math.max(...boxes.map(box => box.bottom)) : row.getBoundingClientRect().bottom;
        return { id: row.getAttribute("data-message-id")!, y: ((top + bottom) / 2 - bounds.top) / scaleY + log.scrollTop };
      });
      setSpots(current => (current.length === next.length && current.every((spot, index) => spot.id === next[index].id && Math.abs(spot.y - next[index].y) < 0.5) ? current : next));
      follow();
    };
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(log);
    const content = log.querySelector('[data-slot="message-list-content"]');
    if (content) observer.observe(content);
    log.addEventListener("scroll", follow, { passive: true });
    document.fonts?.ready.then(schedule).catch(() => {});
    return () => { observer.disconnect(); cancelAnimationFrame(raf); log.removeEventListener("scroll", follow); };
  }, [frame, messages]);

  // A tap anywhere on a row ticks it, which is what select mode does to every other gesture on the
  // log. Bound in the capture phase so it lands before the tapback balloon's own delegated click and
  // before the row's tap-to-open-a-thread, and stopped there so neither of them also runs.
  useEffect(() => {
    if (!active) return;
    const log = frame.current?.querySelector<HTMLElement>('[data-slot="message-list"]');
    if (!log) return;
    const onClick = (event: MouseEvent) => {
      const id = (event.target as HTMLElement | null)?.closest?.("[data-message-id]")?.getAttribute("data-message-id");
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      latest.current(id);
    };
    log.addEventListener("click", onClick, true);
    return () => log.removeEventListener("click", onClick, true);
  }, [frame, active]);

  const size = selectionMetrics.circleSize;
  const labels = useMemo(() => new Map(messages.map(message => [message.id, message.text])), [messages]);
  return (
    // Clipped to the log's own box so a circle scrolled past the top edge is not painted over the
    // date header's inset; the nav bar comes later in the document and covers the rest.
    <div data-slot="ios-selection-circles" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div ref={track} className="absolute left-0 top-0 w-full" inert={!arrived}>
        {spots.map(spot => (
          // `flex` keeps the wrapper exactly as tall as the circle, the same reason
          // `MessageSelectionRow` gives: an inline box would add leading and pull the centre up.
          <span key={spot.id} className="absolute flex"
            style={{
              left: selectionMetrics.circleCenterX - size / 2,
              top: spot.y - size / 2,
              transform: `translateX(calc((var(--ios-sel-t) - 1) * ${selectModeMotion.circleSlide}px))`,
              opacity: "var(--ios-sel-t)",
              transition: transition.timing ? `transform ${transition.timing}, opacity ${transition.timing}` : undefined,
              pointerEvents: arrived ? "auto" : "none",
            }}>
            <SelectionCircle selected={selected.has(spot.id)} onChange={() => latest.current(spot.id)} label={labels.get(spot.id)} />
          </span>
        ))}
      </div>
    </div>
  );
}

/** Turns a long press (or right-click / double-click) on any bubble in the frame into `onLongPress(id)`. */
function LongPressLayer({ frame, onLongPress }: { frame: RefObject<HTMLDivElement | null>; onLongPress: (id: string) => void }) {
  const latest = useRef(onLongPress);
  useEffect(() => { latest.current = onLongPress; }, [onLongPress]);
  // Bind from an effect, not from a ref callback: React attaches a child's ref before its ancestors',
  // so `frame.current` is still null while this layer's ref runs and the listeners would never land.
  // The effect also removes them again, so a remounted log is not left with a stale binding.
  useEffect(() => {
    const log = frame.current?.querySelector<HTMLElement>('[data-slot="message-list"]');
    if (!log) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let target: string | null = null;
    let origin = { x: 0, y: 0 };
    const cancel = () => { if (timer) clearTimeout(timer); timer = null; target = null; };
    const idAt = (element: EventTarget | null) => (element as HTMLElement | null)?.closest?.("[data-message-id]")?.getAttribute("data-message-id") ?? null;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const id = idAt(event.target);
      if (!id) return;
      cancel(); target = id; origin = { x: event.clientX, y: event.clientY };
      timer = setTimeout(() => { const pressedId = target; cancel(); if (pressedId) latest.current(pressedId); }, 500);
    };
    const onPointerMove = (event: PointerEvent) => { if (timer && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) cancel(); };
    const onContextMenu = (event: MouseEvent) => { const id = idAt(event.target); if (id) { event.preventDefault(); cancel(); latest.current(id); } };
    const onDoubleClick = (event: MouseEvent) => { const id = idAt(event.target); if (id) { event.preventDefault(); cancel(); latest.current(id); } };
    // The keyboard equivalent of the hold: the log's arrow keys focus a message, and these keys open
    // its actions. Without this the overlay would be reachable by pointer only.
    const onKeyDown = (event: KeyboardEvent) => {
      const row = event.target as HTMLElement | null;
      if (!row?.matches?.('[data-slot="message-row"][data-message-id]')) return;
      if (event.key !== "Enter" && event.key !== " " && event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      const id = idAt(row);
      if (!id) return;
      event.preventDefault();
      cancel();
      latest.current(id);
    };
    log.addEventListener("pointerdown", onPointerDown);
    log.addEventListener("pointermove", onPointerMove);
    log.addEventListener("pointerup", cancel);
    log.addEventListener("pointercancel", cancel);
    log.addEventListener("pointerleave", cancel);
    log.addEventListener("scroll", cancel, { passive: true });
    window.addEventListener("pointerup", cancel);
    window.addEventListener("blur", cancel);
    log.addEventListener("contextmenu", onContextMenu);
    log.addEventListener("dblclick", onDoubleClick);
    log.addEventListener("keydown", onKeyDown);
    return () => {
      cancel();
      log.removeEventListener("pointerdown", onPointerDown);
      log.removeEventListener("pointermove", onPointerMove);
      log.removeEventListener("pointerup", cancel);
      log.removeEventListener("pointercancel", cancel);
      log.removeEventListener("pointerleave", cancel);
      log.removeEventListener("scroll", cancel);
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("blur", cancel);
      log.removeEventListener("contextmenu", onContextMenu);
      log.removeEventListener("dblclick", onDoubleClick);
      log.removeEventListener("keydown", onKeyDown);
    };
  }, [frame]);
  return <div data-slot="long-press-layer" className="absolute inset-0" style={{ pointerEvents: "none" }} />;
}
