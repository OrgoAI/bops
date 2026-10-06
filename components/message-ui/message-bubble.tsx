"use client";

import { useLayoutEffect, useRef, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { usePlatform, type Platform } from "@/components/message-ui/platform";
import { bodyClipPath, tailBox, tailPath, tailSeamOverlap } from "@/components/message-ui/bubble-shape";
import { bubbleMetrics, emojiFontStack, fontStack, type Direction, type Service } from "@/components/message-ui/tokens";

export type MessageBubbleProps = Omit<ComponentProps<"div">, "children"> & {
  direction?: Direction;
  service?: Service;
  /** Draw the tail. Both platforms only tail the last bubble of a cluster; the list decides. */
  tail?: boolean;
  /** Group-chat sender name shown above an incoming bubble. */
  sender?: string;
  /** "Delivered", "Read 9:41 AM", "Sent as Text Message"… */
  status?: ReactNode;
  edited?: boolean;
  /** Tapback balloons; positioned on the bubble's top corner away from the screen edge. */
  reactions?: ReactNode;
  /** Render a big glyph with no bubble (auto-detected for 1–3 emoji when omitted). */
  emojiOnly?: boolean;
  /**
   * Clicked once, so the balloon carries its selection overlay. macOS only; the message list drives
   * this from `selectedIds` and the macOS pane owns the click. See `selectionOverlayClass`.
   */
  selected?: boolean;
  /**
   * Screen-space y of the bubble body's bottom edge, in px, for the native position-dependent fill.
   * The message list keeps this updated while scrolling; leave it unset for a mid-screen color.
   */
  screenBottom?: number;
  /** Widest the bubble may grow. Defaults to the native rule: 280.5px on iOS, 60.7% of the pane on macOS. */
  maxWidth?: number | string;
  platform?: Platform;
  children?: ReactNode;
};

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*\s?){1,3}$/u;

export function isEmojiOnly(text: ReactNode): boolean {
  return typeof text === "string" && EMOJI_ONLY.test(text.trim());
}

/**
 * Where a reaction balloon hangs off a message's own box, per platform. It lives here because every
 * message kind needs it, not only a text bubble: a photo, a link card, an audio row and a bare emoji
 * all take reactions too, and each draws its own container. `message-list.tsx` reads this table for
 * every one of those kinds, so it is what actually places a Tapback on a **photo**.
 *
 * These are the measured captures, and they are the same three numbers `tapback.tsx` exports as
 * `balloonSlot` and `message-image.tsx` keeps as `reactionSlot`. `tests/unit/tapback-slot.test.ts`
 * asserts all three agree, because they did not:
 *
 * | | was here | measured | out by |
 * |---|---|---|---|
 * | iOS marginTop | 28 | 28 | — |
 * | iOS top | −27.25 | **−27.39** | 0.14 |
 * | iOS side | −14.1 | **−13.85** | 0.25 |
 * | macOS marginTop | 19.6 | **27.4** | 7.80 |
 * | macOS top | −19.1 | **−22.05** | 2.95 |
 * | macOS side | −9.9 | **−11.79** | 1.89 |
 *
 * iOS averages the outgoing capture (`conv3-light.png` → `tapback-love-light.png`, −27.47 / −14.02)
 * and the mirrored incoming one (`incoming-light.png`, −27.31 / +13.68); the same pair gives the slot
 * the list opens above the bubble, whose cluster gap grows 10.313 → 38.313, i.e. exactly 28.
 * macOS is `tapback-love-dark-2x.png`, cross-checked light: body bottom 34.93 → next body top 65.51
 * is a 30.58 gap where the cluster gap below it is 3.18, so the slot opens 27.40; the Ø28 circle's
 * top (86.92 px) sits 22.05 above the body top (131.01 px) and its leading edge (245.46 px) 11.79
 * outside the body's leading edge (269.03 px).
 *
 * The macOS row is the one that mattered: at 19.6 / −19.1 / −9.9 a Tapback on a macOS photo sat 7.8 pt
 * short in its slot, 2.95 pt too low against the photo and 1.89 pt too far in over it — visible, and
 * wrong for every non-text message kind, not just photos. `tapback.tsx` had flagged it in a comment
 * since the macOS balloon was measured; this is that correction landing in the table that draws.
 */
export const reactionOffsets: Record<Platform, { marginTop: number; top: number; side: number }> = {
  ios: { marginTop: 28, top: -27.39, side: -13.85 },
  macos: { marginTop: 27.4, top: -22.05, side: -11.79 },
};

function fillVars(direction: Direction, service: Service): CSSProperties {
  const key = direction === "incoming" ? "gray" : service === "sms" ? "green" : "blue";
  return { "--im-fill-top": `var(--im-${key}-top)`, "--im-fill-bottom": `var(--im-${key}-bottom)`, "--im-sel": `var(--im-sel-${key})`, "--im-seltext": `var(--im-seltext-${key})` } as CSSProperties;
}

/**
 * The overlay a selected balloon carries, read out of macOS Messages itself rather than a screenshot:
 * `-[CKTextBalloonView setSelected:withSelectionState:]` turns on a highlight overlay layer whose
 * colour is `-[CKBalloonView highlightOverlayColor]`, which for a coloured balloon is
 * `-[CKUIThemeMac balloonOverlayColorForColorType:]`. Blue and gray are opaque there, so a selected
 * bubble drops its screen-space gradient for a flat fill; green is a wash left over it. Both themes
 * share the green. Values from ChatKit 26.5 (macOS 26.5).
 */
export const selectionOverlayClass =
  "[--im-sel-blue:#1b60d8] [--im-sel-gray:#c6c6c7] [--im-sel-green:#0a0a7833] " +
  "dark:[--im-sel-blue:#0b50c8] dark:[--im-sel-gray:#55555c]";

/**
 * Dragging across the words inside a balloon, which is a Mac-only gesture: `-[CKUIBehaviorPhone
 * enableBalloonTextSelection]` is NO and `-[CKUIBehaviorMac enableBalloonTextSelection]` is YES, so
 * on iOS the text is not selectable at all and "Select" in the long-press menu means the whole
 * message (`ios-select-mode`), not a range inside it. That is why `user-select` is `none` on iOS
 * here rather than an oversight, and it is also why iOS has no colour below.
 *
 * The Mac's colours come from `-[CKUITheme selectionHighlightColorOverrideForColorType:]`, read
 * beside `balloonColorsForColorType:` and `balloonTextColorForColorType:` so each type's fill, text
 * and highlight line up. Across all twelve types the rule is the text colour, not the fill: every
 * type whose text is white takes white at 0.65 (type 0 green #53e678->#34c759, type 1 blue
 * #5ac8fa->#0088ff, type 5 #303032, type 6, type 7), and every type with dark text takes
 * `blueSelectionHighlightColor`, #00a1ff at 0.35 (type 4 white/black text, type 8, and type 9, the
 * incoming balloon: fill #000000 at 0.20 over the pane, text #000000 at 0.44). Neither value moves
 * with the appearance - the probe returns the same pair resolved light and dark - so there is no
 * `dark:` half to this.
 *
 * This is a background behind the glyphs, not a filter over them - `-[CKBalloonTextView
 * _setFakeSelectionBackgroundColorForRange:]` sets a background colour attribute on the range - so
 * the text keeps its own colour and white-on-blue selected text really does land on #aad4fe.
 */
export const balloonTextSelectionClass =
  "[--im-seltext-blue:#ffffffa6] [--im-seltext-green:#ffffffa6] [--im-seltext-gray:#00a1ff59]";

/**
 * Native bubbles hug their longest wrapped line instead of stretching to the maximum width, and
 * center text that is narrower than the minimum bubble width. CSS shrink-to-fit cannot express either,
 * so measure the laid-out line boxes and set the frame width explicitly.
 */
function useNativeTextFit(enabled: boolean, paddingX: number, minWidth: number, deps: unknown[]) {
  // The ref is created here rather than passed in, so the DOM writes below are on a value this hook
  // owns.
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frameEl = frame.current;
    const textEl = frameEl?.querySelector<HTMLElement>('[data-slot="text"]');
    if (!enabled || !frameEl || !textEl) return;
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
      if (!lines.length) return;
      const layoutWidth = parseFloat(getComputedStyle(frameEl).width);
      const scaleX = frameEl.getBoundingClientRect().width / layoutWidth || 1;
      const longest = Math.max(...lines.map(l => l.right - l.left)) / scaleX;
      const bubble = textEl.parentElement as HTMLElement;
      bubble.style.textAlign = lines.length === 1 && longest < minWidth - 2 * paddingX ? "center" : "";
      const hug = Math.ceil((longest + 2 * paddingX) * 100) / 100 + 0.05;
      if (lines.length > 1 && hug < layoutWidth - 0.1) frameEl.style.width = `${hug}px`;
    };
    measure();
    const observer = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); });
    if (container) observer.observe(container);
    document.fonts?.ready.then(() => measure()).catch(() => {});
    return () => { observer.disconnect(); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, paddingX, minWidth, ...deps]);
  return frame;
}

export function MessageBubble({
  direction = "incoming", service = "imessage", tail = false, sender, status, edited = false, reactions, emojiOnly, selected = false,
  screenBottom, maxWidth, platform: platformProp, className, style, children, ...props
}: MessageBubbleProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const m = bubbleMetrics[platform];
  const outgoing = direction === "outgoing";
  const side = outgoing ? "right" : "left";
  const big = emojiOnly ?? isEmojiOnly(children);
  const tailW = tailBox.width * m.tailScale;
  const tailH = tailBox.height * m.tailScale;
  const hang = tailBox.hang * m.tailScale;
  // macOS's tail box is 15.4 × 14.84, so its left edge lands on a fraction (594.609 in the 630pt
  // pane) and Chrome paints the tail's clip up to half a point off the body's clip edge, leaving a
  // white hairline down the bubble (one 75%-white device pixel at 2x, measured at x 594.5 on the
  // four-line bubble). Overlapping the body into the box closes it. iOS's box is 22 × 21.2 on whole
  // pixels and shows no seam, so it keeps a flush join. See bodyClipPath.
  const tailOverlap = tailSeamOverlap[platform];
  const frame = useNativeTextFit(!big, m.paddingX, m.minWidth, [children, platform, maxWidth]);

  // The fill is one gradient in screen coordinates. Anchor it to the bubble's bottom so the body and
  // the tail (which hangs `hang` px lower) share the same image without knowing the body height.
  // `--bubble-bottom` may also be set on the element directly (see use-screen-space.ts) so scrolling
  // never needs a React render.
  const bottomVar = screenBottom === undefined ? "var(--bubble-bottom, calc(var(--im-screen-h) * 0.55))" : `${screenBottom}px`;
  // The selection overlay is one more background layer over the fill, so the body's clip and the
  // tail's clip carry it for free and no extra element is needed.
  const fill: CSSProperties = {
    backgroundImage: `${selected ? "linear-gradient(var(--im-sel), var(--im-sel))," : ""}linear-gradient(var(--im-fill-top), var(--im-fill-bottom))`,
    backgroundSize: selected ? "100% 100%, 100% var(--im-screen-h)" : "100% var(--im-screen-h)",
    backgroundRepeat: "no-repeat",
    backgroundColor: "var(--im-fill-bottom)",
  };
  // background-position-y = 100% + K puts the image's bottom K below the element's bottom.
  const at = (position: string) => (selected ? `0 0, ${position}` : position);
  const bodyFill: CSSProperties = { ...fill, backgroundPosition: at(`0 calc(100% + (var(--im-screen-h) - ${bottomVar}))`) };
  const tailFill: CSSProperties = { ...fill, backgroundPosition: at(`0 calc(100% + (var(--im-screen-h) - ${bottomVar} - ${hang}px))`) };
  const vars = { ...(screenBottom === undefined ? {} : { "--bubble-bottom": `${screenBottom}px` }), ...fillVars(direction, service) } as CSSProperties;
  const reactionOffset = reactionOffsets[platform];

  return (
    <div data-slot="message-bubble" data-direction={direction} data-service={service} data-platform={platform} data-selected={selected ? "true" : undefined}
      className={cn("flex min-w-0 flex-col", selectionOverlayClass, balloonTextSelectionClass, "selection:bg-[var(--im-seltext)]", outgoing ? "items-end" : "items-start", className)}
      style={{ fontFamily: fontStack, ...vars, ...style }} {...props}>
      {/* `-[CKUIBehavior senderTranscriptInsets]` is {0, 14, 0, 0} on iPhone and {0, 12, 0, 0} at
          idiom 5: a leading inset only, with nothing on the top, bottom or trailing edge. This used
          to spend the same 14 on both sides and on both platforms. The type is still unmeasured. */}
      {sender && <span data-slot="sender" className="mb-[2px] text-[12px] leading-[14px]"
        style={{ color: "var(--im-secondary)", paddingInlineStart: platform === "ios" ? 14 : 12 }}>{sender}</span>}
      <div ref={frame} data-slot="bubble-frame" className="relative max-w-full" style={{ maxWidth: maxWidth ?? (platform === "ios" ? m.maxWidth : `${m.maxWidthRatio * 100}%`), marginTop: reactions ? reactionOffset.marginTop : undefined }}>
        {big ? (
          <div data-slot="emoji" style={{ fontSize: m.emojiOnlySize, lineHeight: `${m.emojiOnlyLineHeight}px`, fontFamily: emojiFontStack, padding: `0 ${m.emojiOnlyInset}px`, userSelect: platform === "ios" ? "none" : "text" }}>
            <span className="sr-only">{outgoing ? "You: " : `${sender ?? "Contact"}: `}</span>{children}
          </div>
        ) : (
          <div data-slot="bubble" className="relative whitespace-pre-wrap [overflow-wrap:anywhere]" style={{
            fontSize: m.fontSize, lineHeight: `${m.lineHeight}px`, letterSpacing: m.letterSpacing,
            padding: `${m.paddingY}px ${m.paddingX}px`, minWidth: m.minWidth, textAlign: "start",
            color: outgoing ? "var(--im-outgoing-text)" : "var(--im-incoming-text)",
            userSelect: platform === "ios" ? "none" : "text",
          }}>
            {/* The fill lives behind the text so clipping the tail corner never clips glyphs.
                Chrome rounds a painted background box to whole CSS px, so the widest macOS bubble,
                whose layout box is 227.71875 to 610, paints 228.00 to 610.00: 0.29 narrower and
                0.24 to the right of native's 227.477 to 609.763. No token can move that. A layout
                left edge of 227.5 rounds to the same 228, and `will-change` does not opt out;
                only a fractional `transform` escapes the rounding, and the send and receive
                animations already own this element's transform, so it stays as it is. */}
            {/* The tail-less case still carries a clip-path, and that is not cosmetic: Chrome snaps a
                plain rounded-rect background to whole CSS pixels, so a body laid out at 100.333 paints
                at 100.0, while native's bodies sit on thirds. A clip-path opts the fill out of that
                snapping and it paints where the layout put it. Verified at 3x: 100.333 painted at
                100.0 without one and at exactly device row 301 with one. */}
            <div aria-hidden="true" data-slot="fill" className="pointer-events-none absolute inset-0" style={{ borderRadius: m.radius, clipPath: tail ? bodyClipPath(side, m.tailScale, tailOverlap) : `inset(0 round ${m.radius}px)`, ...bodyFill }} />
            {tail && <div aria-hidden="true" data-slot="tail" className="pointer-events-none absolute" style={{
              [side]: 0, bottom: -hang, width: tailW, height: tailH + hang, clipPath: `path("${tailPath(side, m.tailScale)}")`, ...tailFill,
            }} />}
            <span className="sr-only">{outgoing ? "You: " : `${sender ?? "Contact"}: `}</span>
            <span data-slot="text" className="relative">{children}</span>
          </div>
        )}
        {reactions && <div data-slot="reactions" className="absolute z-10" style={{ top: reactionOffset.top, [outgoing ? "left" : "right"]: reactionOffset.side }}>{reactions}</div>}
      </div>
      {edited && <span data-slot="edited" className="mt-[3px] px-[14px] text-[11px] font-medium leading-[13px]" style={{ color: "var(--im-edited)" }}>Edited</span>}
      {status && <div data-slot="status" style={{ fontSize: m.statusFontSize, lineHeight: `${m.statusLineHeight}px`, fontWeight: 600, letterSpacing: m.statusLetterSpacing, marginTop: m.statusGap, paddingInlineEnd: outgoing ? m.statusInset : 0, paddingInlineStart: outgoing ? 0 : m.statusInset, color: "var(--im-secondary)" }}>{status}</div>}
    </div>
  );
}
