"use client";

import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { fontStack, type Direction, type Service } from "@/components/message-ui/tokens";
import { BalloonTrail, TapbackGlyph, tapbackLabels, type TapbackType } from "@/components/message-ui/tapback";
import { TapbackBar, tapbackBarMetrics, type TapbackSelection } from "@/components/message-ui/tapback-bar";
import { ContextMenu, contextMenuMetrics, iosContextMenuHeight, iosMessageMenu, type ContextMenuItem } from "@/components/message-ui/context-menu";

/**
 * The iOS long-press overlay. Layout measured from `references/ios/captures/longpress-*.png`:
 * the pressed bubble is lifted about its trailing edge by a uniform scale that widens it by 26.07,
 * capped at 1.15. Three pressed bubbles fix that, each measured against its own unpressed copy in
 * `conv3-light.png`: "Ok" 49.62×40.08 → 57.15×45.96 hits the cap, while the wider two-liners take the
 * same 26: "Every detail…" 250.96×60.24 → 277.00×66.43 (1.1037 wide, 1.1027 tall) and "Aaaa…"
 * 280.63×60.24 → 306.74×65.82 (1.0930 / 1.0926). A height-driven rule would miss "Aaaa…" by 2 pt.
 * Each grows about its own centre, which rises 0.18 (0.135 for "Ok", 0.222 for "Aaaa…", and the "Ok"
 * glyph ink agrees at 0.17). The text rides the scale: that glyph ink also grows 1.148 × 1.132, so
 * `textScale` stays 1. The tapback pill sits 5 above the bubble (measured 5.09) and stretches from
 * the screen margin (10.83) to the bubble's trailing edge, the
 * emoji-picker bubble hangs from the pill with its centre 28 beside the bubble, and the 250-wide menu
 * starts 16.1 below the bubble's own bottom edge, tail included (the 6.8 hang scales with the lift).
 * Six frames give 16.07/16.11/16.07/16.09/16.11/16.2, reading each menu's top off its first row's
 * "Copy" ink rather than its washed-out glass edge. If the menu would pass 42 above the frame's
 * bottom (three frames clamp there, all with their menu top at 644.02) or the bar rise above 60, the
 * whole group shifts; incoming bubbles mirror everything (bar 16→391.17, picker to the right, menu
 * left-aligned). `topInset` is the one number here with no capture behind it: nothing in the nine
 * long-press frames pushes the bar high enough to clamp.
 *
 * Motion (60 fps frames in references/ios/motion/): dim from 0 ms; bubble lift + menu unfolding from
 * the bubble's corner over ≈130 ms; the pill expands from the picker circle over ≈200 ms; glyphs fade
 * in left to right with a 17 ms stagger. `progress` (0..1) scrubs the whole timeline.
 */
export const messageActionsTiming = { total: 600, exit: 220, dim: 150, lift: 130, menu: 130, picker: [60, 200], bar: [100, 320], glyphStart: 250, glyphStagger: 17, glyphDuration: 120 } as const;

/**
 * The dim behind the overlay. It covers the whole screen: the status bar and the nav bar go under it
 * with the list, unblurred and not re-drawn above it. Fitted, not guessed — `longpress-ok-light.png`
 * is `conv3-light.png` with one message pressed, so one capture over the other measures the dim
 * directly. Outside the overlay's own furniture (device rows 1356-2349) and the status-bar clock (the
 * two captures are 24 minutes apart) every pixel of that frame is `capture = screen·0.79 +
 * (22,21,42)·0.21`, residual 0.14/255 mean and 0.9 max over the nav bar's full 0-255 range. Three more
 * pairs agree: `incoming-light.png` -> `longpress-incoming-light.png` and `conv2-dark.png` ->
 * `longpress-last-bubble-dark.png` come back at 0.001/255 mean error — exact after rounding — and the
 * same value carries `longpress-two-line-light.png`. It is one dim in both themes, and one alpha over
 * every layer: fitting the bands of the light pair separately gives 0.2103/0.2092/0.2130 over the nav
 * bar, 0.2105/0.2054/0.2129 over the list and 0.2133/0.2118/0.2172 over the composer.
 *
 * The (22,18,44) this used to carry renders white as (206,205,210) where every light capture reads
 * #ceced2 = (206,206,210): the green channel was a level dark everywhere the dim fell.
 *
 * Chrome cannot land both ends of this at once, and the last level is its rounding, not the value.
 * It composites an overlay as `round(src·(1-a₈)) + round(tint·a₈)` with the alpha quantised to
 * 54/255, so the tint's contribution is one rounded triple: over black it is (5,4,9), which fixes
 * white at 201+(5,4,9) = (206,205,210). Native rounds the sum instead and gets (5,4,9) over black and
 * (206,206,210) over white from the same value. (23,22,43) buys the light end (measured over the lab's
 * nav band: interior G +0.2 instead of -0.8) and loses the dark one by the same level (+1.0 instead of
 * 0.0), so this keeps the measured number and wears one level of green over bright grounds.
 *
 * `--im-dim` still wins wherever a palette sets it, and `tapback.tsx` sets it for both themes; it now
 * carries this same value. Two fallbacks elsewhere are still the old one and want correcting:
 * `message-reply.tsx` (the reply-thread dim) and `tapback-details.tsx` (the details scrim).
 *
 * KNOWN WRONG, and not fixable from here: this dim reaches the Dynamic Island, and nothing may. The
 * island is a hardware cutout the OS composites above the app, so it reads #000000 in every capture
 * that has an overlay over it — `longpress-*`, `newmsg-light.png`, `plus-menu-open-light.png`,
 * `details-light.png`, `photo-picker-light.png` — while the status bar around it dims with everything
 * else (#ceced2 under this dim, #cccccc under the sheet's). Under our dim it goes to (5,4,9), a flat
 * +6 over the island's 125.33×36.67 pt, which is 6.4% of the 0 0 402 168 band. The fix belongs where
 * the island is drawn (`ios-status-bar.tsx` plus the app's z-order), not in one overlay: every dim in
 * the app has the same bug.
 */
export const messageActionsDim = "var(--im-dim, rgba(22,21,42,0.21))";

export const messageActionsMetrics = {
  /** The lift widens the bubble by this much, up to `liftMaxScale`; height follows the same factor. */
  liftWidth: 26.07, liftMaxScale: 1.15, liftY: -0.18, barGap: 5, menuGap: 16.1, tailHang: 6.8, pickerBeside: 28, topInset: 60, bottomInset: 42,
  /**
   * **A photo lifts to a fixed width, not by the text bubble's rule.** MEASURED on the device: a
   * long-pressed photo balloon's preview spans x **60.000 .. 386.000** — 326.000 pt — on both a 1:1
   * balloon and a 3:4 one, so it is not aspect-driven. Against the 252.667 every photo balloon is
   * wide (`references/simulator-cases.md` §3.4) that is a uniform **x1.2902**, against the 1.1032
   * `liftScale` would give it and the 1.15 it caps at. The heights agree: the 3:4 balloon goes
   * 337.000 -> 434.000 (x1.2878) and the 1:1 one 252.667 -> ~325.9 (x1.281-1.290).
   *
   * Two captures, both 1206x2622 host screenshots taken while the menu was up: the last balloon of a
   * run of three (tailed, 3:4), in the repo as `references/ios/light/photo-long-press-0.png`, and the
   * middle one (tailless, 1:1), whose numbers are in `references/simulator-cases.md` §3.5. The resting
   * frame they are measured against is `references/ios/light/photo-run-0.png`, and the same run's
   * `dump-tree` gives its cells: y -17.7 / 176.0 / 432.7, heights 189.7 / 252.7 / 337.0, all 252.667
   * wide with their right edge on 386.0.
   *
   * Whether native's rule is "scale a photo preview to 326 wide" or "scale it by 1.29" cannot be
   * told apart from these two, because every photo balloon starts at the same 252.667. The width is
   * the one of the pair that is directly measured, so that is what this carries.
   */
  photoLiftWidth: 326,
  /**
   * The tapback pill's leading inset when the pressed message is a photo. MEASURED 6.000 on both
   * photo captures (the pill's leftmost column over its own vertical middle), against the **10.83**
   * the same measurement returns on `references/ios/captures/longpress-ok-light.png`, re-checked
   * here. Nothing explains the difference: the bar is the same 64.333 tall in all three, ends on the
   * balloon's trailing edge in all three, and carries the same 49 pt slot grid with its first glyph
   * centred 32.5 from the pill's own left end (measured centres 38.500, 87.167, ~137.8, 185.333,
   * ~234.2, 283.667 with the pill starting at 6.000). It is recorded, not derived.
   */
  photoBarEdgeInset: 6,
} as const;

export type Rect = { x: number; y: number; width: number; height: number };

/** Takes the bubble's unscaled body: the lift is driven by its width, not its height. */
export function liftScale({ width }: Pick<Rect, "width">): number {
  return Math.min(messageActionsMetrics.liftMaxScale, 1 + messageActionsMetrics.liftWidth / width);
}

/** The lift a photo balloon takes: a uniform scale onto `photoLiftWidth`. See that constant. */
export function photoLiftScale({ width }: Pick<Rect, "width">): number {
  return width > 0 ? messageActionsMetrics.photoLiftWidth / width : 1;
}

export type MessageActionsProps = {
  /** The pressed bubble body's rect (unscaled), in the frame's coordinates. */
  rect: Rect;
  frame: { width: number; height: number };
  direction?: Direction;
  service?: Service;
  /** Whether the pressed bubble has a tail (the menu clears it). */
  tail?: boolean;
  /** The bubble to lift; rendered at `rect` inside the overlay. */
  children: ReactNode;
  items?: ContextMenuItem[];
  selected?: TapbackSelection;
  /**
   * The colour the menu's glass picks up from the message above it. Defaults to that message's own
   * bubble fill. Pass null for a message that has no bubble to give it: an emoji-only message is a bare
   * glyph, and a photo, a link card and a file card each carry their own surface instead.
   *
   * UNVERIFIED for those kinds. Every long-press capture in `references/ios/` is of a text bubble, so
   * what native tints the glass with when nothing coloured sits behind it is not measured; plain glass
   * is the conservative reading of "the bubble behind it seen through the glass".
   */
  wash?: string | null;
  recent?: string[];
  /** The tapback pill's inset from the screen edge it reaches. See `messageActionsMetrics.photoBarEdgeInset`. */
  barEdgeInset?: number;
  /** Who reacted, for the details popover shown when re-opening a message that already has your tapback. */
  details?: { initials: string; name?: string };
  onSelect?: (selection: TapbackSelection) => void;
  onAction?: (id: string) => void;
  onPickEmoji?: () => void;
  onClose?: () => void;
  /** Scrub position 0..1 of the entrance; omit to play it. */
  progress?: number;
  /** Flip to false to play the dismissal; `onExited` fires when it is over. */
  open?: boolean;
  onExited?: () => void;
  /** Move focus into the tapback bar on open (default). */
  autoFocus?: boolean;
  /** Override the lift scale (default: `liftScale(rect)`, uniform). */
  scale?: number | [number, number];
  /** Counter-scale for the text inside the lifted bubble. Native scales it with the bubble, so 1. */
  textScale?: number;
  className?: string;
  style?: CSSProperties;
};

export function layoutMessageActions({ rect, frame, direction, scale, items, tail = false, barEdgeInset = tapbackBarMetrics.ios.edgeInset }: { rect: Rect; frame: { width: number; height: number }; direction: Direction; scale: [number, number]; items: ContextMenuItem[]; tail?: boolean; /** The pill's inset from the screen edge it reaches; see `messageActionsMetrics.photoBarEdgeInset`. */ barEdgeInset?: number }) {
  const m = messageActionsMetrics;
  const outgoing = direction === "outgoing";
  const [sx, sy] = scale;
  // The lift scales the bubble about its trailing edge and nudges it up by `liftY` (0.18, not the
  // 0.55 this once carried; see the header for the three centres that fix it).
  const lifted = { width: rect.width * sx, height: rect.height * sy, left: 0, top: rect.y + rect.height / 2 - (rect.height * sy) / 2 + m.liftY };
  lifted.left = outgoing ? rect.x + rect.width - lifted.width : rect.x;
  const barH = tapbackBarMetrics.ios.height;
  const bar = { left: outgoing ? barEdgeInset : rect.x, right: outgoing ? rect.x + rect.width : frame.width - barEdgeInset, top: lifted.top - m.barGap - barH, height: barH };
  const cm = contextMenuMetrics.ios;
  const menuHeight = iosContextMenuHeight(items);
  // The menu clears the bubble's own bottom edge, so a tail pushes it down by its scaled hang.
  const menu = { left: outgoing ? rect.x + rect.width - cm.width : rect.x, top: lifted.top + lifted.height + m.menuGap + (tail ? m.tailHang * sy : 0), height: menuHeight };
  // Keep the menu above the composer and the bar below the nav bar; the whole group moves together.
  let shift = 0;
  const menuBottom = menu.top + menuHeight;
  if (menuBottom > frame.height - m.bottomInset) shift = frame.height - m.bottomInset - menuBottom;
  if (bar.top + shift < m.topInset) shift = m.topInset - bar.top;
  const pickerCenterX = outgoing ? lifted.left - m.pickerBeside : lifted.left + lifted.width + m.pickerBeside;
  return { outgoing, lifted, bar, menu, shift, bubbleTranslate: shift + m.liftY, pickerX: pickerCenterX - bar.left };
}

export function MessageActions({ rect, frame, direction = "outgoing", service = "imessage", tail = false, children, items = iosMessageMenu, selected, wash, recent, barEdgeInset, details, onSelect, onAction, onPickEmoji, onClose, progress, open = true, onExited, autoFocus = true, scale: scaleProp, textScale: textScaleProp, className, style }: MessageActionsProps) {
  const root = useRef<HTMLDivElement>(null);
  const scrub = useRef<((time: number | null) => void) | null>(null);
  const id = useId().replace(/:/g, "");
  const s = scaleProp ?? liftScale(rect);
  const scale: [number, number] = typeof s === "number" ? [s, s] : s;
  const textScale = textScaleProp ?? 1;
  const L = layoutMessageActions({ rect, frame, direction, scale, items, tail, barEdgeInset });
  const side = L.outgoing ? "left" : "right";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose?.(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The overlay is modal, so the message that was pressed gets focus back when the overlay gives it
  // up (`autoFocus` goes false as the dismissal starts, while the overlay is still mounted).
  // A passive effect, not a layout one: React restores the pre-commit focus at the end of the commit
  // phase, so a layout effect's focus() is undone before the frame is painted.
  const restoreTo = useRef<HTMLElement | null>(null);
  // Captured in a layout effect (before the bar's own autoFocus, which is a passive effect in a
  // child) and never overwritten with something inside the overlay, so a re-run cannot record the
  // glyph the bar just focused as the thing to go back to.
  useLayoutEffect(() => {
    if (!autoFocus) return;
    const active = document.activeElement;
    if (!(active instanceof Node && root.current?.contains(active))) restoreTo.current = active as HTMLElement | null;
  }, [autoFocus]);
  useEffect(() => {
    if (!autoFocus) return;
    const overlay = root.current;
    return () => {
      const previous = restoreTo.current;
      const active = document.activeElement;
      const inside = active instanceof Node && overlay?.contains(active);
      if (inside && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [autoFocus]);

  /** Tab stays inside the overlay while it is open, the way a modal sheet does. */
  function onRootKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const el = root.current;
    if (!el) return;
    const stops = Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(node => node.getClientRects().length > 0);
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    const active = document.activeElement;
    const inside = active instanceof Node && el.contains(active);
    if (event.shiftKey ? active === first || !inside : active === last || !inside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  // Build the entrance timeline once with the Web Animations API so it can be played or scrubbed.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const t = messageActionsTiming;
    const q = <T extends Element>(slot: string) => Array.from(el.querySelectorAll<T>(`[data-slot="${slot}"]`));
    const one = (slot: string) => el.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
    const list: Animation[] = [];
    const add = (target: Element | null, keyframes: Keyframe[], options: KeyframeAnimationOptions) => { if (target) list.push(target.animate(keyframes, { fill: "both", ...options })); };
    const spring = "cubic-bezier(0.2, 0.95, 0.3, 1)";
    add(one("backdrop"), [{ opacity: 0 }, { opacity: 1 }], { duration: t.dim, easing: "ease-out" });
    add(one("lifted-bubble"), [{ transform: "translateY(0px) scale(1, 1)" }, { transform: `translateY(${L.bubbleTranslate}px) scale(${scale[0]}, ${scale[1]})` }], { duration: t.lift, easing: spring });
    // The counter-scale rides a registered custom property so a consumer can animate it; at the native
    // default of 1 this keyframe is a no-op and the text simply scales with the bubble.
    try { CSS.registerProperty({ name: "--im-lift-text", syntax: "<number>", inherits: true, initialValue: "1" }); } catch { /* already registered */ }
    add(one("lifted-bubble"), [{ "--im-lift-text": "1" } as Keyframe, { "--im-lift-text": String(textScale) } as Keyframe], { duration: t.lift, easing: spring });
    add(one("context-menu"), [{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "scale(1)" }], { duration: t.menu, easing: spring });
    add(one("emoji-picker-bubble"), [{ opacity: 0, transform: "scale(0.35)" }, { opacity: 1, transform: "scale(1)" }], { duration: t.picker[1] - t.picker[0], delay: t.picker[0], easing: spring });
    const pill = one("tapback-pill");
    if (pill) {
      const h = L.bar.height;
      const pickerLeft = L.pickerX - 22, pickerRight = L.bar.right - L.bar.left - (L.pickerX + 22);
      // The pill grows out of the picker circle, so it starts clipped to that circle on either side.
      const start = `inset(${(h - 44) / 2}px ${Math.max(0, pickerRight)}px ${(h - 44) / 2}px ${Math.max(0, pickerLeft)}px round 22px)`;
      add(pill, [{ clipPath: start, opacity: 0.6 }, { clipPath: `inset(0px 0px 0px 0px round ${h / 2}px)`, opacity: 1 }], { duration: t.bar[1] - t.bar[0], delay: t.bar[0], easing: spring });
    }
    q<HTMLElement>("tapback-option").forEach((glyph, i) => add(glyph, [{ opacity: 0, transform: "translateX(6px) scale(0.8)" }, { opacity: 1, transform: "translateX(0) scale(1)" }], { duration: t.glyphDuration, delay: t.glyphStart + i * t.glyphStagger, easing: "ease-out" }));
    add(one("tapback-details"), [{ opacity: 0, transform: "translateY(-8px) scale(0.9)" }, { opacity: 1, transform: "translateY(0) scale(1)" }], { duration: 200, delay: 200, easing: spring });
    // A held (paused or filling) animation on the menu promotes it to its own compositing layer, which
    // cuts the backdrop its glass filters and leaves the panel flat and dark. Every layer's resting
    // style already is the end state, so drop the animations once the timeline is over.
    const settle = (a: Animation) => { try { a.cancel(); } catch { /* already gone */ } };
    scrub.current = time => {
      for (const a of list) {
        if (time === null) { a.play(); a.finished.then(() => settle(a)).catch(() => {}); }
        else if (time >= t.total) settle(a);
        else { a.pause(); a.currentTime = time; }
      }
    };
    return () => { list.forEach(a => a.cancel()); scrub.current = null; };
    // The timeline depends on the final layout only; a new layout remounts via `key` upstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (progress !== undefined) scrub.current?.(Math.min(1, Math.max(0, progress)) * messageActionsTiming.total);
    else if (reduced) scrub.current?.(messageActionsTiming.total);
    else scrub.current?.(null);
  }, [progress]);

  // Dismissal. The entrance animations are cancelled once they settle (so the glass keeps its
  // backdrop), so this is a fresh, shorter timeline that folds everything back toward the bubble.
  const exited = useRef(onExited);
  useEffect(() => { exited.current = onExited; }, [onExited]);
  useEffect(() => {
    if (open) return;
    const overlay = root.current;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!overlay || reduced) { exited.current?.(); return; }
    const pick = (slot: string) => Array.from(overlay.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`));
    const shrink = [...pick("context-menu"), ...pick("tapback-pill"), ...pick("emoji-picker-bubble"), ...pick("tapback-details")];
    const D = messageActionsTiming.exit;
    const timing: KeyframeAnimationOptions = { duration: D, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "both" };
    const running = [
      ...pick("backdrop").map(el => el.animate([{ opacity: 1 }, { opacity: 0 }], timing)),
      ...shrink.map(el => el.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.72)" }], timing)),
      ...pick("lifted-bubble").map(el => el.animate([{ transform: getComputedStyle(el).transform }, { transform: "none" }], { ...timing, easing: "cubic-bezier(0.3, 0, 0.2, 1)" })),
    ];
    let done = false;
    const finish = () => { if (!done) { done = true; exited.current?.(); } };
    if (!running.length) { finish(); return; }
    Promise.allSettled(running.map(a => a.finished)).then(finish);
    return () => running.forEach(a => { try { a.cancel(); } catch { /* already gone */ } });
  }, [open]);

  return (
    // z-20 clears the reaction balloons the list paints at z-10, so they dim and blur with everything else.
    <div ref={root} data-slot="message-actions" data-direction={direction} role="dialog" aria-modal="true" aria-label="Message options"
      onKeyDown={onRootKeyDown} className={cn("absolute inset-0 z-20 select-none outline-none", className)} style={{ fontFamily: fontStack, ...style }}>
      {/* The lift is a transform, so the bubble's own shrink-to-fit measures its line boxes in scaled
          screen pixels and would set a frame that is `scale` too wide. Pin it to the measured body. */}
      <style>{`[data-actions="${id}"] [data-slot="bubble"] > span:last-child { display: inline-block; transform-origin: 50% 50%; transform: scale(var(--im-lift-text, 1)); }
[data-actions="${id}"] [data-slot="bubble-frame"] { max-width: ${rect.width}px !important; }`}</style>
      <div data-slot="backdrop" aria-hidden="true" onClick={onClose} style={{ position: "absolute", inset: 0, background: messageActionsDim }} />
      {/* The lifted bubble casts its own shadow onto the dimmed list. Fitted beside the "Ok" bubble in
          `longpress-ok-light.png`, where nothing else contributes: the dim (#ceced2 over white) reads
          194 at 0.7 pt out, 196 at 4, 198 at 7.3, 201 at 12.3 and 202 at 14, and 188 just under the body.
          One tight layer carries the edge and one wide layer the falloff; both reproduce within 1/255.
          `drop-shadow` rather than `box-shadow` so the tail and the reaction balloon cast it too. */}
      <div data-slot="lifted-bubble" data-actions={id} data-service={service} style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height, transformOrigin: L.outgoing ? "100% 50%" : "0% 50%", transform: `translateY(${L.bubbleTranslate}px) scale(${scale[0]}, ${scale[1]})`, filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.07)) drop-shadow(0 6px 24px rgba(0,0,0,0.13))", "--im-lift-text": String(textScale) } as CSSProperties}>
        {children}
      </div>
      <TapbackBar layout="ios" selected={selected} recent={recent} onSelect={onSelect} onPickEmoji={onPickEmoji} autoFocus={autoFocus}
        pickerX={L.pickerX} pickerSide={side} width={L.bar.right - L.bar.left}
        style={{ position: "absolute", left: L.bar.left, top: L.bar.top + L.shift }} />
      <ContextMenu variant="ios" items={items} onAction={onAction}
        wash={wash === undefined ? (service === "sms" ? "var(--im-green-bottom, #31c355)" : L.outgoing ? "var(--im-blue-bottom, #3583f6)" : "var(--im-gray-bottom, #e9e9eb)") : wash ?? undefined}
        style={{ position: "absolute", left: L.menu.left, top: L.menu.top + L.shift, transformOrigin: L.outgoing ? "100% 0%" : "0% 0%" }} />
      {selected && details && <TapbackDetails selection={selected} initials={details.initials} name={details.name} style={{ position: "absolute", left: frame.width / 2 - tapbackDetailsMetrics.width / 2, top: tapbackDetailsMetrics.top }} />}
    </div>
  );
}

/**
 * The "tapback details" popover shown when a message that already carries your reaction is re-opened.
 * Measured on `longpress-ok-selected-light.png` (3x): a 124×121 glass card with continuous corners,
 * centred on the screen at y 66.26. Inside, a Ø49.76 white balloon whose trail points straight DOWN
 * (Ø11.13 at +27.34 and Ø5.18 at +38.0 from its centre) sits with its centre 33.57 below the card's
 * top, and the reactor's Ø30.66 avatar is centred 93.6 below it. The glyph ink is 26.3 wide.
 */
export const tapbackDetailsMetrics = {
  width: 124, height: 121, radius: 30, top: 66.26,
  balloon: { main: 49.76, medium: 11.13, small: 5.18, mediumOffset: [0, 27.34] as [number, number], smallOffset: [0, 38.0] as [number, number], glyph: 26.6, glyphOffsetY: 1.2 },
  balloonCenterY: 33.57, avatar: 30.66, avatarCenterY: 93.6,
} as const;

export function TapbackDetails({ selection, initials, name, style }: { selection: TapbackSelection; initials: string; name?: string; style?: CSSProperties }) {
  const m = tapbackDetailsMetrics;
  const g = m.balloon;
  return (
    <div data-slot="tapback-details" role="group" aria-label={`${name ?? initials} reacted with ${"type" in selection ? tapbackLabels[selection.type] : selection.emoji}`}
      style={{ position: "relative", width: m.width, height: m.height, borderRadius: m.radius, background: "var(--im-glass-solid, #ededef)", boxShadow: "var(--im-glass-shadow, 0 8px 28px rgba(0,0,0,0.10)), inset 0 0 0 0.5px var(--im-glass-rim, rgba(255,255,255,0.55))", ...style }}>
      <div data-slot="details-balloon" style={{ position: "absolute", left: m.width / 2 - g.main / 2, top: m.balloonCenterY - g.main / 2, width: g.main, height: g.main, borderRadius: "50%", background: "var(--im-details-balloon, #ffffff)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <TapbackGlyph type={"type" in selection ? selection.type : undefined} emoji={"emoji" in selection ? selection.emoji : undefined} size={g.glyph} style={{ marginTop: 2 * g.glyphOffsetY }} />
        <BalloonTrail geometry={g} side="left" color="var(--im-details-balloon, #ffffff)" />
      </div>
      <div aria-hidden="true" data-slot="details-avatar"
        style={{ position: "absolute", left: m.width / 2 - m.avatar / 2, top: m.avatarCenterY - m.avatar / 2, width: m.avatar, height: m.avatar, borderRadius: "50%", background: "linear-gradient(#a8bfe1, #7f8ec1)", color: "#fff", fontSize: 12.5, fontWeight: 600, letterSpacing: 0.2, display: "flex", alignItems: "center", justifyContent: "center" }}>{initials}</div>
    </div>
  );
}

export type { TapbackType };
