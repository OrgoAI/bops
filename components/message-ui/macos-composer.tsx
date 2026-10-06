"use client";

import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * macOS 26 Messages composer row. Measured from `references/macos/captures/conversation-pane-dark.png`,
 * `conversation-pane-dark-2.png`, `composer-empty-and-typed-dark.png`, `conversation-pane-light.png` and
 * `conversation-pane-light-partial.png` (pane coordinates, 630 wide, window 640 tall; every capture is 2x,
 * so the pane pixel 1196 quoted below is point 598):
 * - "+" button: Ø30, left 9, bottom 11 (center 24, 614; outer edge px 18–77 and 1198–1257 in the dark pane).
 *   Cross 12.3 long including the caps, 1.7 stroke, centered (14.8, 15.2) in the button's own 30 box, so it
 *   sits 0.2 left of and 0.2 below the button centre. #f1f1f1 dark / #010101 light.
 * - field: x 49–579 (530 wide), 31 tall, bottom 11 (pill; the ends deviate from a circle by at most 0.35 pt).
 *   Dark: fill #232323, text #dddddd, placeholder #626262. Light: fill #ffffff, placeholder #bdbdbd, no rim
 *   at all (the fill steps straight to the pane). Every element floats on the same soft downward shadow (in
 *   light, 11/255 darker than the pane just under the field, 5/255 in the two px above it, 3/255 eight px
 *   above).
 * - the dark rim is lit on one diagonal, not uniform: it is #424242 for 0.77 inside the top edge (reading
 *   #424242 then #343434 down the two px), the same along the other three edges and at the top-left and
 *   bottom-right, and it vanishes into the fill at the top-right and bottom-left. Peaks around the "+"
 *   circle: 0x40 top, 0x42 left/right, 0x45 bottom-right, 0x24 top-right and bottom-left. The same rim is
 *   on the field and both buttons, and two offset inset shadows reproduce it. Our two dim diagonals
 *   still carry 0x2f against native's 0x24, and that is Chrome's antialiasing floor rather than a wrong
 *   offset: the band an inset shadow paints along a normal is `offset · normal + spread`, which is
 *   already 0 on those two diagonals, and Chrome still inks each shadow's tangent edge there. It can be
 *   pushed past 0 with a negative spread, and offsets of 1.1 with a -0.326 spread (which keeps the
 *   measured 0.774 band on the straight edges, byte for byte) do take the null to 0x23 and cut the peak
 *   error over 24 angles from 165 to 131 on the field and 107 to 64 on the "+" circle. It is not worth
 *   it: the same negative spread widens the *lit* diagonal from 1.094 to 1.229, which spills an extra
 *   antialiased pixel down the bottom-right of all three shapes and costs 11 mismatched pixels in each
 *   dark composer region. The measured 0.774 with no spread is what stays.
 * - text: 13pt system. Web SF at 13px runs 7% wide of native, so it carries -0.4px tracking ("Every detail"
 *   inks 128 px at 2x both ways, "Message" 99 px). Native caps measure 17.5–18.1 px (E vs M) against the
 *   font's 18.3, i.e. within half a pt. Cap top 10.75 below the field top ("E" ink top px 1217.5, baseline
 *   1235), ink x 62 for typed text; the placeholder sits 2.5 further right (ink x 64.35) and 0.5 lower
 *   (baseline px 1236) while the caret stays at the typed origin (x 60.75–62.25, 15 tall, accent blue).
 * - "waveform" glyph: five stadium bars centred on the field's middle at (559.5, 613.5), hidden while text
 *   exists. Widths 1.6 / 1.8 / 2.0 / 1.8 / 1.6, heights 3.77 / 7.0 / 14.47 / 7.0 / 3.77, centres 3.595 and
 *   7.305 either side of the middle bar. #858585 dark / #999999 light. These ink 7.347 / 13.755 / 28.673
 *   device px in their tallest column against native's 7.531 / 14.000 / 28.939, and that 0.09–0.13 pt
 *   shortfall is Chrome's, not a wrong number: it rasterizes an SVG shape's extent onto a half-device-
 *   pixel grid, so sweeping the middle bar's height at 0.02 steps the ink 28.673 → 29.184 → 29.673 with
 *   nothing in between (the boundaries land on 14.62 and 14.88, and scaling the viewBox 4x does not move
 *   them, so the grid is in device space). Native's 28.939 falls between two attainable values. Drawing
 *   the bars as HTML boxes instead is worse still: they snap to the whole CSS pixel and ink 27.673.
 * - emoji button: Ø30 outside the field, left 589 (right inset 11). "face.smiling" Ø15.55 centred (14.79,
 *   15.2) in the button box: outlined 1.35 in light, filled #f4f4f4 in dark with the features cut out. Eyes
 *   Ø1.98 at (12.54, 13.42) and (17.06, 13.42). The mouth is a 10.04-wide D whose top edge arcs up 0.65 at
 *   the corners (15.65) from its middle (16.3) and whose bottom reaches 20.36, with a 0.94-thick band of
 *   teeth curving through it.
 *
 * ## Growing past one line
 *
 * Every capture holds a one-line field, so nothing past the first line is measured. What is measured is
 * the one-line box (31 tall, bottom 11 above the pane bottom, cap top 10.75 below the field top) and the
 * line pitch of the same 13pt system text elsewhere in the app: **14.70**, read off the bubbles of
 * `conversation-pane-light.png` (28.76 / 43.39 / 58.10 / 72.87 for one to four lines) and already in
 * `tokens.ts` as `bubbleMetrics.macos.lineHeight`. Put the field's text on that pitch and the rest
 * follows: one line of 14.70 inside a 31 box leaves 16.30 of padding, and it is split evenly, **8.15
 * above and 8.15 below**. Evenly, because Chrome snaps a line's origin to the whole CSS pixel: sweeping
 * the padding at 0.05 and diffing the rendered rows, every value from 7.50 to 8.45 puts this line's ink
 * byte for byte where the old 16pt line box put it, and the even split is the one inside that plateau
 * that also lands the caret box on the measured caret (native 8 to 23 inside the field, 8.15 to 22.85
 * here). A "correct" 7.15, which is the old 6.5 plus the 0.65 of half-leading a shorter line box gives
 * back, sits on the far side of that snap and renders a whole pixel high.
 *
 * Each extra line therefore adds 14.70: two lines 45.70, three 60.40, nine 148.60. The field grows upward
 * only, so its bottom edge and both buttons stay on y 629, as the field's own `bottom: 11` and the
 * buttons' already do. The corner radius stays 15.5 while it grows, which is what the iOS field is
 * measured to do (a plain circular radius at one line and at four alike); no macOS capture shows it.
 *
 * ## Motion
 *
 * **Unverified: no capture in this repo records this field in motion**, so the height change is timed by
 * borrowing, not by measurement. 160 ms on `cubic-bezier(0.32, 0.72, 0, 1)` is the entrance
 * `macos-plus-menu.tsx` plays, which is itself the decelerating curve of the measured iOS effects screen
 * (`effectsPickerMetrics.timing`); the shrink reuses the same pair, and that symmetry is a guess too.
 * What is exact is the pose at each end: the animation runs from the height the field had to the height
 * the text needs, both of them the layout above, and it carries no fill, so the frame at progress 1 *is*
 * the settled layout rather than a copy of it. `grow={{ fromLines, progress }}` seeks it instead of
 * playing it, the way `MacPlusMenu` takes `progress`, so a scrubbed checkpoint renders the same every
 * run; `prefers-reduced-motion` builds no animation at all and the field is simply at its new height.
 *
 * ## Focus
 *
 * Every macOS composer capture is of a **focused** field, and not one of them draws a focus ring:
 * in `composer-empty-and-typed-dark.png` the empty focused field and the typed focused field carry the
 * same rim as the two buttons beside them, to the byte: sampling both crops' caps every 15 degrees
 * returns the same 0x39 at the top, 0x45 on the lit diagonals and 0x24 on the dim ones, and the same
 * #424242 then #343434 down the top edge. So this component draws no accent ring either. What focus
 * does change is measured: the caret (#3b86f7 light / #3f8ff7 dark, 1.5 wide × 15 tall at x 60.75–62.25, spanning
 * 8 to 23 inside the field) and the placeholder, which reads "Message" while focused. Unverified: the
 * unfocused field, since no capture holds one, so "iMessage" and any change the rim makes when the
 * window stops being key are invented. The caret is the browser's own: 1 CSS px wide against native's
 * 1.5, as tall as the line box (14.70 here, against a measured 15), and headless Chromium paints no
 * caret at all, so it is the one part of the focused field a screenshot in this repo cannot check.
 *
 * ## Hover and press
 *
 * **Unverified, all of it.** Every macOS capture in this repo holds these buttons at rest with no
 * pointer over them - `composer-empty-and-typed-dark.png`, `conversation-pane-dark.png`,
 * `conversation-pane-dark-2.png`, `conversation-pane-light.png`, `conversation-pane-light-partial.png`
 * - so neither the hover fill this file already carried nor the pressed one below is measured, and
 * ChatKit has nothing either: its whole selector table holds exactly two touch-state numbers
 * (`replyButtonTouchAlpha` 0.4, `replyButtonTouchScale` 0.85, identical at idiom 0 and idiom 5) and
 * no hover or pressed *fill* for a Mac control at all.
 *
 * What is not invented is the shape of it: the pressed fill continues the rest -> hover step by the
 * same amount again, in the same direction, rather than picking a third colour out of the air.
 * Light #ffffff -> #f4f4f4 -> #e9e9e9 (-11 a step); dark #232323 -> #2c2c2c -> #353535 (+9 a step).
 * A pointer that leaves a held button drops the press, and one that comes back picks it up again,
 * which is what AppKit does. It falls back to the *hover* fill rather than the rest one while it is
 * away, because Chrome keeps `:hover` on the element that captured the pointer; that is the browser's
 * retarget, not a decision here.
 *
 * The waveform button inside the field has no fill to change, so it dims instead, and that one number
 * *is* ChatKit's: `replyButtonTouchAlpha` = 0.4, read off `CKUIBehaviorMac` at idiom 5 (where it
 * agrees with the phone). Borrowed from a different button - it is the only touch alpha the framework
 * records.
 *
 * `press` is **unmeasured**: nothing in this repo records one of these buttons in motion. The fill
 * lands on the frame the mouse goes down and eases back over 100 ms, which is a hover-length fade.
 */
export const macComposerMetrics = {
  bottom: 11,
  plus: { left: 9, size: 30 },
  field: { left: 49, width: 530, height: 31, paddingLeft: 12, paddingRight: 34, fontSize: 13, letterSpacing: -0.4, lineHeight: 14.7, paddingTop: 8.15, placeholderIndent: 2.5 },
  waveform: { centerFromRight: 19.5, centerY: 15.5, hit: 24, nudge: 0.5 },
  emoji: { left: 589, size: 30 },
  /** Height change. Unverified: borrowed from `macPlusMenuMetrics.motion`, see the note above. */
  motion: { grow: 160, growEase: "cubic-bezier(0.32, 0.72, 0, 1)" },
  /** Hover and press. Unverified except `touchAlpha`, which is ChatKit's; see "Hover and press" above. */
  press: { release: 100, touchAlpha: 0.4 },
};

/**
 * Press state that a mouse, a finger and the keyboard all reach.
 *
 * Pointer events rather than `:active`, because `:active` is a browser heuristic this component
 * cannot drive or prove: Chrome holds it back on a touch until the gesture has resolved into a tap
 * rather than a scroll. The pointer is captured so the release always lands back here, and while it
 * is held the press follows the pointer in and out of the button's own box, which is what AppKit does
 * when the mouse slides off a held button and back onto it. Driven with a real `page.mouse`, holding
 * the "+" and dragging 80 px away steps its fill #f4f4f4 -> #e9e9e9 -> #f4f4f4 -> #e9e9e9 on the way
 * back out and in. (On a touchscreen it is one-way: Chromium fires `pointercancel` as soon as the
 * finger pans, so a touch that leaves a control never returns to it.)
 *
 * Nothing here moves focus, deliberately: both engines match `:focus-visible` on a programmatic focus
 * taken while a pointer is still down, so a press opened by a pointer would draw the accent ring that
 * `composer-empty-and-typed-dark.png` shows the native composer does not draw
 * (`tapback-bar.tsx` and `audio-recorder.tsx` carry the two fixes for the places that must move focus).
 */
function usePress() {
  const [pressed, setPressed] = useState(false);
  const held = useRef(false);
  const release = () => { held.current = false; setPressed(false); };
  return {
    pressed,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        held.current = true;
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the pointer ended before this handler ran */ }
        setPressed(true);
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        if (!held.current) return;
        const box = event.currentTarget.getBoundingClientRect();
        setPressed(event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom);
      },
      onPointerUp: release,
      onPointerCancel: release,
      onLostPointerCapture: release,
      onKeyDown(event: KeyboardEvent<HTMLElement>) { if (event.key === " " || event.key === "Enter") setPressed(true); },
      onKeyUp: release,
      onBlur: release,
    },
  };
}

/** The field's height with `lines` lines of text: the measured 31 for one, plus the 14.70 line pitch. */
export function macComposerFieldHeight(lines: number) {
  const f = macComposerMetrics.field;
  return f.height + (Math.max(1, lines) - 1) * f.lineHeight;
}

/** Padding the field keeps above and below its text, whatever it grows to: 31 − 14.70. */
const fieldPaddingY = macComposerMetrics.field.height - macComposerMetrics.field.lineHeight;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

const reducedMotionQuery = () => (typeof window === "undefined" ? null : window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null);
function subscribeReducedMotion(onChange: () => void) {
  const query = reducedMotionQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}
/**
 * True when the viewer asked for less motion; false while server rendering. `macos-plus-menu.tsx` has
 * the same hook, and this file keeps its own copy so the composer stays a registry item with no
 * dependency of its own.
 */
function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, () => reducedMotionQuery()?.matches ?? false, () => false);
}

export type MacComposerProps = Omit<ComponentProps<"form">, "onSubmit" | "onChange" | "defaultValue"> & {
  onSend: (message: string) => void | Promise<void>;
  onChange?: (value: string) => void;
  value?: string;
  defaultValue?: string;
  /** Shown while the field is not focused (native: the service name). */
  placeholder?: string;
  /** Shown while the field is focused. */
  focusedPlaceholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  onAttach?: () => void;
  /** Whether the attachments popover (`MacPlusMenu`) is open; sets the "+" button's aria-expanded. */
  attachExpanded?: boolean;
  onEmoji?: () => void;
  onAudio?: () => void;
  /** Widest the field may grow (px). Defaults to the measured 530. */
  fieldWidth?: number;
  /** Tallest the field grows before its text scrolls, in lines. Unverified: no capture holds a ceiling. */
  maxLines?: number;
  /**
   * Seek the field's height change to this fraction (0..1) instead of playing it, which is what the
   * harness does: the field starts at `fromLines` lines and lands on the height the current text needs.
   * A seeked frame at 1 is the settled layout, so a checkpoint renders the same on every run.
   */
  grow?: { fromLines: number; progress: number };
};

export function MacComposer({ onSend, onChange, value, defaultValue = "", placeholder = "Message", focusedPlaceholder = "Message", autoFocus = false, disabled = false, onAttach, attachExpanded, onEmoji, onAudio, fieldWidth, maxLines = 9, grow, className, style, ...props }: MacComposerProps) {
  const m = macComposerMetrics;
  const [draft, setDraft] = useState(defaultValue);
  const [focused, setFocused] = useState(autoFocus);
  /** `null` until the first measurement: the field is laid out by its own content until then. */
  const [lines, setLines] = useState<number | null>(null);
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const field = useRef<HTMLDivElement>(null);
  /** The line count the field is laid out at, so the next change knows where it is growing from. */
  const laidOut = useRef<number | null>(null);
  /** Height a height change was interrupted at, so a second one carries on from it instead of jumping back. */
  const interrupted = useRef<number | null>(null);
  const reduced = usePrefersReducedMotion();
  const attachPress = usePress();
  const emojiPress = usePress();
  const audioPress = usePress();
  const id = useId();
  const text = value ?? draft;
  const width = fieldWidth ?? m.field.width;
  const height = lines === null ? undefined : macComposerFieldHeight(lines);

  /**
   * The field is laid out at the height its text needs. `field-sizing: content` already grows the
   * textarea itself, so this reads that back and snaps it to a whole number of lines: `scrollHeight`
   * is an integer, and the field's height has to land on the 14.70 pitch exactly, not on 46 for what
   * is really 45.70. Until it has run the field takes its height from that same textarea, so a
   * composer that mounts with a draft in it is the right height on its first paint, not one line tall.
   */
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    setLines(Math.max(1, Math.min(maxLines, Math.round((el.scrollHeight - fieldPaddingY) / m.field.lineHeight))));
  }, [text, width, maxLines, m.field.lineHeight]);

  /**
   * The height change itself. It is a transient override of the layout above (no `fill`), so the end
   * of it is the settled field rather than a copy of it, and a cancelled one leaves nothing behind.
   */
  const growFrom = grow?.fromLines;
  const growProgress = grow?.progress;
  useLayoutEffect(() => {
    const element = field.current;
    if (lines === null) return;
    // The commit that turns the first measurement into a height is the composer's layout, not a
    // growth: `laidOut` is still null there and the field was already the right height without it.
    // A scrubbed `grow` is the exception, since the harness mounts a fresh page at every checkpoint.
    const from = growFrom ?? laidOut.current;
    laidOut.current = lines;
    if (!element || reduced || from === null || from === lines) return;
    // The text is already laid out at its full height while the box is still opening, so the box has
    // to clip it, and `items-end` keeps the newest line against the bottom edge with the older ones
    // sliding out from behind the top one. It clips only while the height is moving: `playSendAnimation`
    // draws its bubble-shaped ghost inside this same field, and that ghost's tail hangs below the
    // field's bottom edge on purpose.
    element.style.overflow = "hidden";
    const clear = () => { element.style.overflow = ""; };
    // A line that lands while an earlier one is still opening starts from the height on screen, not
    // from the one it was heading for, so a fast typist never sees the box step backwards. A seeked
    // `grow` ignores that and always starts at `fromLines`: a checkpoint has no history to carry.
    const start = growFrom !== undefined ? macComposerFieldHeight(growFrom) : (interrupted.current ?? macComposerFieldHeight(from));
    interrupted.current = null;
    const animation = element.animate(
      [{ height: `${start}px` }, { height: `${macComposerFieldHeight(lines)}px` }],
      { duration: m.motion.grow, easing: m.motion.growEase },
    );
    animation.finished.then(clear, () => undefined);
    if (growProgress !== undefined) {
      // Seeked, not played: a scrubbed checkpoint has to land on the same frame every run.
      animation.pause();
      animation.currentTime = clamp01(growProgress) * m.motion.grow;
    }
    return () => {
      // While it is still running the animation owns the computed height, so this reads the pose the
      // field is actually in; once it has finished the height is the settled one and there is nothing
      // to carry over.
      interrupted.current = animation.playState === "running" ? parseFloat(getComputedStyle(element).height) : null;
      animation.cancel();
      clear();
    };
  }, [lines, growFrom, growProgress, reduced, m.motion.grow, m.motion.growEase]);

  function update(next: string) {
    if (value === undefined) setDraft(next);
    onChange?.(next);
  }
  async function send() {
    const message = text.trim();
    if (!message || disabled || composing.current) return;
    await onSend(message);
    update("");
    requestAnimationFrame(() => textarea.current?.focus());
  }

  /**
   * Hover is a class, press is an inline `backgroundColor`. Not a style choice: `hover:` and a
   * `data-pressed:` variant carry the same specificity, so which one won a held pointer that is also
   * over the button would come down to the order Tailwind happened to emit them in. An inline
   * declaration beats both, every build.
   */
  const glass = "absolute block rounded-full bg-[var(--cp-button)] p-0 text-[var(--cp-ink)] shadow-[var(--cp-shadow)] outline-offset-2 transition-colors ease-out hover:bg-[var(--cp-button-hover)] focus-visible:outline-2 focus-visible:outline-[#3478f6] disabled:opacity-50 motion-reduce:transition-none";
  const pressFill = (pressed: boolean) => ({ transitionDuration: `${m.press.release}ms`, backgroundColor: pressed ? "var(--cp-button-pressed)" : undefined });

  return (
    <form
      data-slot="mac-composer"
      aria-label="Send a message"
      onSubmit={event => { event.preventDefault(); void send(); }}
      className={cn(
        "absolute inset-x-0 bottom-0 select-none",
        "[--cp-button-hover:#f4f4f4] [--cp-button-pressed:#e9e9e9] [--cp-button:#ffffff] [--cp-caret:#3b86f7] [--cp-face-fill:transparent] [--cp-face-ink:#000000] [--cp-face-stroke:#000000] [--cp-field:#ffffff] [--cp-ink:#000000] [--cp-placeholder:#bdbdbd] [--cp-shadow:0_5px_25px_rgba(0,0,0,0.07)] [--cp-text:#262626] [--cp-wave:#999999]",
        "dark:[--cp-button-hover:#2c2c2c] dark:[--cp-button-pressed:#353535] dark:[--cp-button:#232323] dark:[--cp-caret:#3f8ff7] dark:[--cp-face-fill:#f4f4f4] dark:[--cp-face-ink:#232323] dark:[--cp-face-stroke:#f4f4f4] dark:[--cp-field:#232323] dark:[--cp-ink:#f1f1f1] dark:[--cp-placeholder:#626262] dark:[--cp-shadow:inset_0.774px_0.774px_0_0_#424242,inset_-0.774px_-0.774px_0_0_#424242,0_5px_25px_rgba(0,0,0,0.05)] dark:[--cp-text:#dddddd] dark:[--cp-wave:#858585]",
        className,
      )}
      style={{ height: m.bottom + (height ?? m.field.height) + 10, fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif", ...style }}
      {...props}
    >
      <button type="button" data-slot="attach-button" aria-label="Add attachment" aria-haspopup="menu" aria-expanded={attachExpanded} disabled={disabled} onClick={onAttach}
        data-pressed={attachPress.pressed || undefined} {...attachPress.handlers}
        className={glass} style={{ left: m.plus.left, bottom: m.bottom, width: m.plus.size, height: m.plus.size, ...pressFill(attachPress.pressed) }}>
        <svg aria-hidden="true" viewBox="0 0 30 30" width="30" height="30" className="block" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          {/* 12.58 of ink including the 0.85 cap radius at each end, so each arm is 10.88 of path.
              Measured on the stroke axis: a row even 0.8 px off centre reads 12.3 because the caps taper. */}
          <path d="M14.8 9.74v10.88M9.36 15.2h10.88" />
        </svg>
      </button>

      {/* No overflow rule here: the height animation adds one for as long as it runs (see above), and
          at rest the field has to let the send animation's ghost tail hang past its bottom edge. */}
      <div data-slot="field" ref={field} data-lines={lines ?? undefined} className="absolute flex items-end bg-[var(--cp-field)] shadow-[var(--cp-shadow)]"
        style={{ left: m.field.left, bottom: m.bottom, width, height, minHeight: m.field.height, borderRadius: m.field.height / 2 }}>
        <label htmlFor={id} className="sr-only">Message</label>
        <textarea
          ref={textarea}
          id={id}
          rows={1}
          value={text}
          disabled={disabled}
          autoFocus={autoFocus}
          placeholder={focused ? focusedPlaceholder : placeholder}
          onChange={event => update(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); void send(); }
          }}
          className="m-0 block w-full resize-none border-0 bg-transparent p-0 text-[var(--cp-text)] outline-none [field-sizing:content] placeholder:text-[var(--cp-placeholder)] placeholder:[text-indent:var(--cp-placeholder-indent)] disabled:opacity-50"
          style={{
            "--cp-placeholder-indent": `${m.field.placeholderIndent}px`,
            fontSize: m.field.fontSize, lineHeight: `${m.field.lineHeight}px`, letterSpacing: m.field.letterSpacing, caretColor: "var(--cp-caret)",
            paddingTop: m.field.paddingTop, paddingBottom: m.field.height - m.field.lineHeight - m.field.paddingTop,
            paddingLeft: m.field.paddingLeft, paddingRight: m.field.paddingRight, maxHeight: fieldPaddingY + maxLines * m.field.lineHeight, overflowY: "auto",
          } as CSSProperties}
        />
        {!text && (
          <button type="button" data-slot="audio-button" aria-label="Record audio message" disabled={disabled} onClick={onAudio}
            data-pressed={audioPress.pressed || undefined} {...audioPress.handlers}
            className="absolute block rounded-[6px] p-0 text-[var(--cp-wave)] outline-offset-2 transition-opacity ease-out focus-visible:outline-2 focus-visible:outline-[#3478f6] data-pressed:transition-none motion-reduce:transition-none"
            // Chrome snaps a positioned box to whole px but honours a transform exactly, so the offsets stay
            // integers (right 8, bottom 4) and the transform carries the half-pixel that lands the measured
            // centre. It hangs off the bottom, not the top, so it stays on the field's last line when the
            // field is taller than one (it is hidden while text exists, so that only shows during a shrink).
            // It has no fill to change, so it dims: ChatKit's `replyButtonTouchAlpha`, borrowed (see "Hover and press").
            style={{ right: m.waveform.centerFromRight - m.waveform.hit / 2 + m.waveform.nudge, bottom: m.field.height - m.waveform.centerY - m.waveform.hit / 2 + m.waveform.nudge, width: m.waveform.hit, height: m.waveform.hit, transform: `translate(${m.waveform.nudge}px, ${m.waveform.nudge}px)`, transitionDuration: `${m.press.release}ms`, opacity: audioPress.pressed ? m.press.touchAlpha : undefined }}>
            {/* Five stadium bars, widths and heights measured one by one; the outer pair sits 7.305 out, the
                inner pair 3.595. They ink 0.09–0.13 short of native and a taller box cannot fix it: Chrome
                snaps an SVG extent to the half device pixel (see the note at the top of this file). */}
            <svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" className="block" fill="currentColor">
              <rect x="3.895" y="10.115" width="1.6" height="3.77" rx="0.8" />
              <rect x="7.505" y="8.5" width="1.8" height="7" rx="0.9" />
              <rect x="11" y="4.765" width="2" height="14.47" rx="1" />
              <rect x="14.695" y="8.5" width="1.8" height="7" rx="0.9" />
              <rect x="18.505" y="10.115" width="1.6" height="3.77" rx="0.8" />
            </svg>
          </button>
        )}
      </div>

      <button type="button" data-slot="emoji-button" aria-label="Emoji" disabled={disabled} onClick={onEmoji}
        data-pressed={emojiPress.pressed || undefined} {...emojiPress.handlers}
        className={glass} style={{ left: m.emoji.left, bottom: m.bottom, width: m.emoji.size, height: m.emoji.size, ...pressFill(emojiPress.pressed) }}>
        {/* The glyph sits 0.2 left of and 0.2 below the button's centre, the same offset the "+" carries. */}
        <svg aria-hidden="true" viewBox="0 0 30 30" width="30" height="30" className="block">
          <circle cx="14.79" cy="15.2" r="7.11" fill="var(--cp-face-fill)" stroke="var(--cp-face-stroke)" strokeWidth="1.35" />
          <circle cx="12.54" cy="13.42" r="0.99" fill="var(--cp-face-ink)" />
          <circle cx="17.06" cy="13.42" r="0.99" fill="var(--cp-face-ink)" />
          <path d="M9.8 15.65q5.02 1.3 10.04 0a5.02 4.71 0 0 1-10.04 0Z" fill="var(--cp-face-ink)" />
          <path d="M11.315 17.15q3.505 0.89 7.01 0" fill="none" strokeWidth="0.94" strokeLinecap="round" stroke="var(--cp-face-fill)" className="[stroke:#ffffff] dark:[stroke:var(--cp-face-fill)]" />
        </svg>
      </button>
    </form>
  );
}
