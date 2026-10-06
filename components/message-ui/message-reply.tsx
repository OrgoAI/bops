"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { usePlatform, type Platform } from "@/components/message-ui/platform";
import { bodyClipPath, tailBox, tailPath, tailSeamOverlap } from "@/components/message-ui/bubble-shape";
import { bubbleMetrics, fontStack, type Direction, type Service } from "@/components/message-ui/tokens";
import { MessageBubble } from "@/components/message-ui/message-bubble";

/**
 * Inline replies: the quoted stub above a reply, the "N replies" affordance under a message that has
 * a thread, and the focused thread view.
 *
 * PARTLY MEASURED. No native capture of a reply thread exists in `references/`, so the two numbers
 * that describe the stub itself stay provisional: it is drawn at `stubScale` (0.76) of the quoted
 * bubble and at `stubOpacity` (55%). What the stub is built from is measured, and is derived here
 * rather than guessed:
 *
 * - Type, padding, radius, minimum width, tail and maximum width are the platform's measured bubble
 *   metrics multiplied by `stubScale`, so the stub is a real bubble at 76% rather than a picture of
 *   one. It is laid out at that size (no `transform: scale`), which matters for three measured
 *   behaviours: the stub's own edge lands exactly on the reply bubble's measured edge inset, its
 *   screen-space gradient stays in screen coordinates, and `MessageBubble`'s shrink-to-fit still
 *   measures line boxes in unscaled px (under a transform, `getClientRects` returns scaled px and the
 *   bubble sets a frame `scale` too narrow; `message-actions.tsx` documents the same trap).
 * - The gap under the stub is the measured cluster gap (4.33 iOS / 3 macOS), body bottom to body top,
 *   or the measured between-cluster gap (10.33 / 11.5) when the stub carries a tail, that being the
 *   one measured gap a tail is known to hang into. Tails take no layout space, as measured.
 * - A long quote is clamped to `stubMaxLines` with an ellipsis instead of wrapping without limit. Two
 *   lines is what the measured conversation-list preview uses on both platforms and the stub is the
 *   same kind of quotation, but nothing has been measured on the stub itself.
 * - The stub's tail is off by default. The measured rule ("only the last bubble of a cluster has a
 *   tail") would give a lone quoted copy one, but no capture shows the stub, so it stays a prop. When
 *   it is on, the tail is drawn outside the body and nothing on the stub clips it.
 *
 * The reply count reuses the measured secondary label ("Delivered": 11pt / 10pt semibold, its
 * tracking, its gap under the bubble, and #8a8a8e / #808080) rather than a size and colour of its own.
 *
 * NOTHING ABOUT THE THREAD SURFACE IS MEASURED. No capture in `references/` shows a reply thread, and
 * none shows the transition into or out of one, so the count's hit target, the thread's chrome and
 * every timing in `replyThreadMotion` are plausible values rather than readings. They are kept in the
 * family of the two motions that were measured: the long-press overlay (dim 150 ms, entrance 600,
 * dismissal 220) and the "Send with effect" screen (entrance 260, exit 200). The only positions
 * borrowed from a capture are the iOS back control's measured Ø44 box centred (38, 84) and the
 * measured edge insets and cluster gaps the messages inside the thread already use.
 */
export type ReplyQuote = {
  id: string;
  text: string;
  direction: Direction;
  service?: Service;
  sender?: string;
};

/**
 * The stub is **not** a scaled bubble, which is what this file used to assume. ChatKit gives it its
 * own type, its own corner and its own box, and none of them is 0.76 of the bubble's:
 *
 * | value | ChatKit | what `stubScale` 0.76 gave |
 * |---|---|---|
 * | font | `_replyBalloonTextFont` .SFNS-Regular **11.00** | 12.93 |
 * | corner | `textReplyBalloonCornerRadius` **17.5** | 15.21 |
 * | min height | `replyBalloonMinHeight` **26** | 30.4 |
 * | min width | `replyPreviewBalloonMinWidth` **48** | 36.5 |
 * | text inset | `replyBalloonTextContainerInset` **{6.5, 0, 6.5, 0}** | 7.6 / 10.5 |
 * | max lines | `replyBalloonMaximumNumberOfLines` **3** | 2 |
 *
 * The corner is nearly as round as a full bubble's while the type is two thirds the size, so a
 * uniform scale could never have produced it. `stubOpacity` survives: `replyPreviewBalloonImageAlpha`
 * is 0.55, exactly what SPEC already carried.
 *
 * `stubScale` is kept for the parts ChatKit says nothing about - the tail, and the maximum width -
 * so those stay derived from the bubble as before, and it is no longer used for anything ChatKit
 * settles.
 *
 * **macOS is not the same.** `CKUIBehaviorMac` overrides three of them, read at idiom 5 rather than
 * assumed: `textReplyBalloonCornerRadius` **15**, `replyBalloonMinHeight` **20** and
 * `replyBalloonTextContainerInset` **{2, 0, 2, 0}**. It inherits `replyPreviewBalloonMinWidth` 48,
 * `replyBalloonMaximumNumberOfLines` 3 and `replyPreviewBalloonImageAlpha` 0.55. Its reply font was
 * not read, so macOS still derives that one from its own bubble.
 */
export const replyMetrics: Record<Platform, { stubScale: number; stubOpacity: number; stubMaxLines: number }> = {
  ios: { stubScale: 0.76, stubOpacity: 0.55, stubMaxLines: 3 },
  macos: { stubScale: 0.78, stubOpacity: 0.55, stubMaxLines: 3 },
};

/** What ChatKit fixes about the stub, read once per idiom rather than assumed to be shared. */
const stubChatKit: Record<Platform, { fontSize: number | null; insetY: number; radius: number; minHeight: number; minWidth: number }> = {
  // `_replyBalloonTextFont` .SFNS-Regular 11, `replyBalloonTextContainerInset` {6.5,0,6.5,0},
  // `textReplyBalloonCornerRadius` 17.5, `replyBalloonMinHeight` 26, `replyPreviewBalloonMinWidth` 48.
  ios: { fontSize: 11, insetY: 6.5, radius: 17.5, minHeight: 26, minWidth: 48 },
  // The Mac class overrides the first four; `fontSize` null means it was not read there, so the
  // stub's type still comes from the bubble.
  macos: { fontSize: null, insetY: 2, radius: 15, minHeight: 20, minWidth: 48 },
};

/** The stub's geometry: ChatKit's own numbers, and the bubble's only where ChatKit is silent. */
export function replyStubMetrics(platform: Platform) {
  const m = bubbleMetrics[platform];
  const scale = replyMetrics[platform].stubScale;
  const ck = stubChatKit[platform];
  // The line box carries the minimum on one line: iOS 26 - 2 x 6.5 = 13, macOS 20 - 2 x 2 = 16.
  const lineHeight = ck.minHeight - ck.insetY * 2;
  return {
    scale,
    fontSize: ck.fontSize ?? m.fontSize * scale,
    lineHeight,
    // No horizontal text inset of ChatKit's own, so the balloon's own padding is the bubble's,
    // scaled - the one place the old uniform scale still has to answer.
    paddingX: m.paddingX * scale,
    paddingY: ck.insetY,
    radius: ck.radius,
    minWidth: ck.minWidth,
    minHeight: ck.minHeight,
    letterSpacing: m.letterSpacing * scale,
    tailScale: m.tailScale * scale,
    /** How far the tail hangs below the body. It is drawn outside the body and takes no space. */
    hang: tailBox.hang * m.tailScale * scale,
    /** Stub body bottom to the reply body's top, without and with a tail. */
    gap: m.gapInGroup,
    gapWithTail: m.gapBetweenGroups,
    /**
     * A bubble's own rule (fixed px on iOS, a share of the pane on macOS), scaled. The macOS share is
     * of the pane, and a row is inset from it on both sides, so add the insets back the way
     * `message-list` does before taking the share.
     */
    maxWidth: platform === "ios"
      ? `min(${(m.maxWidth * scale).toFixed(2)}px, 100%)`
      : `min(calc((100% + ${2 * m.edgeInset}px) * ${(m.maxWidthRatio * scale).toFixed(5)}), 100%)`,
  };
}

/** Height of a stub body of `lines` lines. The tail hang and the gap below it are extra. */
export function replyStubHeight(platform: Platform, lines = 1): number {
  const s = replyStubMetrics(platform);
  return s.lineHeight * lines + s.paddingY * 2;
}

/**
 * A bubble hugs its longest wrapped line instead of stretching to its maximum width (measured), and
 * CSS shrink-to-fit cannot express that, so the laid-out line boxes are measured and the frame's width
 * set from them. `MessageBubble` does the same for real bubbles; the stub cannot borrow that hook
 * because it lays out at `stubScale`, and the copy is small enough to keep the loop simple: clamped
 * lines are still laid out, so they take part in the measurement, and the widest one can only be the
 * width already available, which leaves the frame where it is.
 */
function useStubTextFit(paddingX: number, deps: unknown[]) {
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frameEl = frame.current;
    const textEl = frameEl?.querySelector<HTMLElement>('[data-slot="text"]');
    if (!frameEl || !textEl) return;
    const container = frameEl.parentElement;
    let raf = 0;
    const measure = () => {
      frameEl.style.width = "";
      const range = document.createRange();
      range.selectNodeContents(textEl);
      const lines: Array<{ top: number; left: number; right: number }> = [];
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width === 0 && rect.height === 0) continue;
        const line = lines.find(l => Math.abs(l.top - rect.top) < 1);
        if (line) { line.left = Math.min(line.left, rect.left); line.right = Math.max(line.right, rect.right); }
        else lines.push({ top: rect.top, left: rect.left, right: rect.right });
      }
      if (lines.length < 2) return;
      const longest = Math.max(...lines.map(l => l.right - l.left));
      const hug = Math.ceil((longest + 2 * paddingX) * 100) / 100 + 0.05;
      if (hug < frameEl.getBoundingClientRect().width - 0.1) frameEl.style.width = `${hug}px`;
    };
    measure();
    const observer = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); });
    if (container) observer.observe(container);
    document.fonts?.ready.then(() => measure()).catch(() => {});
    return () => { observer.disconnect(); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paddingX, ...deps]);
  return frame;
}

/** The stub above a reply: the quoted message, smaller and dimmer, on the reply's own edge. */
export function ReplyStub({ quote, tail = false, maxLines, platform: platformProp, className, style, ...props }: Omit<ComponentProps<"div">, "children"> & {
  quote: ReplyQuote; tail?: boolean; maxLines?: number; platform?: Platform;
}) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const s = replyStubMetrics(platform);
  const lines = maxLines ?? replyMetrics[platform].stubMaxLines;
  const outgoing = quote.direction === "outgoing";
  const side = outgoing ? "right" : "left";
  const service = quote.service ?? "imessage";
  const key = outgoing ? (service === "sms" ? "green" : "blue") : "gray";
  const frame = useStubTextFit(s.paddingX, [quote.text, platform, lines, tail]);

  // The same screen-space fill a bubble uses: one gradient the height of the screen, anchored to this
  // body's bottom edge. `use-screen-space.ts` keeps `--bubble-bottom` current while the list scrolls.
  const bottomVar = "var(--bubble-bottom, calc(var(--im-screen-h) * 0.55))";
  const fill: CSSProperties = {
    backgroundImage: "linear-gradient(var(--im-fill-top), var(--im-fill-bottom))",
    backgroundSize: "100% var(--im-screen-h)",
    backgroundRepeat: "no-repeat",
    backgroundColor: "var(--im-fill-bottom)",
  };

  return (
    // The row is a flex column aligned to the reply's own side; `align-items: inherit` hands that
    // alignment to the copy. Shrink-to-fit alone would not: a quote long enough to reach the stub's
    // maximum width makes this box fill the row, and the copy inside it would sit on the far edge.
    <div data-slot="reply-stub" data-direction={quote.direction} data-platform={platform}
      className={cn("pointer-events-none flex w-full flex-col select-none", className)}
      style={{ fontFamily: fontStack, alignItems: "inherit", opacity: replyMetrics[platform].stubOpacity, marginBottom: tail ? s.gapWithTail : s.gap, ...style }} {...props}>
      <span className="sr-only">{`Replying to ${quote.sender ?? (outgoing ? "your message" : "their message")}: ${quote.text}`}</span>
      {/* The copy itself is decorative: the sentence above already reads the quote out. */}
      <div ref={frame} aria-hidden="true" data-slot="message-bubble" data-stub="true" data-direction={quote.direction} data-service={service} data-platform={platform}
        className="relative"
        style={{ maxWidth: s.maxWidth, "--im-fill-top": `var(--im-${key}-top)`, "--im-fill-bottom": `var(--im-${key}-bottom)` } as CSSProperties}>
        <div data-slot="bubble" className="relative" style={{
          fontSize: s.fontSize, lineHeight: `${s.lineHeight}px`, letterSpacing: s.letterSpacing,
          padding: `${s.paddingY}px ${s.paddingX}px`, minWidth: s.minWidth, textAlign: "start",
          color: outgoing ? "var(--im-outgoing-text)" : "var(--im-incoming-text)",
        }}>
          {/* The fill sits behind the text, so clipping the tail corner never clips glyphs. */}
          <div data-slot="fill" className="pointer-events-none absolute inset-0" style={{
            borderRadius: s.radius, clipPath: tail ? bodyClipPath(side, s.tailScale, tailSeamOverlap[platform]) : `inset(0 round ${s.radius}px)`,
            ...fill, backgroundPosition: `0 calc(100% + (var(--im-screen-h) - ${bottomVar}))`,
          }} />
          {tail && <div data-slot="tail" className="pointer-events-none absolute" style={{
            [side]: 0, bottom: -s.hang, width: tailBox.width * s.tailScale, height: tailBox.height * s.tailScale + s.hang,
            clipPath: `path("${tailPath(side, s.tailScale)}")`,
            ...fill, backgroundPosition: `0 calc(100% + (var(--im-screen-h) - ${bottomVar} - ${s.hang}px))`,
          }} />}
          {/* `fit-content` centres a quote too short to fill the minimum width and leaves a wrapped one
              flush; the clamp lives here so the body never puts the tail inside an `overflow: hidden`. */}
          <span data-slot="text" className="relative" style={{
            display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden",
            width: "fit-content", marginInline: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
          }}>{quote.text}</span>
        </div>
      </div>
    </div>
  );
}

/** A reply: the quoted stub, then the reply bubble itself, both on the reply's own edge. */
export function ReplyMessage({ quote, direction = "outgoing", service, tail = false, status, stubTail = false, stubMaxLines, children, platform: platformProp, className, style, ...props }: Omit<ComponentProps<"div">, "children"> & {
  quote: ReplyQuote; direction?: Direction; service?: Service; tail?: boolean; status?: ReactNode;
  stubTail?: boolean; stubMaxLines?: number; children: ReactNode; platform?: Platform;
}) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const m = bubbleMetrics[platform];
  // macOS caps a bubble at a share of the *pane*, and `MessageBubble` resolves that percentage against
  // its own box. Left to shrink-wrap inside this row the box is only as wide as the text, so the cap
  // collapses onto it and the bubble is squeezed to a few characters. Fill the row and hand the bubble
  // the same maximum `message-list` does, insets added back.
  const maxWidth = platform === "ios" ? undefined : `calc((100% + ${2 * m.edgeInset}px) * ${m.maxWidthRatio})`;
  return (
    <div data-slot="reply-message" data-direction={direction} className={cn("flex w-full min-w-0 flex-col", direction === "outgoing" ? "items-end" : "items-start", className)} style={style} {...props}>
      <ReplyStub quote={quote} tail={stubTail} maxLines={stubMaxLines} platform={platform} />
      <MessageBubble direction={direction} service={service} tail={tail} status={status} platform={platform}
        maxWidth={maxWidth} style={{ width: "100%" }}>{children}</MessageBubble>
    </div>
  );
}

/**
 * How far the reply count's hit target reaches past its ink. UNMEASURED. The label is the measured
 * secondary label, 13 pt of line box on iOS and 11 on macOS, which is far under a comfortable target,
 * so the button hangs an invisible box off the ink instead of taking padding: padding would move the
 * label off the measured `statusGap`. It reaches further down than up because up is that gap and then
 * the bubble, which keeps its own long-press and right-click gestures.
 */
export const replyCountHit: Record<Platform, { x: number; top: number; bottom: number }> = {
  ios: { x: 10, top: 4, bottom: 13 },
  macos: { x: 8, top: 3, bottom: 8 },
};

/**
 * "1 reply" under a message that started a thread, set in the measured secondary label.
 *
 * It is a real control: a button (so Enter and Space open the thread), an accessible name that says
 * how many replies it opens and that it opens a dialog, hover and focus feedback, and a hit target
 * larger than the ink. `expanded` reflects whether the thread it opens is on screen.
 *
 * The feedback is a web affordance, not a reading: no capture shows this label being pointed at, and
 * SPEC.md records that macOS Messages paints no hover state on its rows or bubbles at all. It costs no
 * fidelity because it only exists while the pointer or the focus ring is on the control: at rest the
 * button paints exactly the measured label, verified pixel for pixel against the `reply` baseline.
 */
export function ReplyCount({ count, onOpen, expanded, platform: platformProp, className, style, ...props }: Omit<ComponentProps<"button">, "children" | "onClick"> & { count: number; onOpen?: () => void; expanded?: boolean; platform?: Platform }) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const m = bubbleMetrics[platform];
  const hit = replyCountHit[platform];
  return (
    // `aria-haspopup` only when something is wired to it: an unwired count opens nothing and should
    // not say that it does.
    <button type="button" data-slot="reply-count" data-count={count} data-platform={platform} onClick={onOpen}
      aria-haspopup={onOpen ? "dialog" : undefined} aria-expanded={expanded} aria-label={count === 1 ? "Show 1 reply" : `Show ${count} replies`}
      className={cn("relative underline-offset-2 transition-opacity duration-150 hover:underline active:opacity-60 focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff] motion-reduce:transition-none", className)}
      style={{
        fontFamily: fontStack, fontSize: m.statusFontSize, lineHeight: `${m.statusLineHeight}px`, fontWeight: 600,
        letterSpacing: m.statusLetterSpacing, marginTop: m.statusGap, color: "var(--im-secondary)", ...style,
      }} {...props}>
      {/* Inside the button, so a press on it is a press on the control; absolute, so it adds no ink. */}
      <span aria-hidden="true" data-slot="hit-area" className="absolute" style={{ left: -hit.x, right: -hit.x, top: -hit.top, bottom: -hit.bottom }} />
      {count === 1 ? "1 reply" : `${count} replies`}
    </button>
  );
}

/**
 * The thread's motion. UNMEASURED, see the note at the top of this file: plausible durations in the
 * family of the measured ones, not readings off a frame.
 */
export const replyThreadMotion = {
  /** The whole surface arriving, and leaving. The measured effects screen uses 260 and 200. */
  enter: 260,
  exit: 200,
  /** The dim and the backdrop's blur ramp together, over the measured long-press dim. */
  dim: 150,
  /** iOS: the panel grows into place from this scale, this far below it. macOS slides its pane in. */
  panelScale: 0.94,
  panelRise: 10,
  /** The thread's root message grows a little further than the panel around it. */
  rootScale: 0.92,
  /** The iOS sheet curve the rest of the kit uses, and a plain accelerate for the way out. */
  ease: "cubic-bezier(0.32, 0.72, 0, 1)",
  exitEase: "cubic-bezier(0.4, 0, 1, 1)",
} as const;

/**
 * The thread's chrome, per platform. UNMEASURED apart from the iOS close control, which sits in the
 * nav bar's measured Ø44 box centred (38, 84), and the insets and gaps inside the thread, which are
 * the platform's measured bubble metrics.
 *
 * iOS presents the thread full screen over the blurred conversation, so `paneWidth` is 0 and the
 * panel fills the frame. macOS presents it as a pane on the trailing edge with the conversation still
 * legible beside it, so it takes a width, paints its own background, and does not blur what is behind.
 */
export const replyThreadMetrics: Record<Platform, {
  topInset: number; headerHeight: number; titleSize: number; closeSize: number; closeInset: number; blur: number; paneWidth: number;
}> = {
  ios: { topInset: 62, headerHeight: 44, titleSize: 17, closeSize: 44, closeInset: 16, blur: 9, paneWidth: 0 },
  macos: { topInset: 0, headerHeight: 38, titleSize: 13, closeSize: 22, closeInset: 12, blur: 0, paneWidth: 420 },
};

/** The close control's glyph: the nav bar's back chevron on iOS, a cross on the macOS pane. */
function ThreadCloseGlyph({ platform }: { platform: Platform }) {
  if (platform === "ios") {
    // The measured back chevron, in its measured 44 pt box (`ios-details.tsx` draws the same path).
    return (
      <svg aria-hidden="true" width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M24.8 13.87 16.2 22.17 24.8 30.47" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M1 1 10 10M10 1 1 10" />
    </svg>
  );
}

/**
 * The focused thread: the rest of the conversation dims and blurs behind it and only the thread stays
 * lit. Render inside the device frame with `inset-0`.
 *
 * Pass the conversation as `backdrop` and it is blurred with a real `filter`, the way `ios-details`
 * does it. `backdrop-filter` samples whatever the host happens to have painted behind the overlay and
 * Chromium picks its own radius on a composited layer, so the same markup screenshots differently in
 * different hosts; with a `backdrop` the blur is ours and the frame is reproducible. Without one it
 * falls back to `backdrop-filter`, which is fine live and unreliable in a capture.
 *
 * The dim is the measured long-press value, shared with `message-actions` through `--im-dim`.
 *
 * Motion: the dim and the blur come up over `dim` ms while the panel grows into place (iOS) or slides
 * in from the trailing edge (macOS) over `enter`, the root message growing a little further than the
 * panel around it. `open={false}` reverses that over `exit` and calls `onExited` at the end, so the
 * parent can keep the thread mounted until the dismissal has actually been seen:
 *
 *     const openId = thread?.rootId ?? null;
 *     const [seen, setSeen] = useState(openId);
 *     const [closing, setClosing] = useState<string | null>(null);
 *     if (seen !== openId) { setSeen(openId); setClosing(openId ? null : seen); }   // during render
 *     {(openId ?? closing) && <ReplyThread open={openId !== null} onExited={() => setClosing(null)} …>}
 *
 * That `if` has to run during render, not in an effect: an effect would leave one committed frame
 * with the thread already unmounted and the dismissal would never run. `ios-messages-app.tsx` does
 * the same for the long-press overlay and the effects screen.
 *
 * The entrance is built with the Web Animations API, so `progress` (0..1) pauses and seeks it instead
 * of playing it, and `document.getAnimations()` can reach every part of it.
 */
export function ReplyThread({
  title = "Replies", root: rootMessage, onClose, closeLabel, backdrop, blur, open = true, onExited, progress,
  platform: platformProp, children, className, style, ...props
}: Omit<ComponentProps<"div">, "title"> & {
  title?: string;
  /** The message the thread hangs off. Drawn above the replies, and it grows ahead of them. */
  root?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  backdrop?: ReactNode;
  blur?: number;
  /** Flip to false to play the dismissal; `onExited` fires when it is over. */
  open?: boolean;
  onExited?: () => void;
  /** Seek the entrance to this fraction (0..1) instead of playing it, which is what the harness does. */
  progress?: number;
  platform?: Platform;
}) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const m = bubbleMetrics[platform];
  const t = replyThreadMetrics[platform];
  const ios = platform === "ios";
  const blurPx = blur ?? t.blur;
  const panelFrom = ios ? `translateY(${replyThreadMotion.panelRise}px) scale(${replyThreadMotion.panelScale})` : "translateX(100%)";
  const surface = useRef<HTMLDivElement>(null);
  const scrub = useRef<((time: number | null) => void) | null>(null);
  const titleId = useId();

  // Derived DURING RENDER, not in an effect. Two things depend on it: the dismissal has to start on
  // the frame `open` goes false (an effect leaves one committed frame with nothing left to animate),
  // and `onExited` must not fire for a thread that mounted closed and never opened.
  const [seenOpen, setSeenOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  if (seenOpen !== open) {
    setSeenOpen(open);
    setClosing(!open);
  }

  // The thread is modal, so it takes focus on open (a scrubbed entrance does not: the harness seeks
  // frames and must not move the caret) and Escape closes it from anywhere, not only while focus
  // happens to sit inside. The surface paints no focus ring: it is a holder, not a control.
  useEffect(() => {
    if (!open || closing || progress !== undefined) return;
    surface.current?.focus({ preventScroll: true });
  }, [open, closing, progress]);
  useEffect(() => {
    if (!onClose || closing) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, closing]);

  // The control that opened the thread gets focus back when the thread gives it up, so a keyboard
  // lands back on the reply count it came from rather than at the top of the document.
  const restoreTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!(active instanceof Node && surface.current?.contains(active))) restoreTo.current = active as HTMLElement | null;
  }, []);
  // Called when the dismissal finishes rather than only from an unmount cleanup: React runs a passive
  // cleanup after the node is already detached, by which time focus has fallen to the body and the
  // "was it still inside?" test can no longer be answered. The unmount keeps it as a backstop for a
  // parent that drops the thread without playing the dismissal.
  const restoreFocus = useCallback(() => {
    const previous = restoreTo.current;
    if (!previous?.isConnected) return;
    const el = surface.current;
    const active = document.activeElement;
    const gone = !active || active === document.body;
    if (!gone && !(el && active instanceof Node && el.contains(active))) return;
    restoreTo.current = null;
    previous.focus({ preventScroll: true });
  }, []);
  useEffect(() => restoreFocus, [restoreFocus]);

  /** Tab stays inside while the thread is up, the way a modal sheet does. */
  function onSurfaceKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const el = surface.current;
    if (!el) return;
    const stops = Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')).filter(node => node.getClientRects().length > 0);
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    const active = document.activeElement;
    const inside = active instanceof Node && el.contains(active);
    if (event.shiftKey ? active === first || !inside : active === last || !inside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  // The entrance, built with the Web Animations API so it can be played or seeked. Every layer's
  // resting style already is the end of its keyframes, so settling the timeline is just cancelling
  // it, which also releases the composited layer a held animation would otherwise pin (a held layer
  // cuts `backdrop-filter` off from what it samples; `message-actions.tsx` documents the same trap).
  // Settling empties the list, so a seek back below the end rebuilds it rather than losing it.
  useLayoutEffect(() => {
    const el = surface.current;
    if (!el) return;
    const T = replyThreadMotion;
    const one = (slot: string) => el.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
    let list: Animation[] = [];
    const build = () => {
      const made: Animation[] = [];
      const add = (target: Element | null, keyframes: Keyframe[], options: KeyframeAnimationOptions) => { if (target) made.push(target.animate(keyframes, { fill: "both", ...options })); };
      add(one("dim"), [{ opacity: 0 }, { opacity: 1 }], { duration: T.dim, easing: "ease-out" });
      add(one("backdrop-blur"), [{ opacity: 0 }, { opacity: 1 }], { duration: T.dim, easing: "ease-out" });
      add(one("backdrop-content"), [{ filter: "blur(0px)" }, { filter: `blur(${blurPx}px)` }], { duration: T.dim, easing: "ease-out" });
      add(one("thread-panel"), ios
        ? [{ opacity: 0, transform: panelFrom }, { opacity: 1, transform: "none" }]
        : [{ transform: panelFrom }, { transform: "none" }], { duration: T.enter, easing: T.ease });
      add(one("thread-root"), [{ transform: `scale(${T.rootScale})` }, { transform: "none" }], { duration: T.enter, easing: T.ease });
      return made;
    };
    const drop = (a: Animation) => { try { a.cancel(); } catch { /* already gone */ } };
    const settle = () => { for (const a of list) drop(a); list = []; };
    scrub.current = time => {
      if (time !== null && time >= T.enter) { settle(); return; }
      if (!list.length) list = build();
      if (time === null) {
        // Each leg is released as it ends, not when the first one does: the dim is over at 150 ms and
        // the panel at 260, and settling them together would cut the panel's last 110 ms. Its `finished`
        // is captured before the cancel, which replaces the promise with a fresh pending one.
        const playing = list;
        const ends = playing.map(a => { a.play(); return a.finished; });
        ends.forEach((end, i) => end.then(() => drop(playing[i])).catch(() => {}));
        Promise.allSettled(ends).then(() => { if (list === playing) list = []; });
        return;
      }
      for (const a of list) { a.pause(); a.currentTime = time; }
    };
    return () => { settle(); scrub.current = null; };
  }, [blurPx, ios, panelFrom]);

  useEffect(() => {
    if (!open || closing) return;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (progress !== undefined) scrub.current?.(Math.min(1, Math.max(0, progress)) * replyThreadMotion.enter);
    else if (reduced) scrub.current?.(replyThreadMotion.enter);
    else scrub.current?.(null);
  }, [open, closing, progress]);

  // The dismissal: the entrance is settled first, so this runs from the settled, open frame.
  const exited = useRef(onExited);
  useEffect(() => { exited.current = onExited; }, [onExited]);
  useEffect(() => {
    if (!closing) return;
    const el = surface.current;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scrub.current?.(replyThreadMotion.enter);
    let done = false;
    const finish = () => { if (done) return; done = true; restoreFocus(); exited.current?.(); };
    if (!el || reduced) { finish(); return; }
    const one = (slot: string) => el.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
    const timing: KeyframeAnimationOptions = { duration: replyThreadMotion.exit, easing: replyThreadMotion.exitEase, fill: "both" };
    const running: Animation[] = [];
    const add = (target: Element | null, keyframes: Keyframe[]) => { if (target) running.push(target.animate(keyframes, timing)); };
    add(one("dim"), [{ opacity: 1 }, { opacity: 0 }]);
    add(one("backdrop-blur"), [{ opacity: 1 }, { opacity: 0 }]);
    add(one("backdrop-content"), [{ filter: `blur(${blurPx}px)` }, { filter: "blur(0px)" }]);
    add(one("thread-panel"), ios
      ? [{ opacity: 1, transform: "none" }, { opacity: 0, transform: panelFrom }]
      : [{ transform: "none" }, { transform: panelFrom }]);
    add(one("thread-root"), [{ transform: "none" }, { transform: `scale(${replyThreadMotion.rootScale})` }]);
    if (!running.length) { finish(); return; }
    Promise.allSettled(running.map(a => a.finished)).then(finish);
    return () => running.forEach(a => { try { a.cancel(); } catch { /* already gone */ } });
  }, [closing, blurPx, ios, panelFrom, restoreFocus]);

  const dismiss = closing ? undefined : onClose;
  const panelStyle: CSSProperties = ios
    ? { inset: 0, transformOrigin: "50% 100%" }
    : {
      top: 0, bottom: 0, right: 0, width: `min(100%, ${t.paneWidth}px)`, background: "var(--im-bg)",
      borderInlineStart: "1px solid var(--im-separator)", boxShadow: "-8px 0 26px rgba(0,0,0,0.12)",
    };

  return (
    <div ref={surface} data-slot="reply-thread" data-platform={platform} data-state={closing ? "closing" : "open"}
      role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onSurfaceKeyDown}
      className={cn("absolute inset-0 z-30 outline-none", className)}
      style={{ fontFamily: fontStack, ...style }} {...props}>
      {backdrop !== undefined ? (
        <div aria-hidden="true" data-slot="backdrop" className="absolute inset-0 -z-10 overflow-hidden">
          {/* Blurring a box larger than the screen keeps the filter's own edge falloff off-screen. */}
          <div data-slot="backdrop-content" className="absolute" style={{ inset: -60, background: "var(--im-bg)", filter: `blur(${blurPx}px)` }}>
            <div className="absolute" style={{ inset: 60 }}>{backdrop}</div>
          </div>
        </div>
      ) : blurPx > 0 ? (
        // The fallback blur is its own layer rather than a filter on the surface: the entrance fades
        // it in, and fading the surface itself would take the thread with it.
        <div aria-hidden="true" data-slot="backdrop-blur" className="absolute inset-0 -z-10"
          style={{ backdropFilter: `blur(${blurPx}px)`, WebkitBackdropFilter: `blur(${blurPx}px)` }} />
      ) : null}
      {/* The dim, then a scrim over it: Escape does the same job for the keyboard, so the scrim stays
          out of the a11y tree. The scrim goes inert while the thread is leaving, so a second click
          cannot ask for a dismissal that is already running. */}
      <div aria-hidden="true" data-slot="dim" className="absolute inset-0" style={{ background: "var(--im-dim, rgba(22,18,44,0.21))" }} />
      <div aria-hidden="true" data-slot="scrim" onClick={dismiss} className="absolute inset-0 cursor-default" />
      {/* iOS fills the frame, so the panel lets clicks through to the scrim and only its own content
          takes them back. The macOS pane is opaque and takes everything inside its own width. */}
      <div data-slot="thread-panel" className={cn("absolute flex flex-col", ios && "pointer-events-none")} style={panelStyle}>
        <div data-slot="thread-header" className="pointer-events-auto relative flex shrink-0 items-center"
          style={{ height: t.headerHeight, marginTop: t.topInset, paddingInline: m.edgeInset, justifyContent: ios ? "center" : "space-between" }}>
          <span id={titleId} data-slot="thread-title" style={{ fontSize: t.titleSize, lineHeight: 1, fontWeight: 600, color: "var(--im-incoming-text)" }}>{title}</span>
          {onClose && (
            <button type="button" data-slot="thread-close" onClick={dismiss} aria-label={closeLabel ?? (ios ? "Back to the conversation" : "Close replies")}
              className="flex items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]"
              style={ios
                ? { position: "absolute", left: t.closeInset, top: (t.headerHeight - t.closeSize) / 2, width: t.closeSize, height: t.closeSize, color: "var(--im-incoming-text)" }
                : { width: t.closeSize, height: t.closeSize, color: "var(--im-secondary)" }}>
              <ThreadCloseGlyph platform={platform} />
            </button>
          )}
        </div>
        <div data-slot="thread-messages" className="pointer-events-auto relative mt-auto flex flex-col" style={{ gap: m.gapBetweenGroups, padding: m.edgeInset }}>
          {rootMessage !== undefined && (
            <div data-slot="thread-root" className="flex w-full flex-col" style={{ transformOrigin: "50% 100%" }}>{rootMessage}</div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

/** Shape an app can store alongside a message to describe its thread. */
export type ThreadInfo = { rootId: string; replyCount: number };

export type ReplyStyle = CSSProperties;
