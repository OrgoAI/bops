"use client";

import { useEffect, useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { fontStack } from "@/components/message-ui/tokens";
import { InvisibleInk, bubbleEffects, screenEffects, type BubbleEffectKind, type ScreenEffectKind } from "@/components/message-ui/message-effects";

/**
 * "Send with effect", the screen iOS shows when you press and hold the send button.
 *
 * Measured from `references/ios/captures/effects-picker-light.png` (nothing chosen),
 * `effects-slam-light.png` (a bubble effect chosen) and `effects-screen-light.png` (the Screen tab),
 * all iOS 26 on a 402x874 pt screen captured at 3x.
 *
 * The layout is not a list. The conversation freezes and blurs behind; the message being sent is
 * previewed as a real bubble; the four bubble effects live in a white vertical rail on the trailing
 * edge, each row a right-aligned label plus a dot. Choosing one turns that row's dot into the send
 * button, moves the preview up alongside it, replaces that row's label with "SEND WITH <NAME>" above
 * the bubble, and dims the labels of the rows that were not chosen. The Screen tab drops the rail
 * entirely and stacks the send button above the close button.
 */
export const effectsPickerMetrics = {
  /** Everything below is in points on the 402x874 screen the numbers were measured from. */
  frame: { width: 402, height: 874 },
  title: { capTop: 96, baseline: 112, fontSize: 22, centerX: 201 },
  segment: { left: 81, top: 132, width: 240, height: 32, radius: 16, inset: 2, fontSize: 13, labelCapTop: 143, selectedWeight: 600, weight: 400 },
  rail: { left: 321.75, top: 572, width: 53.75, height: 214.67, radius: 23, rowPitch: 57, firstRowCenter: 593.67 },
  dot: { size: 9, centerX: 348.5 },
  /** The chosen row's dot becomes a send button the same size as the close button. */
  send: { width: 38, height: 28, centerX: 348.5, screenCenterY: 765.83 },
  close: { width: 38, height: 28, centerX: 348.5, centerY: 825.83 },
  /** Row labels and the caption share one type style and one right ink edge. */
  label: { rightInk: 298.33, bearing: 1.2, fontSize: 11.33, weight: 400, capHeight: 8.33, tracking: 0, dimOpacity: 0.44 },
  /**
   * The caption sits above the preview. The Screen tab really does set it a third of a point smaller
   * and 3.33 pt further left: three different Screen captions measure a right ink edge of 294.67 and
   * an 11 pt body, against 298.33 and 11.33 for every Bubble one.
   */
  caption: { rightInk: 298.33, gapAboveBubble: 8.67, screenRightInk: 294.67, screenFontSize: 11, screenGapAboveBubble: 7 },
  /**
   * The preview bubble. It rests low on the screen until an effect is chosen, then rises to the
   * chosen row and slides 14.33 pt toward the rail. Both right edges are measured, not derived.
   */
  preview: {
    restingTop: 792,
    restingRight: 301.33,
    chosenRight: 315.67,
    chosenTopFromRowCenter: -17.33,
    screenTop: 731,
    screenRight: 301.33,
    maxWidth: 280.5,
    /**
     * The preview never drops below this. Fitted from the Invisible Ink capture, where the fourth
     * row would otherwise put the bubble's bottom at 834.34 and it sits at 827.33 instead.
     */
    maxBottom: 827.33,
  },
  /**
   * The preview bubble is a flat #0088ff, not the conversation's screen-space gradient: the same
   * bubble measures (0, 136, 255) at y 578 and again at y 871 across the four captures.
   */
  previewFill: "#0088ff",
  /**
   * The Screen tab pages through its effects and shows a dot per effect under the preview. There are
   * eight dots in iOS 26, and the eighth is the last: swiping past Celebration goes nowhere.
   */
  pageDots: { size: 7.67, pitch: 17.62, firstCenterX: 139.17, centerY: 807 },
  /** Time the whole screen takes to appear and to leave. */
  timing: { enter: 260, exit: 200, move: 320 },
} as const;

/**
 * Where the cap top falls inside a `line-height: 1` box, as a fraction of the font size.
 * The captures record positions as cap tops, so every text offset here goes through this.
 * The ratio is calibrated by rendering, not taken from font tables: browsers snap a baseline to a
 * device pixel, so the best single ratio lands every label within one device pixel at 3x.
 */
function capTopInset(fontSize: number) {
  return fontSize * 0.1145;
}

/**
 * Apple's continuous corner, the same profile the composer and nav bar use. A circular corner is up
 * to 0.9 pt too tight along the flank of a rail this wide. Browsers without `corner-shape` fall back
 * to a plain round corner.
 */
const continuous = { cornerShape: "superellipse(1.14)" } as CSSProperties;

/**
 * Light values are measured off the three captures; the dark set follows the same iOS system colours
 * the rest of the kit uses. They are custom properties so a `.dark` ancestor flips the whole screen
 * without the caller passing anything.
 */
const vars =
  "[--ios-fx-backdrop:rgba(233,236,242,0.86)] [--ios-fx-title:rgba(60,60,67,0.66)] [--ios-fx-track:rgba(120,120,128,0.16)] [--ios-fx-pill:#ffffff] [--ios-fx-tab:#000000] [--ios-fx-rail:#ffffff] [--ios-fx-dot:#999999] [--ios-fx-label:rgba(60,60,67,0.75)] [--ios-fx-close:#808080] [--ios-fx-send:#0088ff] [--ios-fx-glyph:#ffffff] " +
  "dark:[--ios-fx-backdrop:rgba(10,10,12,0.9)] dark:[--ios-fx-title:rgba(255,255,255,0.8)] dark:[--ios-fx-track:rgba(120,120,128,0.24)] dark:[--ios-fx-pill:#636366] dark:[--ios-fx-tab:#ffffff] dark:[--ios-fx-rail:rgba(255,255,255,0.14)] dark:[--ios-fx-dot:rgba(255,255,255,0.24)] dark:[--ios-fx-label:rgba(255,255,255,0.8)]";

const c = {
  backdrop: "var(--ios-fx-backdrop)",
  title: "var(--ios-fx-title)",
  segmentTrack: "var(--ios-fx-track)",
  segmentPill: "var(--ios-fx-pill)",
  segmentLabel: "var(--ios-fx-tab)",
  rail: "var(--ios-fx-rail)",
  dot: "var(--ios-fx-dot)",
  label: "var(--ios-fx-label)",
  close: "var(--ios-fx-close)",
  send: "var(--ios-fx-send)",
  glyph: "var(--ios-fx-glyph)",
};

export type EffectsPickerSelection = { bubble: BubbleEffectKind } | { screen: ScreenEffectKind } | null;

export type IosEffectsPickerProps = Omit<ComponentProps<"div">, "onSelect" | "children"> & {
  tab?: "bubble" | "screen";
  onTabChange?: (tab: "bubble" | "screen") => void;
  selection?: EffectsPickerSelection;
  onSelect?: (selection: EffectsPickerSelection) => void;
  /** Fires when the chosen effect's send control is activated. */
  onSend?: (selection: EffectsPickerSelection) => void;
  onClose?: () => void;
  /** False plays the exit timeline and then calls `onExited`. */
  open?: boolean;
  onExited?: () => void;
  /** Seek the entrance to this fraction (0..1) instead of playing it, which is what the harness does. */
  progress?: number;
  /** The message being sent, rendered as the preview bubble. */
  preview: ReactNode;
};

function UpArrow() {
  // 13 x 15.67 pt of ink, 2 pt stroke, measured off the send button in effects-slam-light.png.
  return (
    <svg aria-hidden="true" width="13" height="15.67" viewBox="0 0 13 15.67" fill="none">
      <path d="M6.5 14.67V1M1.2 5.7 6.5 1l5.3 4.7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Cross() {
  // 13.67 pt square of ink, 2 pt stroke.
  return (
    <svg aria-hidden="true" width="13.67" height="13.67" viewBox="0 0 13.67 13.67" fill="none">
      <path d="M1 1l11.67 11.67M12.67 1 1 12.67" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** A label or caption placed by its cap top and its right ink edge, the way the captures measure it. */
function InkLabel({ rightInk, capTop, fontSize, dim, style, children, ...props }: ComponentProps<"span"> & { rightInk: number; capTop: number; fontSize: number; dim?: boolean }) {
  const m = effectsPickerMetrics;
  return (
    <span
      {...props}
      style={{
        position: "absolute",
        right: m.frame.width - rightInk - m.label.bearing,
        top: capTop - capTopInset(fontSize),
        fontSize,
        lineHeight: 1,
        fontWeight: m.label.weight,
        letterSpacing: m.label.tracking,
        whiteSpace: "nowrap",
        textAlign: "right",
        opacity: dim ? m.label.dimOpacity : 1,
        transition: "opacity 220ms ease",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function IosEffectsPicker({
  tab: tabProp,
  onTabChange,
  selection = null,
  onSelect,
  onSend,
  onClose,
  open = true,
  onExited,
  progress,
  preview,
  className,
  style,
  ...props
}: IosEffectsPickerProps) {
  const [internalTab, setInternalTab] = useState<"bubble" | "screen">("bubble");
  const tab = tabProp ?? internalTab;
  const setTab = (next: "bubble" | "screen") => {
    if (tabProp === undefined) setInternalTab(next);
    onTabChange?.(next);
  };
  const m = effectsPickerMetrics;
  const root = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const previewBox = useRef<HTMLDivElement>(null);
  const exited = useRef(false);

  useEffect(() => {
    exited.current = false;
  }, []);

  /**
   * The screen is modal, so it takes focus when it opens (a scrubbed entrance does not: the harness
   * seeks frames and must not move the caret) and gives Escape back wherever focus happens to be.
   * The root carries `outline-none`: it is a focus holder, not a control, and must paint nothing.
   *
   * The root, and not the rail's first effect, because iOS opens this screen on a press and hold of
   * the send button - the finger is still down at the moment the focus moves. A control focused
   * programmatically then matches `:focus-visible` in Chrome and WebKit alike, since the gesture has
   * not resolved and the modality is still the keyboard default, and a blue ring lands on a rail dot
   * in a screen the captures show ringless. `onRootKeyDown` below is what pays for holding it here:
   * the first arrow moves into the rail, where a ring is right. See `tapback-bar.tsx`.
   */
  useEffect(() => {
    if (!open || progress !== undefined) return;
    root.current?.focus({ preventScroll: true });
  }, [open, progress]);

  /**
   * Two jobs the root has to do because the root is where the focus starts.
   *
   * Tab: `aria-modal` promises the rest of the page is inert, so Tab has to stay inside. Measured
   * without this, the second Tab was already out of the screen and into the page behind it.
   *
   * The arrows: from the root itself the first one enters the rail at whatever is chosen (or its
   * first effect), and every arrow after that is the rail's own radio-group behaviour. On the Screen
   * tab there is no rail, so the arrows belong to the tab strip and this hands them to it.
   */
  function onRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const node = root.current;
    if (!node) return;
    if (event.key === "Tab") {
      const stops = Array.from(node.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
        .filter(element => element.offsetParent !== null);
      if (!stops.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === node)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.target !== node) return;
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const radios = Array.from(node.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const target = radios.length
      ? radios[event.key === "End" ? radios.length - 1 : event.key === "Home" ? 0 : Math.max(0, chosenIndex)]
      : node.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`);
    if (!target) return;
    event.preventDefault();
    target.focus();
  }
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    if (open) {
      const entrance = node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: m.timing.enter, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "both" });
      if (progress === undefined) return;
      // Seeked, not played: a scrubbed checkpoint has to land on the same frame every run.
      entrance.pause();
      entrance.currentTime = Math.max(0, Math.min(1, progress)) * m.timing.enter;
      return () => entrance.cancel();
    }
    const animation = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: m.timing.exit, easing: "ease-out", fill: "forwards" });
    const finish = () => {
      if (exited.current) return;
      exited.current = true;
      onExited?.();
    };
    animation.addEventListener("finish", finish);
    return () => animation.removeEventListener("finish", finish);
  }, [open, progress, m.timing.enter, m.timing.exit, onExited]);

  const chosenBubble = selection && "bubble" in selection ? selection.bubble : null;
  const chosenScreen = selection && "screen" in selection ? selection.screen : null;
  const chosenIndex = chosenBubble ? bubbleEffects.findIndex(effect => effect.kind === chosenBubble) : -1;
  const chosenTitle = chosenBubble
    ? bubbleEffects.find(effect => effect.kind === chosenBubble)?.title
    : chosenScreen
      ? screenEffects.find(effect => effect.kind === chosenScreen)?.title
      : null;
  const caption = chosenTitle ? `SEND WITH ${chosenTitle.toUpperCase()}` : null;

  const onScreenTab = tab === "screen";
  const [previewHeight, setPreviewHeight] = useState(0);
  const rowTop = chosenIndex >= 0 ? m.rail.firstRowCenter + chosenIndex * m.rail.rowPitch + m.preview.chosenTopFromRowCenter : 0;
  const previewTop = chosenIndex >= 0
    ? (previewHeight > 0 ? Math.min(rowTop, m.preview.maxBottom - previewHeight) : rowTop)
    : onScreenTab
      ? m.preview.screenTop
      : m.preview.restingTop;
  const previewRight = chosenIndex >= 0 ? m.preview.chosenRight : onScreenTab ? m.preview.screenRight : m.preview.restingRight;
  const captionGap = onScreenTab ? m.caption.screenGapAboveBubble : m.caption.gapAboveBubble;
  const captionFontSize = onScreenTab ? m.caption.screenFontSize : m.label.fontSize;
  const captionRightInk = onScreenTab ? m.caption.screenRightInk : m.caption.rightInk;

  // The bubble fill is a screen-space gradient, so the preview has to say where it sits on the
  // screen. The picker fills the frame, which makes that its own offset plus its measured height.
  useEffect(() => {
    const node = previewBox.current;
    if (!node) return;
    const sync = () => {
      setPreviewHeight(node.offsetHeight);
      node.style.setProperty("--bubble-bottom", `${previewTop + node.offsetHeight}px`);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, [previewTop, preview]);

  return (
    <div
      ref={root}
      data-slot="ios-effects-picker"
      role="dialog"
      aria-modal="true"
      aria-label="Send with effect"
      tabIndex={-1}
      onKeyDown={onRootKeyDown}
      className={cn("absolute inset-0 select-none outline-none", vars, className)}
      style={{
        fontFamily: fontStack,
        background: c.backdrop,
        backdropFilter: "blur(45px) saturate(1.6)",
        WebkitBackdropFilter: "blur(45px) saturate(1.6)",
        ...style,
      }}
      {...props}
    >
      <div
        data-slot="effects-title"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: m.title.capTop - capTopInset(m.title.fontSize),
          textAlign: "center",
          fontSize: m.title.fontSize,
          lineHeight: 1,
          color: c.title,
        }}
      >
        Send with effect
      </div>

      <div
        data-slot="effects-tabs"
        role="tablist"
        aria-label="Effect kind"
        onKeyDown={event => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          const next = event.key === "Home" ? "bubble" : event.key === "End" ? "screen" : event.key === "ArrowRight" ? "screen" : "bubble";
          if (next !== tab) setTab(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
        }}
        style={{
          position: "absolute",
          left: m.segment.left,
          top: m.segment.top,
          width: m.segment.width,
          height: m.segment.height,
          borderRadius: m.segment.radius,
          background: c.segmentTrack,
        }}
      >
        <span
          aria-hidden="true"
          data-slot="effects-tab-pill"
          style={{
            position: "absolute",
            top: m.segment.inset,
            left: onScreenTab ? m.segment.width / 2 + m.segment.inset : m.segment.inset,
            width: m.segment.width / 2 - m.segment.inset * 2,
            height: m.segment.height - m.segment.inset * 2,
            borderRadius: (m.segment.height - m.segment.inset * 2) / 2,
            background: c.segmentPill,
            boxShadow: "0 3px 8px rgba(0, 0, 0, 0.12), 0 3px 1px rgba(0, 0, 0, 0.04)",
            transition: "left 220ms cubic-bezier(0.32, 0.72, 0, 1)",
          }}
        />
        {(["bubble", "screen"] as const).map((value, index) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            data-tab={value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            style={{
              position: "absolute",
              top: 0,
              left: index * (m.segment.width / 2),
              width: m.segment.width / 2,
              height: m.segment.height,
              background: "transparent",
              border: 0,
              padding: 0,
              fontFamily: "inherit",
              fontSize: m.segment.fontSize,
              fontWeight: tab === value ? m.segment.selectedWeight : m.segment.weight,
              color: c.segmentLabel,
              cursor: "default",
            }}
          >
            <span
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: m.segment.labelCapTop - m.segment.top - capTopInset(m.segment.fontSize),
                lineHeight: 1,
              }}
            >
              {value === "bubble" ? "Bubble" : "Screen"}
            </span>
          </button>
        ))}
      </div>

      {caption && (
        <InkLabel
          data-slot="effects-caption"
          rightInk={captionRightInk}
          capTop={previewTop - captionGap - m.label.capHeight}
          fontSize={captionFontSize}
          style={{ color: c.label, transition: "top 320ms cubic-bezier(0.32, 0.72, 0, 1)" }}
        >
          {caption}
        </InkLabel>
      )}

      {/* Labels sit outside the rail so the rail's own bounds never clip them. */}
      {!onScreenTab &&
        bubbleEffects.map((effect, index) => {
          const chosen = chosenBubble === effect.kind;
          if (chosen) return null;
          const centerY = m.rail.firstRowCenter + index * m.rail.rowPitch;
          return (
            <InkLabel
              key={effect.kind}
              aria-hidden="true"
              data-slot="effects-row-label"
              rightInk={m.label.rightInk}
              capTop={centerY - m.label.capHeight / 2}
              fontSize={m.label.fontSize}
              dim={chosenIndex >= 0}
              style={{ color: c.label }}
            >
              {effect.title.toUpperCase()}
            </InkLabel>
          );
        })}

      <div
        ref={previewBox}
        data-slot="effects-preview"
        style={{
          position: "absolute",
          right: m.frame.width - previewRight,
          top: previewTop,
          width: m.preview.maxWidth,
          display: "flex",
          justifyContent: "flex-end",
          transition: `top ${m.timing.move}ms cubic-bezier(0.32, 0.72, 0, 1), right ${m.timing.move}ms cubic-bezier(0.32, 0.72, 0, 1)`,
          ["--im-blue-top" as string]: m.previewFill,
          ["--im-blue-bottom" as string]: m.previewFill,
        }}
      >
        {chosenBubble === "invisible-ink" ? <InvisibleInk revealed={false}>{preview}</InvisibleInk> : preview}
      </div>

      {!onScreenTab && (
        <div
          ref={rail}
          data-slot="effects-rail"
          role="radiogroup"
          aria-label="Bubble effects"
          onKeyDown={event => {
            const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            const radios = Array.from(rail.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []);
            if (!radios.length) return;
            const from = radios.indexOf(document.activeElement as HTMLButtonElement);
            const current = from < 0 ? Math.max(0, chosenIndex) : from;
            const next = event.key === "Home" ? 0
              : event.key === "End" ? radios.length - 1
                : event.key === "ArrowDown" || event.key === "ArrowRight" ? (current + 1) % radios.length
                  : (current - 1 + radios.length) % radios.length;
            // A radio group moves and chooses together, which is also what the rail's preview does.
            radios[next]?.focus();
            onSelect?.({ bubble: bubbleEffects[next].kind });
          }}
          style={{
            position: "absolute",
            left: m.rail.left,
            top: m.rail.top,
            width: m.rail.width,
            height: m.rail.height,
            borderRadius: m.rail.radius,
            ...continuous,
            background: c.rail,
          }}
        >
          {bubbleEffects.map((effect, index) => {
            const centerY = m.rail.firstRowCenter - m.rail.top + index * m.rail.rowPitch;
            const chosen = chosenBubble === effect.kind;
            return (
              <button
                key={effect.kind}
                type="button"
                role="radio"
                aria-checked={chosen}
                aria-label={chosen ? `Send with ${effect.title}` : effect.title}
                tabIndex={chosen || (chosenIndex < 0 && index === 0) ? 0 : -1}
                onClick={() => (chosen ? onSend?.({ bubble: effect.kind }) : onSelect?.({ bubble: effect.kind }))}
                style={{
                  position: "absolute",
                  left: (m.rail.width - (chosen ? m.send.width : m.dot.size)) / 2,
                  top: centerY - (chosen ? m.send.height : m.dot.size) / 2,
                  width: chosen ? m.send.width : m.dot.size,
                  height: chosen ? m.send.height : m.dot.size,
                  borderRadius: chosen ? m.send.height / 2 : m.dot.size / 2,
                  background: chosen ? c.send : c.dot,
                  color: c.glyph,
                  border: 0,
                  padding: 0,
                  cursor: "default",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "width 220ms cubic-bezier(0.32, 0.72, 0, 1), height 220ms cubic-bezier(0.32, 0.72, 0, 1), left 220ms cubic-bezier(0.32, 0.72, 0, 1), top 220ms cubic-bezier(0.32, 0.72, 0, 1), background-color 220ms ease",
                }}
              >
                {chosen && <UpArrow />}
              </button>
            );
          })}
        </div>
      )}

      {onScreenTab && (
        <div data-slot="effects-pages" aria-hidden="true" style={{ position: "absolute", left: 0, top: m.pageDots.centerY - m.pageDots.size / 2, height: m.pageDots.size }}>
          {screenEffects.map((effect, index) => (
            <span
              key={effect.kind}
              style={{
                position: "absolute",
                left: m.pageDots.firstCenterX + index * m.pageDots.pitch - m.pageDots.size / 2,
                width: m.pageDots.size,
                height: m.pageDots.size,
                borderRadius: m.pageDots.size / 2,
                background: c.label,
                opacity: chosenScreen === effect.kind ? 1 : m.label.dimOpacity,
                transition: "opacity 220ms ease",
              }}
            />
          ))}
        </div>
      )}

      {onScreenTab && (
        <button
          type="button"
          data-slot="effects-send"
          aria-label={chosenTitle ? `Send with ${chosenTitle}` : "Send"}
          onClick={() => onSend?.(selection)}
          style={{
            position: "absolute",
            left: m.send.centerX - m.send.width / 2,
            top: m.send.screenCenterY - m.send.height / 2,
            width: m.send.width,
            height: m.send.height,
            borderRadius: m.send.height / 2,
            background: c.send,
            color: c.glyph,
            border: 0,
            padding: 0,
            cursor: "default",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <UpArrow />
        </button>
      )}

      <button
        type="button"
        data-slot="effects-close"
        aria-label="Cancel"
        onClick={onClose}
        style={{
          position: "absolute",
          left: m.close.centerX - m.close.width / 2,
          top: m.close.centerY - m.close.height / 2,
          width: m.close.width,
          height: m.close.height,
          borderRadius: m.close.height / 2,
          background: c.close,
          color: c.glyph,
          border: 0,
          padding: 0,
          cursor: "default",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Cross />
      </button>
    </div>
  );
}
