"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { fontStack } from "@/components/message-ui/tokens";

/**
 * Message context menus, measured from iOS 26 (`references/ios/captures/longpress-ok-light.png`, 3x)
 * and macOS 26 (`references/macos/captures/ctxmenu-light.png`, 2x).
 *
 * iOS: 250 wide (y 583.5–771.3 in the capture), 10 padding above and below 42-tall rows, 17pt labels at x 60, icons centered at
 * x 36.2, Apple continuous corners of radius 32 (the corner profile fits the iOS 7 squircle curve at
 * 1.0 pt rmse; a circle of any radius is 2+ pt off), glass over the dimmed list (the bubble beneath
 * shows through as the tint).
 * macOS: 302 wide, 0.5 border, 24-tall rows, 13pt labels at x 40.5, icons centered at
 * x 25.25, 1pt separators inset 16 inside an 11pt block, an optional header slot for the tapback rows.
 * Corner radius 12.6, not the 10 this used to carry: tracing the menu's outer edge in `ctxmenu-dark.png`
 * fits a circle of 12.55 pt bottom-right, 12.60 bottom-left and 12.70 top-right (rmse 0.39 pt), and the
 * same trace on `ctxmenu-with-edit-light-2x.png` fits 13.05. Sweeping the radius against the captures
 * agrees: fitting a circle to the 0.5 pt dark outline, the one feature that coincides with our render
 * to 0.1 px along the straight edges, gives 12.41/12.42/12.43 on `ctxmenu-light.png` and
 * 12.29/12.30/12.31 on `ctxmenu-dark.png` (rmse 0.06), and a radius sweep pixel-matched against three
 * 20 pt corner crops bottoms out at 11.95-12.1. The top-left corner has to be left out of any such
 * sweep: a bubble sits behind the glass there in both captures.
 *
 * NOT MEASURED: the highlighted row. No capture in `references/` contains one. The gray band across
 * the lower half of `ctxmenu-with-edit-light-2x.png` looks like a highlight and is not: it is the
 * blurred scene behind the translucent menu. It begins mid-way up the row above the separator and
 * crosses the separator with no step, which a row highlight cannot do. So the highlight here is the
 * inset AppKit shape (4 pt in from each side, radius 6) rather than a full-bleed one, and its colour
 * is the #3478f6 the sidebar's selected row was measured at. Both are unverified.
 */
export const contextMenuMetrics = {
  ios: { width: 250, row: 42, padding: 10, radius: 32, fontSize: 17, textX: 60, iconCenter: 36.2, iconBox: 28, highlightInset: 5, highlightInsetY: 1, highlightRadius: 10 },
  macos: { width: 302, row: 24, padding: 4, paddingBottom: 5, radius: 12, fontSize: 13, textX: 40.5, iconCenter: 25.25, iconBox: 18, separatorBlock: 11, highlightInset: 4, highlightInsetY: 0, highlightRadius: 6 },
} as const;

/**
 * Apple's continuous ("squircle") corner as an SVG path for a w×h rectangle, using the iOS 7 icon
 * approximation (three cubics per corner, tangent length 1.528665·r).
 */
export function continuousRoundedRectPath(w: number, h: number, r: number): string {
  const R = Math.min(r, w / 3.06, h / 3.06);
  const a = 1.528665 * R, b = 1.08849 * R, c = 0.868407 * R, d = 0.631494 * R, e = 0.074911 * R, f = 0.372824 * R, g = 0.16906 * R;
  const n = (v: number) => Number(v.toFixed(3));
  return [
    `M0,${n(a)}`,
    `C0,${n(b)} 0,${n(c)} ${n(e)},${n(d)}`, `C${n(g)},${n(f)} ${n(f)},${n(g)} ${n(d)},${n(e)}`, `C${n(c)},0 ${n(b)},0 ${n(a)},0`,
    `L${n(w - a)},0`,
    `C${n(w - b)},0 ${n(w - c)},0 ${n(w - d)},${n(e)}`, `C${n(w - f)},${n(g)} ${n(w - g)},${n(f)} ${n(w - e)},${n(d)}`, `C${n(w)},${n(c)} ${n(w)},${n(b)} ${n(w)},${n(a)}`,
    `L${n(w)},${n(h - a)}`,
    `C${n(w)},${n(h - b)} ${n(w)},${n(h - c)} ${n(w - e)},${n(h - d)}`, `C${n(w - g)},${n(h - f)} ${n(w - f)},${n(h - g)} ${n(w - d)},${n(h - e)}`, `C${n(w - c)},${n(h)} ${n(w - b)},${n(h)} ${n(w - a)},${n(h)}`,
    `L${n(a)},${n(h)}`,
    `C${n(b)},${n(h)} ${n(c)},${n(h)} ${n(d)},${n(h - e)}`, `C${n(f)},${n(h - g)} ${n(g)},${n(h - f)} ${n(e)},${n(h - d)}`, `C0,${n(h - c)} 0,${n(h - b)} 0,${n(h - a)}`,
    "Z",
  ].join(" ");
}

/** Height of an iOS context menu for a set of items (10 + 42 per item + 0.5 per separator + 10). */
export function iosContextMenuHeight(items: ContextMenuItem[]): number {
  const m = contextMenuMetrics.ios;
  const rows = items.filter(item => !("separator" in item)).length;
  return m.padding * 2 + m.row * rows + (items.length - rows) * 0.5;
}

export type ContextMenuItem = { id: string; label: string; icon?: MenuIconName | ReactNode; destructive?: boolean; disabled?: boolean } | { separator: true };
export type MenuIconName = "copy" | "translate" | "select" | "more" | "tapback-details" | "reply" | "sticker" | "forward" | "delete" | "clock" | "save";

export const iosMessageMenu: ContextMenuItem[] = [
  { id: "copy", label: "Copy", icon: "copy" },
  { id: "translate", label: "Translate", icon: "translate" },
  { id: "select", label: "Select", icon: "select" },
  { id: "more", label: "More…", icon: "more" },
];

/**
 * **A photo does not get the text bubble's menu.** MEASURED on the device: long-pressing a sent
 * photo balloon on iOS 26 opens a three-row menu reading **Save / Copy / More…** — no Translate, no
 * Select, and no Reply. Captured by driving Messages through XCUITest (three photos sent into one
 * conversation, then a 1.0 s press on the last balloon and on the middle one). The capture is in the
 * repo as `references/ios/light/photo-long-press-0.png`, 1206x2622; the middle-balloon one it is
 * cross-checked against is not (one capture per scene), and its numbers are in
 * `references/simulator-cases.md` §3.5.
 *
 * The menu's *chrome* is the same `contextMenuMetrics.ios` the text menu uses, and the capture
 * confirms every number of it: the panel measures **250.000 x 146.000** (x 136.000..386.000,
 * y 686.000..832.000), which `iosContextMenuHeight` reproduces exactly for three rows
 * (10 + 3x42 + 10 = 146); the three label/icon ink bands centre on y 717.500, 759.167 and 801.167
 * against a menu top of 686.0, i.e. 31.5 / 73.5 / 115.5 inside it, which is `padding` 10 + `row` 42
 * to the last digit; the icon ink centres on x 172.167, i.e. **36.167** from the panel's leading
 * edge (`iconCenter` 36.2); and the label ink starts at x 197.0, **61.0** in (`textX` 60).
 *
 * `ADD_TO_PHOTOS_LIBRARY` ("Add to Photos Library"), `SAVE_COUNT_PHOTO` ("Save %tu Photo") and
 * `COPY_PHOTOS` ("Copy %tu Photos") are all in `ChatKit.loctable`, so the plural and multi-select
 * forms of these rows exist; the single-photo case captured here spells them "Save" (`SAVE`) and
 * "Copy" (`COPY`). What "More…" opens is NOT captured.
 */
export const iosPhotoMenu: ContextMenuItem[] = [
  { id: "save", label: "Save", icon: "save" },
  { id: "copy", label: "Copy", icon: "copy" },
  { id: "more", label: "More…", icon: "more" },
];
/**
 * The menu behind the sidebar's list-options button, whose `aria-haspopup="menu"` used to be a
 * promise nothing kept. Every label is ChatKit's own, out of `ChatKit.loctable`: `ALL_MESSAGES`,
 * `UNKNOWN_SENDERS`, `KNOWN_SENDERS`, `UNREAD_MESSAGES` and `RECENTLY_DELETED`, with `FILTER_BY` as
 * the heading the framework carries for them.
 *
 * **UNMEASURED: the order, the grouping and the check mark.** No capture in `references/` holds this
 * menu open. What the strings settle is which rows exist and how they are spelled; the sequence here
 * is the one the framework's own `CHANGE_FILTER_MODE_INTENT` inbox list reads in, and Recently
 * Deleted is separated because it opens a screen rather than filtering the list. The menu's *chrome*
 * is measured - it is `contextMenuMetrics.macos`, the same 302 pt AppKit menu the transcript uses.
 */
export const macosListFilterMenu: ContextMenuItem[] = [
  { id: "all", label: "All Messages" },
  { id: "known", label: "Known Senders" },
  { id: "unknown", label: "Unknown Senders" },
  { id: "unread", label: "Unread Messages" },
  { separator: true },
  { id: "recently-deleted", label: "Recently Deleted" },
];

export const macosMessageMenu: ContextMenuItem[] = [
  { id: "tapback-details", label: "Tapback Details…", icon: "tapback-details" },
  { id: "reply", label: "Reply…", icon: "reply" },
  { id: "sticker", label: "Attach Sticker…", icon: "sticker" },
  { separator: true },
  { id: "forward", label: "Forward…", icon: "forward" },
  { id: "copy", label: "Copy", icon: "copy" },
  { separator: true },
  { id: "delete", label: "Delete…", icon: "delete" },
  { separator: true },
  { id: "show-times", label: "Show Times", icon: "clock" },
];

/** SF-Symbol look-alikes drawn as strokes; `size` is the icon box, glyphs are proportioned like the originals. */
export function MenuIcon({ name, size = 22, style }: { name: MenuIconName; size?: number; style?: CSSProperties }) {
  const s = { fill: "none", stroke: "currentColor", strokeWidth: 1.55, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const common = { width: size, height: size, viewBox: "0 0 22 22", "aria-hidden": true as const, style: { display: "block", ...style } };
  switch (name) {
    case "copy": return (
      <svg {...common}><path {...s} d="M8.2,6.4 V3.6 A1.4,1.4 0 0 1 9.6,2.2 H14.3 L18.4,6.3 V13.2 A1.4,1.4 0 0 1 17,14.6 H14.2" /><path {...s} d="M14.2,2.4 V6.4 H18.2" /><path {...s} d="M4.9,7.4 H10.6 L14.2,11 V18.4 A1.4,1.4 0 0 1 12.8,19.8 H4.9 A1.4,1.4 0 0 1 3.5,18.4 V8.8 A1.4,1.4 0 0 1 4.9,7.4 Z" /><path {...s} d="M10.4,7.6 V11.2 H14" /></svg>
    );
    case "translate": return (
      <svg {...common} viewBox="0 0 26 20" width={size * 29 / 22} height={size * 22 / 22}>
        <path {...s} d="M2.2,2.8 A1.4,1.4 0 0 1 3.6,1.4 H12.4 A1.4,1.4 0 0 1 13.8,2.8 V9.2 A1.4,1.4 0 0 1 12.4,10.6 H6.2 L3.4,13 V10.6 H3.6 A1.4,1.4 0 0 1 2.2,9.2 Z" />
        <path {...s} d="M5.4,8.4 L8,3.6 L10.6,8.4 M6.2,6.9 H9.8" strokeWidth={1.35} />
        <path d="M11.6,9.6 H22.4 A1.4,1.4 0 0 1 23.8,11 V17.2 A1.4,1.4 0 0 1 22.4,18.6 H19.4 L16.8,20.6 V18.6 H13 A1.4,1.4 0 0 1 11.6,17.2 Z" fill="currentColor" />
        <path d="M14.4,12.3 H20.6 M17.5,11.2 V12.3 M15.4,12.3 C15.9,14.6 17.4,16 19.6,16.9 M19.6,12.3 C19,14.7 17.4,16.2 15.3,17" fill="none" stroke="var(--im-menu-bg, #edeff1)" strokeWidth={0.95} strokeLinecap="round" />
      </svg>
    );
    case "select": return (
      <svg {...common}><path {...s} d="M6.4,1.8 V15.6 A1.4,1.4 0 0 0 7.8,17 H17.4" /><path {...s} d="M4.6,6.6 H15.2 A1.4,1.4 0 0 1 16.6,8 V20.2" /><circle cx="6.4" cy="1.8" r="1.35" fill="currentColor" /><circle cx="16.6" cy="20.2" r="1.35" fill="currentColor" /></svg>
    );
    case "more": return (
      <svg {...common}><circle {...s} cx="11" cy="11" r="8.3" /><circle cx="7" cy="11" r="1.15" fill="currentColor" /><circle cx="11" cy="11" r="1.15" fill="currentColor" /><circle cx="15" cy="11" r="1.15" fill="currentColor" /></svg>
    );
    case "tapback-details": return (
      <svg {...common}><circle {...s} cx="9.6" cy="9.6" r="6.8" /><path {...s} d="M14.6,14.6 L19.6,19.6" strokeWidth={2} /><path {...s} d="M9.6,6.4 V12.8 M6.4,9.6 H12.8" /></svg>
    );
    case "reply": return (
      <svg {...common}><path {...s} d="M9.4,4.6 L3.2,10.2 L9.4,15.8 V12.3 C13.6,12.3 16.8,13.6 19,17.6 C18.6,12.4 15.6,8.2 9.4,8.1 Z" /></svg>
    );
    case "forward": return (
      <svg {...common}><path {...s} d="M12.6,4.6 L18.8,10.2 L12.6,15.8 V12.3 C8.4,12.3 5.2,13.6 3,17.6 C3.4,12.4 6.4,8.2 12.6,8.1 Z" /></svg>
    );
    case "sticker": return (
      <svg {...common}><path {...s} d="M11,3.2 A8,8 0 1 0 19,11.2 L18.6,11.2 A7.4,7.4 0 0 1 11,3.6 Z" /><path {...s} d="M11.6,3 L19.2,10.6" /><path {...s} d="M6,7.4 A5.3,5.3 0 0 0 5,13" /><path {...s} d="M17.2,14.2 V19.4 M14.6,16.8 H19.8" strokeWidth={1.8} /></svg>
    );
    case "delete": return (
      <svg {...common}><path {...s} d="M4.2,6.2 H17.8 M8.6,6.2 V4.4 A1.2,1.2 0 0 1 9.8,3.2 H12.2 A1.2,1.2 0 0 1 13.4,4.4 V6.2" /><path {...s} d="M5.6,6.2 L6.6,17.6 A1.6,1.6 0 0 0 8.2,19 H13.8 A1.6,1.6 0 0 0 15.4,17.6 L16.4,6.2" /><path {...s} d="M9.2,9.2 L9.6,16 M12.8,9.2 L12.4,16" /></svg>
    );
    case "clock": return (
      <svg {...common}><circle {...s} cx="11" cy="11" r="8.3" /><path {...s} d="M11,6.2 V11.3 L14.4,13.3" /></svg>
    );
    // `square.and.arrow.down`: a rounded square broken open at the top, with an arrow dropping
    // through the gap into it. Traced from the Save row of `references/ios/light/photo-long-press-0.png`, where
    // the ink measures 17.000 x 17.667 pt centred on the row — taller than it is wide because the
    // arrow's shaft starts above the square's top edge. The proportions here are that ink box in a
    // 22 viewBox; the stroke weight is the one every other icon in this file uses, not a measurement.
    case "save": return (
      <svg {...common}><path {...s} d="M8.7,5.3 H7.6 A3,3 0 0 0 4.6,8.3 V15.55 A3,3 0 0 0 7.6,18.55 H14.4 A3,3 0 0 0 17.4,15.55 V8.3 A3,3 0 0 0 14.4,5.3 H13.3" /><path {...s} d="M11,2.55 V13.2 M7.4,9.6 L11,13.2 L14.6,9.6" /></svg>
    );
  }
}

export type ContextMenuProps = {
  variant?: "ios" | "macos";
  items: ContextMenuItem[];
  onAction?: (id: string) => void;
  onClose?: () => void;
  /** Rendered above the items (macOS: the two tapback rows). */
  header?: ReactNode;
  /**
   * iOS: a color painted at the top of the menu, fading to the neutral fill. Native gets this from the
   * bubble showing through the glass; pass one when the menu floats over a plain background.
   */
  tint?: string;
  /**
   * iOS: a faint wash of the bubble color over the whole menu (native glass carries a little of the
   * bubble's color far below the blurred edge). Pass the bubble's fill color.
   */
  wash?: string;
  /** macOS: menu width; iOS is fixed at 250. */
  width?: number;
  autoFocus?: boolean;
  /** Flip to false to play the dismissal; `onExited` fires when it is over. */
  open?: boolean;
  onExited?: () => void;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
};

export function ContextMenu({ variant = "ios", items, onAction, onClose, header, tint, wash, width, open = true, onExited, autoFocus = false, className, style, "aria-label": ariaLabel = "Message actions" }: ContextMenuProps) {
  const root = useRef<HTMLDivElement>(null);
  // Native menus fade and settle back rather than vanishing; keep the element mounted for it.
  const exited = useRef(onExited);
  useEffect(() => { exited.current = onExited; }, [onExited]);
  useEffect(() => {
    if (open) return;
    const element = root.current;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (!element || reduced) { exited.current?.(); return; }
    const animation = element.animate(
      [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.94)" }],
      { duration: 120, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "both" },
    );
    animation.finished.then(() => exited.current?.()).catch(() => {});
    return () => { try { animation.cancel(); } catch { /* already gone */ } };
  }, [open]);
  const m = contextMenuMetrics[variant];

  // Move focus into the menu on open, and hand it back to whatever opened the menu when it goes. A
  // layout effect, so the cleanup runs while the menu is still in the DOM.
  //
  // The menu itself takes the focus, not its first row. Focusing a row programmatically while a
  // finger is still down makes Chrome match `:focus-visible` on it - the pointer interaction has not
  // resolved, so the modality is still the keyboard default - which lights that row's highlight and
  // draws a ring on a menu the person opened by touch. Focus lands here instead; `onKeyDown` below
  // is on this element so every key still arrives, and the first arrow moves to a row, where the
  // highlight is right because the person really is on the keyboard.
  useLayoutEffect(() => {
    if (!autoFocus) return;
    const menu = root.current;
    const opener = document.activeElement as HTMLElement | null;
    menu?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      const inside = active instanceof Node && menu?.contains(active);
      if (inside && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [autoFocus]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); onClose?.(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    // The macOS menu carries the Tapback bar in its header, and that bar owns its own arrow, Home and
    // End behaviour. Let a key that started inside it through instead of moving the menu's focus.
    if ((event.target as HTMLElement | null)?.closest?.('[data-slot="tapback-bar"]')) return;
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([aria-disabled=true])") ?? []);
    if (!buttons.length) return;
    event.preventDefault();
    // -1 when the focus is still on the menu itself, which is where it starts. From there Down has
    // to reach the first row and Up the last; wrapping arithmetic on -1 lands on neither.
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const last = buttons.length - 1;
    const next = event.key === "Home" ? 0
      : event.key === "End" ? last
      : i < 0 ? (event.key === "ArrowDown" ? 0 : last)
      : event.key === "ArrowDown" ? (i + 1) % buttons.length
      : (i - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  // Half of a separator's 11pt block, i.e. the bare gap the row above or below it has to fill.
  const separatorGap = (contextMenuMetrics.macos.separatorBlock - 1) / 2;

  // The highlight is a child rather than the button's own background so it can sit inset the way
  // AppKit draws it. Driving its opacity from CSS keeps it out of React state on every pointer move.
  // The touch half of this. Hover does not exist on a phone and `:focus-visible` stays off for a
  // pointer, so without it a finger on a row lit nothing at all - the menu looked dead under the
  // very gesture it is driven by. `:active` is not the answer: it depends on the engine's own
  // gesture arbitration and does not fire for a dispatched touch, which makes it untestable. So the
  // press is state, the way `ios-conversation-list` holds its row highlight.
  const [pressed, setPressed] = useState<string | null>(null);
  const highlightStyle = `[data-slot="menu-item"] > [data-slot="menu-highlight"]{opacity:0;transition:opacity 60ms linear}
[data-slot="menu-item"]:hover > [data-slot="menu-highlight"],[data-slot="menu-item"]:focus-visible > [data-slot="menu-highlight"],[data-slot="menu-item"][data-pressed="true"] > [data-slot="menu-highlight"]{opacity:1}
[data-slot="menu-item"][aria-disabled="true"] > [data-slot="menu-highlight"]{opacity:0}`;

  const rows = items.map((item, index) => {
    if ("separator" in item) {
      return <div key={`sep-${index}`} role="separator" data-slot="menu-separator" style={variant === "macos"
        ? { height: 1, marginBlock: separatorGap, marginInline: 16, background: "var(--im-menu-separator, #dfe0e2)" }
        : { height: 0.5, background: "var(--im-menu-separator, rgba(0,0,0,0.12))" }} />;
    }
    const gapTop = 0;
    const gapBottom = 0;
    return (
      <button key={item.id} type="button" role="menuitem" aria-disabled={item.disabled || undefined} tabIndex={item.disabled ? -1 : undefined} data-slot="menu-item" data-id={item.id} onClick={() => !item.disabled && onAction?.(item.id)}
        data-pressed={pressed === item.id && !item.disabled ? "true" : undefined}
        onPointerDown={() => setPressed(item.id)} onPointerUp={() => setPressed(null)}
        onPointerCancel={() => setPressed(null)} onPointerLeave={() => setPressed(null)}
        className={cn("flex w-full cursor-default items-center border-0 bg-transparent text-left outline-none",
          item.destructive ? "text-[var(--im-menu-destructive,#ff3b30)]" : "text-[var(--im-menu-text,#000)]",
          !item.disabled && variant === "macos" && "hover:text-white focus-visible:text-white")}
        style={{ height: m.row + gapTop + gapBottom, boxSizing: "border-box", paddingTop: gapTop || undefined, paddingBottom: gapBottom || undefined, marginTop: gapTop ? -gapTop : undefined, marginBottom: gapBottom ? -gapBottom : undefined,
          paddingLeft: m.textX, position: "relative", fontFamily: fontStack, fontSize: m.fontSize, lineHeight: `${m.row}px`, letterSpacing: 0, opacity: item.disabled ? 0.4 : 1, width: "100%" }}>
        {/* The highlight is inset and rounded on both platforms, never a full-bleed line. iOS uses a
            neutral wash inside the menu's own padding; macOS uses the accent. */}
        <span aria-hidden="true" data-slot="menu-highlight" className="pointer-events-none absolute"
          style={variant === "macos"
            ? { left: 4, right: 4, top: 0, bottom: 0, borderRadius: 6, background: "#3478f6" }
            : { left: m.highlightInset, right: m.highlightInset, top: m.highlightInsetY, bottom: m.highlightInsetY, borderRadius: m.highlightRadius, background: "var(--im-menu-highlight, rgba(0,0,0,0.05))" }} />
        <span aria-hidden="true" data-slot="menu-icon" style={{ position: "absolute", left: m.iconCenter - m.iconBox / 2, top: gapTop, bottom: gapBottom, width: m.iconBox, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {typeof item.icon === "string" ? <MenuIcon name={item.icon as MenuIconName} size={variant === "ios" ? 22 : 16} /> : item.icon}
        </span>
        <span data-slot="menu-label" style={{ whiteSpace: "nowrap", position: "relative" }}>{item.label}</span>
      </button>
    );
  });

  if (variant === "macos") {
    return (
      <div ref={root} role="menu" aria-label={ariaLabel} data-slot="context-menu" data-variant="macos" tabIndex={-1} className={cn("select-none outline-none", className)} onKeyDown={onKeyDown}
        style={{ width: width ?? m.width, boxSizing: "border-box", borderRadius: m.radius, overflow: "hidden", position: "relative", paddingTop: m.padding, paddingBottom: contextMenuMetrics.macos.paddingBottom, fontFamily: fontStack, color: "var(--im-menu-text, #242526)",
          background: "var(--im-menu-bg, rgba(247,248,251,0.92))", backdropFilter: "blur(30px) saturate(1.6)", WebkitBackdropFilter: "blur(30px) saturate(1.6)",
          boxShadow: "0 0 0 0.5px var(--im-menu-border, #b1b1b1), 0 8px 24px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.12)", ...style }}>
        <style>{highlightStyle}</style>
        {header}
        {rows}
        {/* The bright inner rim rides above the rows so a highlight cannot erase it. */}
        <div aria-hidden="true" data-slot="menu-rim" style={{ position: "absolute", inset: 0, borderRadius: "inherit", pointerEvents: "none", boxShadow: "inset 0 0 0 0.5px var(--im-menu-rim, rgba(255,255,255,0.7))" }} />
      </div>
    );
  }

  const background = tint
    ? `linear-gradient(to bottom, ${tint} 0px, ${tint} 30px, color-mix(in srgb, ${tint} 45%, var(--im-menu-bg, #edeff1)) 47px, color-mix(in srgb, ${tint} 22%, var(--im-menu-bg, #edeff1)) 64px, color-mix(in srgb, ${tint} 8%, var(--im-menu-bg, #edeff1)) 114px, var(--im-menu-bg, #edeff1))`
    : "var(--im-menu-glass, rgba(229,229,231,0.69))";
  const height = iosContextMenuHeight(items);
  const outline = continuousRoundedRectPath(m.width, height, m.radius);
  const shape = `path("${outline}")`;
  // A `backdrop-filter` is clipped to its element's border box and border radius, never to its
  // `clip-path`: the glass's brightened backdrop therefore painted a hard square corner outside the
  // menu's continuous one. Measured on the long-press scene at 3x, 1 device px inside the left edge
  // and 20 below the top: #ffffff against the #cccbd0 the dimmed list continues past the corner, and
  // #d9d7dd against #c7c6cb at the bottom right. A mask of the same path IS respected, so the glass
  // carries the shape twice: the clip for its fill, the mask for the backdrop it filters.
  const maskShape = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="${height}"><path d="${outline}" fill="#000"/></svg>`)}")`;
  return (
    <div ref={root} role="menu" aria-label={ariaLabel} data-slot="context-menu" data-variant="ios" tabIndex={-1} className={cn("select-none outline-none", className)} onKeyDown={onKeyDown}
      style={{ width: m.width, height, boxSizing: "border-box", fontFamily: fontStack, position: "relative", ...style }}>
      <style>{highlightStyle}</style>
      <div aria-hidden="true" data-slot="menu-shadow" style={{ position: "absolute", inset: 0, transform: "translateY(7px)", filter: "blur(11px)", pointerEvents: "none" }}>
        <div style={{ position: "absolute", inset: 0, clipPath: shape, background: "var(--im-menu-shadow, rgba(0,0,0,0.16))" }} />
      </div>
      <div aria-hidden="true" data-slot="menu-glass" style={{ position: "absolute", inset: 0, clipPath: shape, background,
        WebkitMaskImage: maskShape, maskImage: maskShape, WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
        backdropFilter: "var(--im-menu-glass-filter, blur(9px) brightness(1.32) saturate(1.35))", WebkitBackdropFilter: "var(--im-menu-glass-filter, blur(9px) brightness(1.32) saturate(1.35))" }} />
      <svg aria-hidden="true" data-slot="menu-rim" width={m.width} height={height} viewBox={`0 0 ${m.width} ${height}`} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <path d={outline} fill="none" stroke="var(--im-glass-rim, rgba(255,255,255,0.55))" strokeWidth={1} />
      </svg>
      {wash && <div aria-hidden="true" data-slot="menu-wash" style={{ position: "absolute", inset: 0, pointerEvents: "none", clipPath: shape, background: `linear-gradient(to bottom, transparent 34px, color-mix(in srgb, ${wash} 4.5%, transparent) 52px, color-mix(in srgb, ${wash} 2.5%, transparent) 60%, color-mix(in srgb, ${wash} 1%, transparent))` }} />}
      {/* A pressed or focused row paints edge to edge, so it has to be cut by the menu's own corner:
          clip the rows to the same continuous shape the glass uses instead of letting them square it off. */}
      <div style={{ position: "absolute", inset: 0, boxSizing: "border-box", paddingBlock: m.padding, clipPath: shape }}>{header}{rows}</div>
    </div>
  );
}
