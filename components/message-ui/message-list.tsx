"use client";

import { useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type Ref, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { usePlatform, type Platform } from "@/components/message-ui/platform";
import { bubbleMetrics, emojiFontStack, fontStack, type Direction, type Service } from "@/components/message-ui/tokens";
import { isEmojiOnly, MessageBubble, reactionOffsets } from "@/components/message-ui/message-bubble";
import { DateSeparator, formatClockTime, formatDateLabel, type DateSeparatorVariant } from "@/components/message-ui/date-separator";
import { LinkPreview } from "@/components/message-ui/link-preview";
import { MessageAttachment } from "@/components/message-ui/message-attachment";
import { MessageImages } from "@/components/message-ui/message-image";
import { MessageAudio } from "@/components/message-ui/message-audio";
import { InvisibleInk } from "@/components/message-ui/message-effects";
import { SwipeTimes, useSwipeToRevealTimes } from "@/components/message-ui/ios-swipe-times";
import { ReplyCount, ReplyStub } from "@/components/message-ui/message-reply";
import { FailedSendBadge, NotDelivered, ReplayEffect } from "@/components/message-ui/ios-notices";
import { TypingIndicator } from "@/components/message-ui/typing-indicator";
import { useBubbleScreenSpace } from "@/components/message-ui/use-screen-space";
import { SystemMessage, systemMessageMetrics, type SystemMessageEvent } from "@/components/message-ui/system-message";
import { SenderAvatar, senderAvatarMetricsForPlatform } from "@/components/message-ui/group-avatar";

/**
 * The scrolling message log: clusters consecutive same-sender messages (60 s window, tail on the last
 * bubble only), applies the measured group gaps and edge insets, inserts date headers after a gap of an
 * hour, places the delivery label under the last outgoing message, renders emoji-only messages as big
 * glyphs, link messages as link cards, group-chat sender names, and the typing indicator at the end.
 * Bubble fills are kept in screen space through `useBubbleScreenSpace`.
 *
 * A group also spends `senderAvatarMetricsFor`'s gutter on every incoming row and hangs the sender's
 * face on the last bubble of each run, and a message whose `kind` is "system" draws as one of
 * `system-message.tsx`'s centred grey lines instead of a balloon.
 */
export type MessageStatus = "sending" | "sent" | "delivered" | "read" | "failed";
export type MessageReaction = {
  type: string;
  byMe?: boolean;
  emoji?: string;
  /**
   * Who left it. Only a group needs it, and only the Tapback Details platter reads it; a 1:1 falls
   * back to the contact's name (or "You"). Additive: nothing that existed before this passes it.
   */
  by?: string;
  byInitials?: string;
};
export type MessageKind = "text" | "link" | "attachment" | "image" | "audio" | "typing" | "system";
export type MessageLink = { url: string; title?: string; host?: string; image?: string };
export type MessageAttachmentInfo = { name: string; size?: string; href?: string };

export type Message = {
  id: string;
  text: string;
  direction: Direction;
  service?: Service;
  sentAt: Date | number;
  sender?: string;
  senderInitials?: string;
  /** The sender's photo, for the face beside an incoming cluster in a group. */
  senderPhoto?: string;
  status?: MessageStatus;
  readAt?: Date | number;
  edited?: boolean;
  reactions?: MessageReaction[];
  kind?: MessageKind;
  link?: MessageLink;
  attachments?: MessageAttachmentInfo[];
  /** Photos or videos, when `kind` is "image". */
  images?: Array<{ src: string; alt: string; width?: number; height?: number }>;
  /** Voice message, when `kind` is "audio". */
  audio?: { duration: number; peaks?: number[] };
  /**
   * One thing that happened *to* the conversation rather than in it, when `kind` is "system": a
   * rename, a join, a leave, the group photo. It draws as a centred grey line, not a bubble, so it
   * carries no `data-message-id`, breaks a cluster, and never takes the delivery label.
   */
  system?: SystemMessageEvent;
  /** The message this one replies to. */
  replyTo?: { id: string; text: string; direction: Direction; service?: Service; sender?: string };
  /** How many replies hang off this message. */
  replyCount?: number;
  /** Sent with a bubble effect. "invisible-ink" hides the message until it is revealed. */
  /**
   * The effect the message was sent with. It outlives its own animation — that is what the Replay
   * control under the message reads, and why ChatKit carries a `REPLAY_BUTTON_TITLE` at all — so a
   * screen effect belongs here beside the four bubble ones. Only `invisible-ink` changes what the
   * bubble draws; the rest are a memory of how it arrived.
   */
  effect?: "slam" | "loud" | "gentle" | "invisible-ink"
    | "echo" | "spotlight" | "balloons" | "confetti" | "love" | "lasers" | "fireworks" | "celebration";
  /** Force the tail on or off. Native draws it only on the last bubble of a cluster; use this to reproduce captures. */
  tail?: boolean;
  /** Override the gap above this message (px). Only for reproducing captures; the cluster rule decides otherwise. */
  gapBefore?: number;
};

export type MessageListHandle = {
  scrollToBottom(behavior?: ScrollBehavior): void;
  isNearBottom(): boolean;
  /**
   * Scroll a message into view and flash it. Returns false when that message is not in this list, so a
   * shell can fall back to opening the conversation it does live in. `progress` (0..1) seeks the flash
   * instead of playing it.
   */
  jumpTo(id: string, options?: { behavior?: ScrollBehavior; progress?: number }): boolean;
  readonly element: HTMLDivElement | null;
};

export type MessageListMetrics = {
  /** Space above the first row and below the last (the shell adds the chrome's own insets). */
  insetTop: number;
  insetBottom: number;
  /**
   * Emoji-only messages: glyph size, line box, side padding, and how far the glyph sits below where Chrome
   * places it in that box. macOS measured (ink 71.5 x 70.5 = 72pt glyph, 87.3pt line box, ink 4pt from the edge).
   */
  emojiSize: number;
  emojiLineHeight: number;
  emojiPadX: number;
  emojiShift: number;
  /**
   * Extra space a tail adds under its own bubble when the next message still continues the cluster.
   * A tail normally ends a cluster, so this only applies when a caller forces `tail` on a message
   * that is not the last of its group. macOS lets the tail push the next bubble down by its hang;
   * iOS has no capture of a mid-cluster tail, so it stays 0 there.
   */
  tailSpace: number;
  /** Rows closer than this to the bottom keep auto-scrolling as messages arrive. */
  nearBottom: number;
};

export const messageListMetrics: Record<Platform, MessageListMetrics> = {
  ios: { insetTop: 0, insetBottom: 0, emojiSize: 58, emojiLineHeight: 70.3, emojiPadX: 2.4, emojiShift: 0.8, tailSpace: 0, nearBottom: 72 },
  macos: { insetTop: 0, insetBottom: 0, emojiSize: 72, emojiLineHeight: 87.3, emojiPadX: 3, emojiShift: 1, tailSpace: 4.76, nearBottom: 72 },
};

export const clusterWindowMs = 60_000;
export const dateHeaderGapMs = 3_600_000;

/**
 * Threads: opening one from the list, and jumping from a reply's quoted stub back to the message it
 * quotes.
 *
 * UNVERIFIED. Nothing in `references/` captures a thread or a jump, so the flash a jumped-to message
 * runs is built from the documented behaviour (the message pulses once and settles) and its numbers
 * are plausible, not measured. The two gesture thresholds are not invented: 500 ms and 8 px are the
 * measured hold and travel `use-long-press.ts` uses, repeated here because the list must not depend
 * on that file (it is not one of this component's registry dependencies).
 *
 * Precedence on a bubble that carries a thread as well as the press gestures, first rule that fires
 * wins:
 *
 * 1. A control inside the row takes its own click: the reply count, the stub's jump button, a link
 *    card, an attachment link, the Invisible Ink reveal. The row never second-guesses one of those.
 * 2. A press that reaches the 500 ms hold, a right click, or a double click belongs to the message
 *    actions (the shells bind those on the log itself), so the click that ends one opens no thread.
 *    A press that travelled more than 8 px is a scroll or a text drag, not a tap.
 * 3. What is left is a plain tap, and on a message that has replies it opens the thread, the way
 *    native does. Except in click-to-select mode: there a click selects the message (macOS,
 *    measured), and the reply count stays the way in.
 * 4. Keyboard: the log's arrow keys focus a row, and Enter or Space on it opens its thread. When the
 *    shell has claimed those keys for the actions menu (`messageActions`) they stay with the menu and
 *    the reply count button, which is its own tab stop, is the keyboard route into the thread.
 */
export const threadGesture = { hold: 500, moveTolerance: 8 } as const;

/**
 * The flash a message runs when a jump lands on it. Seekable by construction: it is one Web Animations
 * animation on the row, so `document.getAnimations()` reaches it and `flash={{ id, progress }}` pauses
 * and seeks it instead of playing it. UNVERIFIED, see above.
 */
export const messageFlash = { duration: 480, peak: 110, scale: 1.045, dip: 0.4, reducedDuration: 220, reducedDip: 0.6 } as const;

/** Same reading as `message-motion`'s, repeated because that file is not a dependency of this one. */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type MessageListProps = Omit<ComponentProps<"div">, "children" | "ref"> & {
  messages: Message[];
  /** Show the typing indicator after the last message. Pass the sender's name for the accessible label. */
  typing?: boolean | { sender?: string };
  /** Group conversation: show sender names above incoming clusters. */
  group?: boolean;
  /** Reference time for "Today"/"Yesterday"; defaults to now. */
  now?: Date | number;
  /** The element that represents the device screen (for the screen-space bubble fill). Defaults to the list itself. */
  frameRef?: RefObject<HTMLElement | null>;
  platform?: Platform;
  /** Service line shown above the first date header on iOS. Defaults to "Messages", or "Text Message" for all-SMS threads. */
  serviceLabel?: ReactNode | null;
  /** Render tapback balloons for a message (see tapback.tsx). */
  renderReactions?: (message: Message) => ReactNode;
  /** Keep the newest message in view when messages arrive while scrolled near the bottom. */
  autoScroll?: boolean;
  /** Show the date header above the first message (native always does; captures of a scrolled list do not). */
  firstDateHeader?: boolean;
  /**
   * The shell opens actions (the long-press overlay, the macOS context menu) on a message. Rows then
   * advertise that popup to assistive technology; the log's arrow keys reach them either way.
   */
  messageActions?: boolean;
  /**
   * The message whose actions menu is open, if one is. `aria-haspopup` on a row only says a popup
   * exists; this is what lets `aria-expanded` beside it say whether the popup is *up*, which is the
   * other half of what the attribute is for.
   */
  openMenuId?: string | null;
  /** Play a message's effect again. Without it an effect message draws no Replay control. */
  onReplayEffect?: (id: string) => void;
  /**
   * Ids of the messages a click has selected. Passing this (even empty) turns the rows into a
   * multi-select listbox and paints the selection overlay on their bubbles. macOS only: iOS has no
   * click-to-select, it has the checkbox select mode in `ios-select-mode.tsx`.
   */
  selectedIds?: readonly string[];
  /**
   * Open a message's thread. The reply count under a message calls it with "reply-count"; a plain tap
   * on a message that has replies calls it with "message" (see `threadGesture` for the precedence
   * against the press gestures). Without it the reply count stays the inert label it renders today.
   */
  onOpenThread?: (id: string, source: ThreadOpenSource) => void;
  /**
   * Jump to the message a reply quotes: activating the stub above a reply calls it. The list scrolls
   * that message into view and flashes it whenever it is in this list; the callback fires either way,
   * so a shell can close a thread or switch conversations first. A caller that answers by driving
   * `flash` itself simply restarts the same flash.
   */
  onJumpToMessage?: (id: string) => void;
  /**
   * The message whose thread is open, if one is. Only the list can tell the reply count that it is
   * expanded, so a shell that owns the thread state passes it back here for the announcement.
   */
  openThreadId?: string | null;
  /**
   * Scroll a message into view and flash it, declaratively. `progress` (0..1) pauses and seeks the
   * flash rather than playing it, which is what makes a scenario checkpoint reproducible.
   */
  flash?: { id: string; progress?: number } | null;
  /**
   * A photo tile was activated: which message it belongs to, which tile, and that tile's viewport
   * box, so a shell can grow the full-screen viewer out of the tile that was tapped. Without it the
   * tiles stay named images rather than controls, which is what they were before.
   */
  onOpenImage?: (id: string, index: number, rect: DOMRect) => void;
  /**
   * A status line arriving: it rises into place instead of appearing. `progress` (0..1) pauses and
   * seeks that entrance rather than playing it. UNVERIFIED motion — see `systemMessageMotion`.
   */
  systemArrival?: { id: string; progress?: number } | null;
  /**
   * The transcript drawer: drag the log left (or swipe two fingers on a trackpad) and every message
   * slides over to show the time it was sent, springing back on release. `ios-swipe-times.tsx` owns
   * the geometry and the gesture; this only binds it to the log and hangs a time on each message.
   * On by default on iOS, which is where native has it, and off on macOS, which has no such
   * gesture. A drag that is mostly vertical stays the log's scroll.
   *
   * `{ progress }` states the drawer instead of letting a finger drive it: 0..1, gestures inert,
   * which is what a scrubbed scenario checkpoint needs. `null` is off, the way every other stated
   * surface here spells it.
   */
  swipeTimes?: boolean | { progress?: number } | null;
  /** Where a short conversation sits: under the header ("top", native iOS) or against the composer ("bottom"). */
  anchor?: "top" | "bottom";
  insetTop?: number;
  insetBottom?: number;
  ref?: Ref<MessageListHandle>;
};

/** Which affordance opened a thread: the count under a message, or the message itself. */
export type ThreadOpenSource = "reply-count" | "message";

type Row =
  | { kind: "date"; key: string; date: number; service?: ReactNode; variant: DateSeparatorVariant }
  | { kind: "message"; key: string; message: Message; tail: boolean; gap: number; showStatus: boolean; showSender: boolean; showAvatar: boolean; cluster: string; emoji: boolean }
  | { kind: "system"; key: string; message: Message; gap: number }
  | { kind: "typing"; key: string; gap: number; sender?: string };

const ms = (v: Date | number) => (typeof v === "number" ? v : v.getTime());

function startOfDay(v: number) { const d = new Date(v); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

/** "Delivered", "Read 9:41 AM", "Read Yesterday", "Sent as Text Message". */
export function statusLabel(message: Message, now: number): string | undefined {
  switch (message.status) {
    case "delivered": return "Delivered";
    case "read": {
      if (message.readAt === undefined) return "Read";
      const at = ms(message.readAt);
      if (startOfDay(at) === startOfDay(now)) return `Read ${formatClockTime(at)}`;
      return `Read ${formatDateLabel(at, now).day}`;
    }
    case "sent": return message.service === "sms" ? "Sent as Text Message" : "Sent";
    default: return undefined;
  }
}

export function buildRows(messages: Message[], options: { platform: Platform; now: number; group: boolean; serviceLabel: ReactNode | null; firstDateHeader: boolean; typing?: { sender?: string } | null }): Row[] {
  const m = bubbleMetrics[options.platform];
  const lm = messageListMetrics[options.platform];
  const rows: Row[] = [];
  // A tail hangs below its bubble and, on macOS, takes that space from the next bubble in the cluster.
  // Measured body bottom to next body top: 3.24 / 2.93 / 3.49 / 2.74 with no tail above, 7.74 / 8.10 /
  // 8.11 / 8.23 with one (conversation-pane-dark.png, -light.png, -dark-2.png, -light-partial.png).
  let previousTail = false;
  // The id of the message that opened the run this one belongs to. It is what a sender avatar keys
  // its hand-off on: the same key at a new position means the cluster grew a bubble and the face
  // slides down to it instead of jumping.
  let cluster = "";
  // The delivery label lives under the newest outgoing message that has one: a message still sending shows
  // nothing, and the previous bubble keeps its "Delivered" until the new one is delivered.
  // A status line is not a message and must never swallow it.
  const lastOutgoing = messages.reduce((found, message, index) => (message.direction === "outgoing" && message.kind !== "link" && message.kind !== "typing" && message.kind !== "system" && statusLabel(message, options.now) !== undefined ? index : found), -1);
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.kind === "typing") continue;
    const previous = i > 0 ? messages[i - 1] : undefined;
    const next = i + 1 < messages.length ? messages[i + 1] : undefined;
    const t = ms(message.sentAt);
    const needsHeader = previous ? t - ms(previous.sentAt) > dateHeaderGapMs : options.firstDateHeader;
    // Only the header that opens the conversation carries the service name and its tight top gap; every
    // later one is a one-line mid-list header with a gap of its own on both sides.
    if (needsHeader) rows.push({ kind: "date", key: `date-${message.id}`, date: t, service: i === 0 ? options.serviceLabel : undefined, variant: i === 0 ? "first" : "mid" });
    // A status line is a centred sentence, not a balloon: it takes `systemMessageMetrics.gapAbove`
    // rather than a cluster gap, ends whatever cluster was running, and never carries a tail. It
    // leaves before the emoji and tail work below, which have nothing to say about it.
    if (message.kind === "system" && message.system) {
      rows.push({ kind: "system", key: message.id, message, gap: message.gapBefore ?? (needsHeader || !previous ? 0 : systemMessageMetrics[options.platform].gapAbove) });
      previousTail = false;
      cluster = "";
      continue;
    }
    const emoji = message.kind !== "link" && isEmojiOnly(message.text);
    const continues = (a: Message | undefined, b: Message) =>
      Boolean(a) && a!.direction === b.direction && (a!.sender ?? "") === (b.sender ?? "") && ms(b.sentAt) - ms(a!.sentAt) <= clusterWindowMs && ms(b.sentAt) - ms(a!.sentAt) >= 0 && !isEmojiOnly(a!.text) && !isEmojiOnly(b.text) && a!.kind !== "typing" && a!.kind !== "system" && b.kind !== "system";
    const inCluster = !needsHeader && continues(previous, message);
    const nextInCluster = Boolean(next) && next!.kind !== "typing" && continues(message, next!) && ms(next!.sentAt) - t <= dateHeaderGapMs;
    const tail = message.tail ?? (!emoji && message.kind !== "link" && !nextInCluster);
    // `previousTail` is only ever true here for a caller-forced tail: a derived tail is exactly
    // `!inCluster` for the row that follows, so the two can never both hold on their own.
    const gap = message.gapBefore ?? (needsHeader || !previous ? 0 : inCluster ? m.gapInGroup + (previousTail ? lm.tailSpace : 0) : m.gapBetweenGroups);
    previousTail = tail;
    if (!inCluster) cluster = message.id;
    rows.push({
      kind: "message", key: message.id, message, tail, gap, emoji, cluster,
      showStatus: i === lastOutgoing,
      showSender: options.group && message.direction === "incoming" && Boolean(message.sender) && !inCluster,
      // One face per incoming cluster, on its last (tailed) bubble, which is what the
      // `edges: leading|bottom` supplementary anchor produces natively.
      showAvatar: options.group && message.direction === "incoming" && tail,
    });
  }
  if (options.typing) rows.push({ kind: "typing", key: "typing", gap: rows.length ? m.gapBetweenGroups : 0, sender: options.typing.sender });
  return rows;
}

function EmojiMessage({ message, platform }: { message: Message; platform: Platform }) {
  const lm = messageListMetrics[platform];
  const outgoing = message.direction === "outgoing";
  return (
    <div data-slot="message-bubble" data-direction={message.direction} data-platform={platform} data-emoji-only="true"
      className={cn("flex min-w-0 flex-col", outgoing ? "items-end" : "items-start")} style={{ width: "100%", fontFamily: fontStack }}>
      <div data-slot="emoji" style={{ fontSize: lm.emojiSize, lineHeight: `${lm.emojiLineHeight}px`, fontFamily: emojiFontStack, padding: `0 ${lm.emojiPadX}px`, whiteSpace: "nowrap", position: "relative", top: lm.emojiShift }}>
        <span className="sr-only">{outgoing ? "You: " : `${message.sender ?? "Contact"}: `}</span>{message.text.trim()}
      </div>
    </div>
  );
}

export function MessageList({
  messages, typing = false, group = false, now, frameRef, platform: platformProp, serviceLabel, renderReactions, autoScroll = true,
  firstDateHeader = true, messageActions = false, openMenuId = null, onReplayEffect, selectedIds, onOpenThread, onJumpToMessage, openThreadId, flash, onOpenImage, systemArrival,
  swipeTimes, anchor = "top", insetTop, insetBottom, ref, className, style, onScroll, onKeyDown, ...props
}: MessageListProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const m = bubbleMetrics[platform];
  const lm = messageListMetrics[platform];
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  // "Today"/"Yesterday" need a clock; read it once so rendering stays pure, and never let it fall behind the newest message.
  const [mountedAt] = useState(() => Date.now());
  const nowMs = now === undefined ? messages.reduce((latest, message) => Math.max(latest, ms(message.sentAt)), mountedAt) : ms(now);
  const typingInfo = useMemo(() => (typing === false ? null : typing === true ? {} : typing), [typing]);
  const service = serviceLabel === undefined ? (messages.length && messages.every(message => message.service === "sms") ? "Text Message" : "Messages") : serviceLabel;
  const rows = useMemo(() => buildRows(messages, { platform, now: nowMs, group, serviceLabel: service, firstDateHeader, typing: typingInfo }), [messages, platform, nowMs, group, service, firstDateHeader, typingInfo]);
  // A listbox of rows only exists once the shell owns a selection; without it the log keeps the plain
  // roles it has always had, so iOS and every uncontrolled consumer are untouched.
  const selectable = selectedIds !== undefined;
  const selection = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);

  useBubbleScreenSpace(scroller, frameRef);

  // The drawer. Handing the hook a `progress` locks every gesture out and pins the drawer where the
  // number says, which is both how "off" is spelled (pinned at 0) and how a scrubbed checkpoint is.
  // The hook itself always runs, so the rules of hooks hold whichever platform this is.
  const swipeOn = swipeTimes === undefined ? platform === "ios" : Boolean(swipeTimes);
  const swipeSeek = swipeTimes && typeof swipeTimes === "object" ? swipeTimes.progress : undefined;
  const swipe = useSwipeToRevealTimes({ progress: swipeOn ? swipeSeek : 0 });
  // The log already owns its element's ref and its style, so those two come off the gesture bundle
  // and the rest is spread onto it as it is.
  const { ref: swipeRef, style: swipeStyle, ...swipePointer } = swipe.gestures;
  // One ref for two owners: the log's own element, and the non-passive wheel listener the drawer
  // binds. Turning the drawer off changes this callback's identity, so React detaches the listener.
  const setScroller = useCallback((node: HTMLDivElement | null) => {
    scroller.current = node;
    if (swipeOn) swipeRef(node);
  }, [swipeOn, swipeRef]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight - el.clientHeight, behavior });
  }, []);

  // One flash at a time: a second jump cancels the first rather than compounding two transforms on
  // two different rows.
  const flashing = useRef<Animation | null>(null);
  const jumpTo = useCallback((id: string, options?: { behavior?: ScrollBehavior; progress?: number }) => {
    const el = scroller.current;
    const row = el?.querySelector<HTMLElement>(`[data-slot="message-row"][data-message-id="${CSS.escape(id)}"]`);
    if (!el || !row) return false;
    const reduced = prefersReducedMotion();
    const listBox = el.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    // Only scroll when the message is not already fully in view: native does not shuffle the log to
    // recentre something the reader can see. Scroll this element rather than `scrollIntoView`, which
    // would also scroll every ancestor, including the page the device frame sits on.
    if (rowBox.top < listBox.top + 8 || rowBox.bottom > listBox.bottom - 8) {
      const centred = el.scrollTop + (rowBox.top - listBox.top) - Math.max(0, (el.clientHeight - rowBox.height) / 2);
      el.scrollTo({
        top: Math.max(0, Math.min(centred, el.scrollHeight - el.clientHeight)),
        // A smooth scroll runs on its own clock, so a seeked (scrubbed) jump lands instantly instead.
        behavior: options?.progress !== undefined || reduced ? "auto" : options?.behavior ?? "smooth",
      });
    }
    flashing.current?.cancel();
    const F = messageFlash;
    const duration = reduced ? F.reducedDuration : F.duration;
    // The pulse grows from the message's own edge, the side the long-press lift grows from. Every
    // keyframe carries the origin: a seeked animation never finishes, so nothing restores it later.
    const transformOrigin = row.dataset.direction === "outgoing" ? "right center" : "left center";
    const frames: Keyframe[] = reduced
      ? [{ offset: 0, opacity: 1 }, { offset: 0.5, opacity: F.reducedDip }, { offset: 1, opacity: 1 }]
      : [
        { offset: 0, opacity: 1, transform: "scale(1)", transformOrigin, easing: "ease-out" },
        { offset: F.peak / F.duration, opacity: F.dip, transform: `scale(${F.scale})`, transformOrigin, easing: "ease-in-out" },
        { offset: 1, opacity: 1, transform: "scale(1)", transformOrigin },
      ];
    const animation = row.animate(frames, { duration, fill: "both", easing: "linear" });
    flashing.current = animation;
    if (options?.progress === undefined) {
      void animation.finished.then(() => { if (flashing.current === animation) { animation.cancel(); flashing.current = null; } }).catch(() => { /* cancelled by the next jump */ });
    } else {
      animation.pause();
      animation.currentTime = Math.max(0, Math.min(1, options.progress)) * duration;
    }
    return true;
  }, []);
  useImperativeHandle(ref, () => ({ scrollToBottom, isNearBottom: () => nearBottom.current, jumpTo, get element() { return scroller.current; } }), [scrollToBottom, jumpTo]);

  /** The stub above a reply: tell the caller, then jump here if the quoted message is in this list. */
  const jump = useCallback((id: string) => { onJumpToMessage?.(id); jumpTo(id); }, [onJumpToMessage, jumpTo]);
  const messageIds = useMemo(() => new Set(messages.map(message => message.id)), [messages]);
  const threadIds = useMemo(() => new Set(messages.filter(message => message.replyCount).map(message => message.id)), [messages]);

  // A press that becomes a hold, a drag, or a second click belongs to the actions gesture, so the
  // click that ends it must not also open a thread. `threadGesture` documents the whole order.
  const press = useRef<{ x: number; y: number; at: number } | null>(null);
  const plainTap = useCallback((event: MouseEvent<HTMLElement>) => {
    const start = press.current;
    press.current = null;
    if (event.defaultPrevented || event.button !== 0 || event.detail > 1) return false;
    if ((event.target as HTMLElement | null)?.closest?.('a, button, input, textarea, select, [role="button"], [role="link"], [contenteditable]')) return false;
    if (start && (Math.hypot(event.clientX - start.x, event.clientY - start.y) > threadGesture.moveTolerance || event.timeStamp - start.at >= threadGesture.hold)) return false;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (selection && !selection.isCollapsed && selection.anchorNode && event.currentTarget.contains(selection.anchorNode)) return false;
    return true;
  }, []);

  const lastKey = rows.length ? rows[rows.length - 1].key : "";
  useLayoutEffect(() => {
    if (autoScroll && nearBottom.current) scrollToBottom();
  }, [autoScroll, scrollToBottom, lastKey, rows.length]);

  // Declared after the auto-scroll effect so the jump wins: layout effects run in order, and pinning
  // the log to the bottom first would otherwise undo the scroll this one just made.
  const flashId = flash?.id ?? null;
  const flashProgress = flash?.progress;
  useLayoutEffect(() => {
    if (!flashId) return;
    jumpTo(flashId, { progress: flashProgress });
    return () => { flashing.current?.cancel(); flashing.current = null; };
  }, [flashId, flashProgress, jumpTo]);

  const typingLabel = typingInfo?.sender ? `${typingInfo.sender} is typing` : "Someone is typing";
  const maxWidth = `calc((100% + ${2 * m.edgeInset}px) * ${m.maxWidthRatio})`;
  /**
   * What an incoming row in a group gives up on its leading edge to the sender's face:
   * `transcriptContactImageDiameter + contactPhotoBalloonMargin`, 39 on the phone and 35 on the Mac.
   * Every incoming row of the cluster spends it, not only the one that draws the face, or the
   * bubbles above the face would sit further out than the one beside it.
   */
  const gutter = group ? senderAvatarMetricsForPlatform(platform).gutter : 0;

  /**
   * The log is one tab stop and the arrow keys walk the messages inside it, so a keyboard can reach
   * a single message without adding a tab stop per bubble. Reaching one is what makes its actions
   * (the long-press overlay, the macOS context menu) available without a pointer.
   */
  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    // The drawer's keys, and only those: Enter and Space belong to a message's thread or its
    // actions here, so the hook's toggle never gets them.
    if (swipeOn && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { swipe.handlers.onKeyDown(event); return; }
    // Enter or Space on a focused message opens its thread. A shell that binds those keys to the
    // actions menu says so with `messageActions`, and then they stay with the menu: the reply count
    // under the message is its own tab stop, so the thread is still reachable without a pointer.
    if (onOpenThread && !selectable && !messageActions && (event.key === "Enter" || event.key === " ")) {
      const row = event.target as HTMLElement | null;
      const id = row?.matches?.('[data-slot="message-row"][data-message-id]') ? row.getAttribute("data-message-id") : null;
      if (id && threadIds.has(id)) { event.preventDefault(); onOpenThread(id, "message"); return; }
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const target = event.target as HTMLElement | null;
    // Let a field, a slider or a menu inside the log keep its own arrow keys.
    if (target && target !== event.currentTarget && target.closest("input, textarea, [role=slider], [role=menu]")) return;
    const rows = Array.from(scroller.current?.querySelectorAll<HTMLElement>('[data-slot="message-row"][data-message-id]') ?? []);
    if (!rows.length) return;
    event.preventDefault();
    const from = rows.findIndex(row => row === target || row.contains(target));
    const next = event.key === "Home" ? 0
      : event.key === "End" ? rows.length - 1
        : from < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1)
          : Math.min(rows.length - 1, Math.max(0, from + (event.key === "ArrowDown" ? 1 : -1)));
    rows[next]?.focus();
  }

  return (
    <div ref={setScroller} role="log" aria-live="polite" aria-relevant="additions text" aria-label="Messages" tabIndex={0}
      data-slot="message-list" data-platform={platform} onKeyDown={onListKeyDown}
      {...(swipeOn ? swipePointer : null)}
      // The drawer's keyboard route, advertised without touching the log's accessible name (which
      // stays "Messages" — `tests/e2e/helpers.ts` finds the log by it).
      aria-keyshortcuts={swipeOn ? "ArrowLeft ArrowRight" : undefined}
      data-swiping={swipe.dragging ? "true" : undefined}
      // The time column rests one full `distance` off the trailing edge, so the log has to clip
      // sideways or it would gain a horizontal scrollbar over something nobody can reach.
      className={cn("relative min-h-0 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0088ff]", swipeOn && "overflow-x-hidden", anchor === "bottom" && "flex flex-col", className)}
      style={{ fontFamily: fontStack, background: "var(--im-bg)", ...(swipeOn ? swipeStyle : null), ...style }}
      onScroll={event => {
        const el = event.currentTarget;
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < lm.nearBottom;
        onScroll?.(event);
      }} {...props}>
      <div data-slot="message-list-content" className="flex shrink-0 flex-col" role={selectable ? "listbox" : undefined} aria-multiselectable={selectable || undefined} aria-label={selectable ? "Messages" : undefined}
        style={{ padding: `${insetTop ?? lm.insetTop}px ${m.edgeInset}px ${insetBottom ?? lm.insetBottom}px`, marginTop: anchor === "bottom" ? "auto" : undefined }}>
        {rows.map(row => {
          if (row.kind === "date") return <DateSeparator key={row.key} date={row.date} now={nowMs} service={row.service} variant={row.variant} platform={platform} />;
          // `edgeInset={0}` is load-bearing, not tidiness: the content box above already applies the
          // platform's edge inset, and a second one narrows the iOS column from 370 to 338 and
          // rewraps the measured sentence. `gapBelow={0}` matches every other row here, which carries
          // its space above and none below.
          if (row.kind === "system") {
            return (
              <SystemMessage key={row.key} event={row.message.system!} platform={platform}
                gapAbove={row.gap} gapBelow={0} edgeInset={0}
                animateIn={systemArrival?.id === row.message.id ? { progress: systemArrival.progress } : undefined} />
            );
          }
          if (row.kind === "typing") {
            const typingFace = group && row.sender;
            return (
              <div key={row.key} data-slot="message-row" data-typing="true" className={cn("flex items-start", typingFace && "relative")}
                style={{ marginTop: row.gap, paddingInlineStart: gutter || undefined }}>
                {typingFace && <SenderAvatar name={row.sender} platform={platform} variant="typing" />}
                <TypingIndicator label={row.sender ? `${row.sender} is typing` : typingLabel} platform={platform} />
              </div>
            );
          }
          const { message } = row;
          const outgoing = message.direction === "outgoing";
          const incomingInGroup = gutter > 0 && !outgoing;
          const rowStyle: CSSProperties = { marginTop: row.gap, paddingInlineStart: incomingInGroup ? gutter : undefined };
          let content: ReactNode;
          // MessageBubble hangs its own reactions; every other kind needs them hung below.
          let isTextBubble = false;
          // …and so does MessageImages, which is the one kind that can be several balloons. Both own
          // their own hanging, so the generic wrapper below must skip them or the slot opens twice.
          let hangsOwnReactions = false;
          if (message.kind === "link" && message.link) {
            const link = message.link;
            content = <LinkPreview href={link.url} title={link.title} host={link.host} image={link.image} platform={platform} />;
          } else if (message.kind === "image" && message.images?.length) {
            // The photos get the reaction handed to them rather than hung by the wrapper below.
            // A message of several photos renders as a RUN of balloons (that is what the device does
            // with a multi-photo send), and the wrapper hangs its badge on the top corner of the whole
            // column — i.e. on the FIRST balloon — while `MessageImages` puts it on the last, beside
            // the tail, because that is where the message ends. One message, two answers, depending on
            // which entry point drew it. This makes `MessageImages` the only answer.
            hangsOwnReactions = true;
            content = <MessageImages images={message.images} direction={message.direction} tail={row.tail} platform={platform}
              reactions={renderReactions?.(message)}
              onOpenImage={onOpenImage ? (index, rect) => onOpenImage(message.id, index, rect) : undefined} />;
          } else if (message.kind === "audio" && message.audio) {
            content = <MessageAudio duration={message.audio.duration} peaks={message.audio.peaks} direction={message.direction} tail={row.tail} platform={platform} />;
          } else if (message.kind === "attachment" && message.attachments?.length) {
            content = (
              <>
                {message.attachments.map((file, index) => (
                  <MessageAttachment key={file.name + index} name={file.name} size={file.size} href={file.href}
                    direction={message.direction} tail={row.tail && index === message.attachments!.length - 1} platform={platform}
                    style={index ? { marginTop: m.gapInGroup } : undefined} />
                ))}
              </>
            );
          } else if (row.emoji) {
            content = <EmojiMessage message={message} platform={platform} />;
          } else {
            isTextBubble = true;
            content = (
              <MessageBubble direction={message.direction} service={message.service ?? "imessage"} tail={row.tail} platform={platform}
                sender={row.showSender ? message.sender : undefined} status={row.showStatus ? statusLabel(message, nowMs) : undefined}
                edited={message.edited} reactions={renderReactions?.(message)} emojiOnly={false} selected={selection.has(message.id)} maxWidth={maxWidth} style={{ width: "100%" }}>
                {message.text}
              </MessageBubble>
            );
          }
          // Only the text branch hands its reactions to MessageBubble. Every other kind draws its own
          // container, so without this a reaction applied to a photo, a link card, an audio row, a
          // file card or a bare emoji is stored and never painted.
          const reactions = renderReactions?.(message);
          if (reactions && !isTextBubble && !hangsOwnReactions) {
            const offset = reactionOffsets[platform];
            content = (
              <div className="relative" style={{ marginTop: offset.marginTop, display: "flex", flexDirection: "column", alignItems: outgoing ? "flex-end" : "flex-start" }}>
                {content}
                <div data-slot="reactions" className="absolute z-10" style={{ top: offset.top, [outgoing ? "left" : "right"]: offset.side }}>{reactions}</div>
              </div>
            );
          }
          if (message.effect === "invisible-ink") content = <InvisibleInk>{content}</InvisibleInk>;
          if (message.status === "failed") {
            content = (
              <div className="flex items-center" style={{ gap: 8, flexDirection: outgoing ? "row" : "row-reverse" }}>
                <FailedSendBadge platform={platform} />
                {content}
              </div>
            );
          }
          const quote = message.replyTo;
          // The stub only becomes a control when the jump has somewhere to land: the quoted message is
          // in this list, or the caller takes the jump itself. Otherwise it stays the plain quotation
          // it renders today, rather than a button that does nothing.
          const canJump = Boolean(quote) && (Boolean(onJumpToMessage) || messageIds.has(quote!.id));
          // Rule 3 of `threadGesture`: a plain tap opens the thread, but not while a click selects.
          const tapOpensThread = Boolean(onOpenThread) && Boolean(message.replyCount) && !selectable;
          const rowNode = (
            // `tabIndex -1`: the row is not its own tab stop, the log's arrow keys focus it. That is
            // what lets a keyboard open a message's actions, or its thread, without a pointer.
            <div key={row.key} data-slot="message-row" data-message-id={message.id} data-direction={message.direction} data-kind={message.kind ?? "text"}
              data-selected={selection.has(message.id) ? "true" : undefined} role={selectable ? "option" : undefined} aria-selected={selectable ? selection.has(message.id) : undefined}
              data-has-thread={message.replyCount ? "true" : undefined}
              tabIndex={-1}
              // The row advertises one popup, and the actions menu keeps it when a shell binds one:
              // that is what Enter and Space do there. The reply count under the message carries the
              // thread's own `aria-haspopup="dialog"`, so a thread is announced either way.
              //
              // `aria-haspopup` on its own only says a popup exists; without `aria-expanded` beside
              // it nothing can say whether the popup is *open*, which is half of what the attribute
              // is for. The row knows: `openMenuId` is the message whose menu is up.
              aria-haspopup={messageActions ? "menu" : tapOpensThread ? "dialog" : undefined}
              aria-expanded={messageActions ? openMenuId === message.id : tapOpensThread ? openThreadId === message.id : undefined}
              onPointerDown={tapOpensThread ? (event: PointerEvent<HTMLDivElement>) => { press.current = { x: event.clientX, y: event.clientY, at: event.timeStamp }; } : undefined}
              onClick={tapOpensThread ? (event: MouseEvent<HTMLDivElement>) => { if (plainTap(event)) onOpenThread!(message.id, "message"); } : undefined}
              data-effect={message.effect} className={cn("flex min-w-0 flex-col focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]", incomingInGroup && "relative", outgoing ? "items-end" : "items-start")}
              style={tapOpensThread ? { ...rowStyle, cursor: "pointer" } : rowStyle}>
              {/* The sender's face, anchored to the row's leading edge and flush with the balloon's
                  bottom. `cluster` is the run's first message id, so when the run grows a bubble the
                  same key turns up at a new position and the face slides rather than jumps. */}
              {row.showAvatar && (
                <SenderAvatar name={message.sender} initials={message.senderInitials} src={message.senderPhoto}
                  platform={platform} handoffKey={`${platform}:${row.cluster}`} />
              )}
              {quote && (canJump ? (
                // A button with no box of its own: the stub keeps every measured edge, and the whole
                // quotation is the hit target, the way a quoted stub behaves natively. The copy inside
                // is hidden from assistive technology because this label already reads it out.
                <button type="button" data-slot="reply-jump" data-target-id={quote.id}
                  onClick={event => { event.stopPropagation(); jump(quote.id); }}
                  aria-label={`Replying to ${quote.sender ?? (quote.direction === "outgoing" ? "your message" : "their message")}: ${quote.text}. Go to that message.`}
                  className="flex w-full min-w-0 cursor-pointer flex-col focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]"
                  style={{ alignItems: "inherit", margin: 0, padding: 0, border: 0, background: "transparent", font: "inherit", color: "inherit", textAlign: "inherit", appearance: "none" }}>
                  <ReplyStub quote={quote} aria-hidden="true" platform={platform} />
                </button>
              ) : <ReplyStub quote={quote} platform={platform} />)}
              {content}
              {/* An effect message carries a control that plays it again. ChatKit's own copy:
                  `REPLAY_BUTTON_TITLE` is the visible "Replay", and the accessible name is the
                  per-effect `EFFECT_CONTROL_BUTTON_TITLE_*` / `FSM_CONTROL_BUTTON_TITLE_*` — "Replay
                  Slam", "Replay Balloons". Nothing here had one at all, so a message sent with an
                  effect could be watched exactly once. */}
              {message.effect && onReplayEffect && (
                <span data-slot="replay-controls" style={{ display: "contents" }} onClick={event => event.stopPropagation()}>
                  <ReplayEffect kind={message.effect} platform={platform} onReplay={() => onReplayEffect(message.id)} />
                </span>
              )}
              {message.status === "failed" && <NotDelivered platform={platform} />}
              {message.replyCount ? (onOpenThread ? (
                // `display: contents` keeps the button exactly where it was in the layout while giving
                // the click somewhere to stop: opening a thread should not also run the shell's
                // click-to-select on the message behind it.
                <span data-slot="thread-controls" style={{ display: "contents" }} onClick={event => event.stopPropagation()}>
                  <ReplyCount count={message.replyCount} platform={platform} expanded={openThreadId === undefined ? undefined : openThreadId === message.id}
                    onOpen={() => onOpenThread(message.id, "reply-count")} />
                </span>
              ) : <ReplyCount count={message.replyCount} platform={platform} />) : null}
            </div>
          );
          if (!swipeOn) return rowNode;
          // `timeInset={0}`, not the metric's 16: that 16 is measured from the *screen's* trailing
          // edge, and the content box above has already spent it as its edge inset. Passing it
          // again would set the times 16 further in than the capture's x 385.
          return (
            <SwipeTimes key={row.key} time={formatClockTime(ms(message.sentAt))} progress={swipe.progress} timeInset={0}>
              {rowNode}
            </SwipeTimes>
          );
        })}
      </div>
    </div>
  );
}
