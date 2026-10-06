"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { fontStack } from "@/components/message-ui/tokens";
import { BalloonTrail, pickerBalloonGeometry, TapbackGlyph, tapbackColors, tapbackLabels, tapbackTypes, type TapbackType } from "@/components/message-ui/tapback";

/**
 * Tapback picker, measured from iOS 26 (`references/ios/captures/longpress-ok-light.png`, 3x) and
 * macOS 26 (`references/macos/captures/ctxmenu-light.png`, 2x).
 *
 * iOS: a glass pill 64.33 tall (y 452–516.33 in the capture, measured on the centre line) with 49-wide
 * glyph slots, the first glyph centered 32.5 from the pill's left end; glyph art 25.33. The emoji-picker
 * "thought bubble" (Ø44 + Ø14.6 + Ø8, same shape as a balloon at 1.3x) is centered 14.67 below the pill's bottom edge.
 * macOS: two rows of six inside the context menu. Glyph ink centres in `ctxmenu-light.png` (2x, menu
 * border at x 11 px / y 3 px) are 40.00, 87.00, 133.50, 180.25, 227.00 and 273.75 pt in row 2, so the
 * pitch is 46.75 and the first slot's centre sits 34.5 from the menu's leading edge. The row-2 emoji
 * ink is 20.0 × 20.0 centred at y 64.0 (62.5 inside the menu) and the same 👍 measures 18.5 wide in
 * both rows, so one glyph size serves both; the rows are 38.5 apart (👍 ink centres 25.25 and 63.75).
 * Both rows sit on the one slot grid and nothing nudges row 2: a padding on the emoji slots used to
 * put the whole row 0.75 right of the capture, because a border-box slot spends the padding out of
 * its own width and so moves its centred content by half of it.
 * `emojiSize` is 21, the size whose ink measures the capture's 20.0 wide and lands on its exact rows
 * (108–147 at 2x). The rest of the gap is rasterisation, not geometry, and cannot be styled away:
 * Chromium snaps an Apple Color Emoji bitmap to whole device pixels, so at 21 the ink sits one device
 * pixel (0.5 pt) left of the capture, and the 20.75 that recovers that pixel loses two in y. At any
 * size it draws 👍 a point wider than the capture's 18.5 and 🥹 a point narrower than its 20.0, in
 * opposite directions, so no one size fixes both.
 *
 * `inset` puts the first slot's centre 34.5 from the menu's *fill* edge. The capture measures that
 * 34.5 from the outer edge of the menu's 0.5 pt border, half a point further left, so the whole grid
 * sits 0.5 right of native. It is left that way deliberately: the picker's glyphs are drawn about
 * that much left inside their own boxes (row 1's art in `tapback.tsx`, row 2's by the emoji
 * rasteriser), and correcting the grid alone moves every ink centre in both rows away from the
 * capture. Correct them together, not the grid on its own.
 *
 * **ChatKit corroborates the iOS row exactly.** Read out of the live framework on 2026-09-10 with the
 * Catalyst probe in `references/tapback-details.md`, `CKUIBehaviorPhone`:
 * `messageAcknowledgmentPickerBarSize` = **{310, 74}** and `messageAcknowledgmentPickerBarPadding` =
 * **5**. Both numbers fall straight out of the values measured above:
 *
 * - height: 74 − 2×5 = **64**, against the 64.33 measured on the capture's centre line.
 * - width: six `slot` of 49 is 294, and `firstCenter` 32.5 leaves 32.5 − 49/2 = **8** of lead, which
 *   the trailing spacer repeats, so 294 + 2×8 = **310** to the point. ChatKit even names that 8:
 *   `messageAcknowledgmentPickerBarItemSectionPush` = 8.
 *
 * So `slot`, `firstCenter` and `height` are each confirmed twice, by a capture and by the framework.
 *
 * What does **not** agree is that 310 is a *fixed* width there, while `message-actions.tsx` stretches
 * the pill from the screen margin to the bubble's trailing edge — 375.17 pt beside a balloon whose
 * right edge is 386. The capture is what that file measured and what this kit keeps; the framework's
 * 310 is recorded here because a bar that is 310 wide and merely *anchored* beside the bubble would
 * explain the same capture, and nothing measured so far separates the two. A long-press over a
 * NARROW bubble would: a stretched pill shrinks with the bubble, a 310 pill does not.
 *
 * Three more picker constants, for whoever measures the emoji row next, none of them used here:
 * `messageAcknowledgmentPickerBarAcknowledgmentItemBalloonSize` {42, 42},
 * `messageAcknowledgmentPickerBarItemSectionScaleFactor` 0.85, and `emojiTapbackScaleFactor` 0.8125
 * (0.8125 × 42 = 34.125, which is neither this file's `glyph` 25.33 nor its `emojiSize` 25, so what it
 * scales is NOT established). `messageAcknowledgmentPickerBarArrowWidth` 24 / `…ArrowPadding` 8 size a
 * scroll arrow this bar does not draw and no capture shows.
 */
export const tapbackBarMetrics = {
  ios: { height: 64.33, slot: 49, firstCenter: 32.5, glyph: 25.33, selectedRing: 44, pickerDrop: 14.67, edgeInset: 10.83, emojiSize: 25 },
  macos: { slot: 46.75, glyph: 20.5, emojiSize: 21, row1: 40, row2: 37, rowHeight: 36, inset: 11.13 },
} as const;

export type TapbackSelection = { type: TapbackType } | { emoji: string };
export type TapbackBarProps = {
  layout?: "ios" | "macos";
  selected?: TapbackSelection;
  /** Recently used emoji shown after the six classics (fixture data). */
  recent?: string[];
  onSelect?: (selection: TapbackSelection) => void;
  /** Called when the emoji picker (thought bubble on iOS, smiley button on macOS) is activated. */
  onPickEmoji?: () => void;
  onClose?: () => void;
  /** iOS: x of the emoji-picker circle's center relative to the pill's left edge; omit to hide it. */
  pickerX?: number;
  /** iOS: which way the picker's trail points (away from the bubble). */
  pickerSide?: "left" | "right";
  /** iOS: pill width; defaults to its content. */
  width?: number;
  /** Autofocus the first (or selected) glyph on mount. */
  autoFocus?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Optional per-glyph style hook, used by the long-press overlay to stagger the entrance. */
  glyphStyle?: (index: number) => CSSProperties | undefined;
  children?: ReactNode;
};

const defaultRecent = ["😂", "❤️", "😮", "😢", "😭", "👍"];

function isSelected(sel: TapbackSelection | undefined, type?: TapbackType, emoji?: string) {
  if (!sel) return false;
  return "type" in sel ? sel.type === type : sel.emoji === emoji;
}

/** SF Symbol "face.smiling" look-alike, an outlined grinning face. */
export function SmileyIcon({ size = 22, color = "currentColor", strokeWidth = 1.7, style }: { size?: number; color?: string; strokeWidth?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden="true" style={style}>
      <circle cx="11" cy="11" r="9.5" fill="none" stroke={color} strokeWidth={strokeWidth} />
      <circle cx="7.7" cy="8.5" r="1.25" fill={color} />
      <circle cx="14.3" cy="8.5" r="1.25" fill={color} />
      <path d="M5.4,12.3 H16.6 C16.6,15.7 14.1,18 11,18 C7.9,18 5.4,15.7 5.4,12.3 Z" fill="none" stroke={color} strokeWidth={strokeWidth * 0.9} strokeLinejoin="round" />
    </svg>
  );
}

/** The emoji-picker thought bubble: a Ø44 glass circle merged into the bar with two trailing circles. */
export function EmojiPickerBubble({ side = "left", onClick, style, fill, iconColor, iconStyle, glass, clipTop = 0, role, tabIndex, index, onFocus }: { side?: "left" | "right"; onClick?: () => void; style?: CSSProperties; fill: string; iconColor: string; iconStyle?: CSSProperties; glass?: CSSProperties; clipTop?: number; role?: string; tabIndex?: number; index?: number; onFocus?: () => void }) {
  const g = pickerBalloonGeometry;
  const Tag = onClick ? "button" : "div";
  return (
    // Without a handler it opens nothing, so it is decoration and says nothing to a screen reader.
    <Tag type={onClick ? "button" : undefined} data-slot="emoji-picker-bubble" aria-label={onClick ? "Choose an emoji" : undefined} aria-hidden={onClick ? undefined : true} onClick={onClick}
      role={onClick ? role : undefined} tabIndex={onClick ? tabIndex : undefined} data-index={onClick ? index : undefined} onFocus={onClick ? onFocus : undefined}
      className={cn("border-0 p-0 outline-none", onClick && "cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-500")}
      style={{ position: "absolute", width: g.main, height: g.main, borderRadius: "50%", background: fill, display: "flex", alignItems: "center", justifyContent: "center", ...glass, clipPath: clipTop ? `inset(${clipTop}px -40px -40px -40px)` : undefined, ...style }}>
      <SmileyIcon size={g.glyph} color={iconColor} style={iconStyle} />
      <BalloonTrail geometry={g} side={side} color={fill} />
    </Tag>
  );
}

export function TapbackBar({ layout = "ios", selected, recent = defaultRecent, onSelect, onPickEmoji, onClose, pickerX, pickerSide = "left", width, autoFocus = false, className, style, glyphStyle, children }: TapbackBarProps) {
  const root = useRef<HTMLDivElement>(null);
  const items: Array<{ type?: TapbackType; emoji?: string; label: string }> = [
    ...tapbackTypes.map(type => ({ type, label: tapbackLabels[type] })),
    ...recent.map(emoji => ({ emoji, label: emoji })),
  ];
  const selectedIndex = items.findIndex(item => isSelected(selected, item.type, item.emoji));
  const [focusIndex, setFocusIndex] = useState(selectedIndex >= 0 ? selectedIndex : 0);

  /**
   * Focus the bar, not a glyph.
   *
   * A glyph focused programmatically while the finger is still down matches `:focus-visible` in
   * Chrome and paints a blue ring the captures do not have - two vertical bars inside the pill,
   * since its rounding clips the ring's ends. The heuristic is not wrong so much as early: a
   * touchStart that is still held has not resolved into a click or a scroll yet, so the modality is
   * still whatever it was, and a programmatic focus inherits the keyboard default. Isolated:
   * a mouse click then `focus()` does not match, a held touchStart then `focus()` does, and a held
   * touchStart whose default is prevented does not.
   *
   * The container takes no ring, `onKeyDown` below still receives every key because it is on this
   * element, and the first arrow key moves to a glyph - where a ring is right, because by then the
   * person really is on the keyboard.
   */
  useEffect(() => {
    if (!autoFocus) return;
    root.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("button[data-index]") ?? []);
    const current = buttons.findIndex(b => b === document.activeElement);
    const move = (next: number) => { event.preventDefault(); const i = (next + buttons.length) % buttons.length; setFocusIndex(i); buttons[i]?.focus(); };
    if (event.key === "Escape") { event.preventDefault(); onClose?.(); }
    else if (event.key === "ArrowRight") move((current < 0 ? focusIndex : current) + 1);
    else if (event.key === "ArrowLeft") move((current < 0 ? focusIndex : current) - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(buttons.length - 1);
    else if (layout === "macos" && event.key === "ArrowDown") move((current < 0 ? focusIndex : current) + 6);
    else if (layout === "macos" && event.key === "ArrowUp") move((current < 0 ? focusIndex : current) - 6);
  }

  const glyphButton = (item: (typeof items)[number], index: number, size: number, slot: number, extra?: CSSProperties) => {
    const active = isSelected(selected, item.type, item.emoji);
    return (
      <button key={item.type ?? item.emoji} type="button" role="menuitemradio" aria-checked={active} aria-label={item.label} data-index={index} data-slot="tapback-option" data-selected={active || undefined}
        tabIndex={index === focusIndex ? 0 : -1}
        onClick={() => onSelect?.(item.type ? { type: item.type } : { emoji: item.emoji! })}
        onFocus={() => setFocusIndex(index)}
        className="relative flex shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        style={{ width: slot, height: "100%", ...extra, ...glyphStyle?.(index) }}>
        {active && layout === "ios" && <span aria-hidden="true" data-slot="tapback-selected-ring" style={{ position: "absolute", width: tapbackBarMetrics.ios.selectedRing, height: tapbackBarMetrics.ios.selectedRing, borderRadius: "50%", background: "var(--im-tapback-ring, " + tapbackColors.selectedRing + ")" }} />}
        {active && layout === "macos" && <span aria-hidden="true" data-slot="tapback-selected-ring" style={{ position: "absolute", width: 30, height: 30, borderRadius: "50%", background: "var(--im-tapback-ring, " + tapbackColors.selectedRing + ")" }} />}
        <TapbackGlyph type={item.type} emoji={item.emoji} size={size} onAccent={active} style={{ position: "relative" }} />
      </button>
    );
  };

  if (layout === "macos") {
    const m = tapbackBarMetrics.macos;
    const classics = items.slice(0, 6);
    const emoji = items.slice(6, 11);
    // The macOS bar is the header of a `role="menu"` context menu, so it is a group inside that menu
    // rather than a second menu: `menuitemradio` needs a menu ancestor, and a nested `menu` would be
    // reported as a submenu that has no parent item.
    return (
      <div ref={root} role="group" aria-label="Tapback" data-slot="tapback-bar" data-layout="macos" tabIndex={-1} className={cn("select-none outline-none", className)} onKeyDown={onKeyDown}
        style={{ fontFamily: fontStack, paddingInline: m.inset, ...style }}>
        <div data-slot="tapback-row" style={{ display: "flex", height: m.row1, alignItems: "center" }}>
          {classics.map((item, i) => glyphButton(item, i, m.glyph, m.slot, { height: m.rowHeight }))}
        </div>
        <div data-slot="tapback-row" style={{ display: "flex", height: m.row2, alignItems: "center" }}>
          {emoji.map((item, i) => glyphButton(item, i + 6, m.emojiSize, m.slot, { height: m.rowHeight }))}
          <button type="button" role="menuitem" aria-label="More emoji" data-index={11} data-slot="tapback-option" tabIndex={focusIndex === 11 ? 0 : -1} onFocus={() => setFocusIndex(11)} onClick={onPickEmoji}
            className="flex shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-blue-500" style={{ width: m.slot, height: m.rowHeight }}>
            {/* 18.6 is the box whose r 9.5 + 1.6 stroke draws the capture's 17.5 square outline. */}
            <SmileyIcon size={18.6} color="currentColor" strokeWidth={1.6} />
          </button>
        </div>
        {children}
      </div>
    );
  }

  const m = tapbackBarMetrics.ios;
  const height = m.height;
  const glass: CSSProperties = {
    background: "var(--im-glass, rgba(255,255,255,0.635))",
    backdropFilter: "var(--im-glass-filter, blur(9px) brightness(1.32) saturate(1.35))", WebkitBackdropFilter: "var(--im-glass-filter, blur(9px) brightness(1.32) saturate(1.35))",
    boxShadow: "var(--im-glass-shadow, 0 6px 24px rgba(0,0,0,0.10)), inset 0 0 0 0.5px var(--im-glass-rim, rgba(255,255,255,0.55))",
  };
  return (
    <div ref={root} role="menu" aria-label="Tapback" data-slot="tapback-bar" data-layout="ios" tabIndex={-1} className={cn("select-none outline-none", className)} onKeyDown={onKeyDown}
      style={{ position: "relative", height, width, borderRadius: height / 2, fontFamily: fontStack, ...style }}>
      <div data-slot="tapback-pill" style={{ position: "absolute", inset: 0, borderRadius: height / 2, ...glass }} />
      <div data-slot="tapback-scroll" className="scrollbar-none" style={{ position: "absolute", inset: 0, borderRadius: height / 2, overflowX: "auto", overflowY: "hidden", display: "flex", alignItems: "center", paddingLeft: m.firstCenter - m.slot / 2, scrollbarWidth: "none" }}>
        {items.map((item, i) => glyphButton(item, i, item.type ? m.glyph : m.emojiSize, m.slot))}
        <span aria-hidden="true" style={{ flex: "none", width: m.firstCenter - m.slot / 2 }} />
      </div>
      {pickerX !== undefined && (
        <EmojiPickerBubble side={pickerSide} onClick={onPickEmoji} fill="var(--im-glass-solid, #ededef)" iconColor="var(--im-picker-icon, #aeaeb2)"
          role="menuitem" index={items.length} tabIndex={focusIndex === items.length ? 0 : -1} onFocus={() => setFocusIndex(items.length)}
          glass={{ boxShadow: "var(--im-glass-shadow, 0 6px 24px rgba(0,0,0,0.10))" }} iconStyle={{ marginTop: -1.5 }}
          clipTop={pickerBalloonGeometry.main / 2 - m.pickerDrop}
          style={{ left: pickerX - pickerBalloonGeometry.main / 2, top: height + m.pickerDrop - pickerBalloonGeometry.main / 2, ...(glyphStyle?.(-1) ?? {}) }} />
      )}
      {children}
    </div>
  );
}
