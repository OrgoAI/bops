"use client";

import { useId, useLayoutEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * iOS 26 composer row, measured from `references/ios/captures/conv3-light.png`, `conv2-dark.png`,
 * `paste-check.png` and `newmsg-typed-disabled-send-light.png` (402pt screen). The row hugs the
 * bottom of the screen with 28pt margins, and both surfaces rest their bottom edge on y 846:
 *
 * - `+` glass circle Ø40 centered (48, 826), so its top edge is y 806. Glyph ink 15.33 square, and
 *   its bar integrates to 4.99 device px of coverage, i.e. 1.66 of stroke. The 1.6 drawn below
 *   rasterizes to the same 4.99, so the glyph lands on the capture pixel for pixel.
 * - Field x 80–374. It is **40.33** tall for one line, not 40: in `conv2-dark.png` its rim starts a
 *   device pixel above the `+` button's (y 805.67 against 806) while both end at 846. Each extra
 *   line adds exactly 20 (`newmsg-typed-disabled-send-light.png` two lines = 60.33, `paste-check.png`
 *   four lines = 100.33), so the extra third of a point is a one-off at the top edge, not per line.
 *   The box is laid out at that height, but Chromium rounds a painted box edge to the whole CSS
 *   pixel, so the rim still lands on 806 on the screen. Measured every way round: a fractional
 *   border-radius, a clip-path and a composited layer all snap the same. It is the one device pixel
 *   of the composer that a browser will not draw.
 * - The field's corner is a plain **circular** radius 20, not a continuous corner. Tracing the outer
 *   edge in `conv2-dark.png` (one line) and `paste-check.png` (four lines) and fitting a browser
 *   render to it: `corner-shape: round` sits within 0.06pt of native, `superellipse(1.14)` cuts the
 *   corner 0.55–0.78pt too tight all the way down it. At one line the field is a capsule anyway.
 * - Text 17pt on a 20pt line, 10 top and bottom over a 16pt left inset (placeholder ink x 97–167.67,
 *   ink top 819.33 in `conv3-light.png`, matched to the pixel). Caret #0088ff light / #0091ff dark.
 * - Mic: ink 11.87 × 17.85 at x 346.85–358.72, y 816.95–834.8 (capsule 6.03 × 11.65, U 11.87 across,
 *   every stroke 1.25). Colour #b4b8bf light / #636466 dark. It has its own outline rather than
 *   reusing `IosMicIcon`, which is the heavier weight the conversation list's search pill draws.
 * - Send pill 38×28 #0088ff, its right edge 6.33 in from the field's right edge and its bottom 6
 *   above the field's bottom, in a two-line and a four-line field alike, so it is bottom-anchored.
 *   White arrow: 2.41 stroke, apex (348.33, 819), arms out to ±5.88, stem down to y 832.7. The path
 *   is drawn a sixth of a point left and a third down of those, which is what lands the rendered ink
 *   on the capture: the pill's own box starts at x 329.67 and the browser rasterizes the SVG from a
 *   rounded origin.
 * - Glass: 90% white with a backdrop blur and a soft shadow (light), #191919 with a 1pt rim (dark);
 *   shadows are painted on a layer beneath both surfaces and clipped at the midpoint of the 12pt
 *   gap, so the field never shades the `+` button.
 *
 * All four buttons respond to a finger - they dim and shrink. Neither number is in the captures; see
 * `iosComposerPress` for where they come from and what is borrowed.
 *
 * Not measured: `maxLines` (no capture holds a field taller than four lines) and the gray send pill
 * a composer with no recipient shows (#ededee with a #b8b8bb arrow in
 * `newmsg-typed-disabled-send-light.png`), which this component does not render.
 */
export type IosComposerProps = Omit<ComponentProps<"form">, "onSubmit" | "onChange" | "defaultValue"> & {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onSend?: (message: string) => void | Promise<void>;
  /** Show Send when attachments are ready, even without a text caption. */
  hasAttachments?: boolean;
  onAttach?: () => void;
  /** Whether the attachments sheet (`IosPlusMenu`) is open; sets the `+` button's aria-expanded. */
  attachExpanded?: boolean;
  onMic?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /**
   * The screen has an editing session open - a caret is somewhere, the keyboard is up. iOS lifts the
   * composer while that is true: the field fills a shade darker and the shadow under it strengthens.
   * See `composerLift`.
   */
  raised?: boolean;
  /** Tallest the field grows before it scrolls, in lines. */
  maxLines?: number;
};

const font = "-apple-system, BlinkMacSystemFont, sans-serif";
const LINE = 20;
const PAD_Y = 10;
/** The field's top edge sits a device pixel above the `+` button's, so one line is 40.33 and not 40. */
const TOP_EDGE = 1 / 3;

const vars =
  "[--ios-cmp-glass:rgba(255,255,255,0.9)] [--ios-cmp-rim:none] [--ios-cmp-shadow:0_6px_36px_4px_rgba(0,0,0,0.065)] [--ios-cmp-shadow-round:0_5px_20px_6px_rgba(0,0,0,0.055)] [--ios-cmp-glyph:#1a1919] [--ios-cmp-text:#000000] [--ios-cmp-placeholder:#bdbdbd] [--ios-cmp-mic:#b4b8bf] [--ios-cmp-caret:#0088ff] " +
  "dark:[--ios-cmp-glass:rgba(28,28,28,0.9)] dark:[--ios-cmp-rim:inset_0_0_0_1px_rgba(255,255,255,0.09)] dark:[--ios-cmp-shadow:none] dark:[--ios-cmp-shadow-round:none] dark:[--ios-cmp-glyph:#f4f3f4] dark:[--ios-cmp-text:#ffffff] dark:[--ios-cmp-placeholder:#5d5d5d] dark:[--ios-cmp-mic:#636466] dark:[--ios-cmp-caret:#0091ff]";

/**
 * The composer fills a shade darker while an editing session is open, and the captures separate that
 * cleanly from everything else it might have been confused with.
 *
 * `conv3-light.png` and `list-light.png` - no caret anywhere on the screen - have the field at 255.
 * `paste-check.png` has a caret in the composer and `newmsg-light.png` has one in the To: field
 * while its own composer sits empty and unfocused; both read 253. So the trigger is the session, not
 * a full field and not composer focus. Both were shot on a simulator with a hardware keyboard, which
 * is why no software keyboard gives it away.
 *
 * The shadow is **not** part of this, which took three captures to establish. Measuring the darkness
 * below the composer's bottom edge at 0, 2.7, 5.3 … 24 pt: conv3, list and newmsg all read
 * 11, 10, 9, 8, 7, 6, 5, 4, and only `paste-check` reads 18, 17, 15, 13, 12, 10, 8, 7 - the same
 * curve scaled by 1.601 (least squares over 28,969 pixels). What is different about paste-check is
 * that its field is four lines tall, so the extra shadow follows the box's height rather than the
 * session. A CSS `box-shadow` does grow with its box, but not by nearly that much; closing the
 * remainder needs a capture of a two-line composer to tell a height law from a step.
 */
const composerLift = "[--ios-cmp-glass:rgba(253,253,253,0.9)]";

/**
 * What a finger does to the four buttons on this row.
 *
 * **Borrowed, not measured.** No capture in this repo holds a pressed control, so the two numbers
 * come from ChatKit, and they are the only two it has: grepping the framework's whole selector table
 * for `touchAlpha|touchScale|pressedAlpha|pressedScale|highlightAlpha|highlightScale|dimAlpha|
 * touchDownAlpha|touchDownScale` returns `replyButtonTouchAlpha` = 0.4 and `replyButtonTouchScale`
 * = 0.85 and nothing else. Read at both idioms with the swizzle in place, `CKUIBehaviorPhone`
 * (idiom 0) and `CKUIBehaviorMac` (idiom 5) agree on both.
 *
 * They belong to a different button, but to the nearest one ChatKit records: the reply button is
 * itself a blurred glass pill (`replyButtonBackgroundBlurRadius` 5, `replyButtonBorderWidth` 0.5),
 * and ChatKit applies both to the whole view on `_buttonTouchDown`, which is what the `+` circle here
 * is. iOS 26 renders the pressed state of a `glassButtonConfiguration` button in UIKit, not in
 * ChatKit, so there is no closer number to find.
 *
 * The dim rides on the button's own opacity, so it comes off the **measured glass already on the
 * element** - `--ios-cmp-glass` and its shadow and rim fade together - rather than off a second
 * pressed fill that no capture pins. What ChatKit does record about this row corroborates the rest:
 * `_entryViewButtonTintColor` reads #B4B8BF light, the mic colour measured from `conv3-light.png`.
 *
 * `release` is **unmeasured** - nothing in this repo records a control in motion. Press-down is
 * instant, which is what a direct-manipulation highlight is; only the release eases back.
 */
export const iosComposerPress = { alpha: 0.4, scale: 0.85, release: 100 };

/**
 * Press state that a finger, a mouse and the keyboard all reach.
 *
 * Pointer events rather than `:active`: Chrome holds `:active` back on a touch until the gesture has
 * resolved into a tap rather than a scroll, so a finger that is still down is not reliably styled and
 * a driven `Input.dispatchTouchEvent` hold cannot be proved. The pointer is captured so the release
 * always lands back here, and while it is held the press follows the pointer out of the button's own
 * box, which is what iOS does when a finger slides off a control.
 *
 * A finger that slides off does not come back, and that is Chromium rather than this hook: driving a
 * real touch 60 px off the `+` logs `pointerdown -> pointermove(outside) -> touchmove ->
 * pointercancel -> lostpointercapture`, i.e. gesture arbitration takes the pointer away the moment
 * the finger pans, and the touchmove back onto the control delivers no pointer event at all. A mouse
 * keeps its pointer, so dragging off a held button drops the press and dragging back on takes it up
 * again.
 *
 * Nothing here moves focus, deliberately: both engines match `:focus-visible` on a programmatic focus
 * taken while a pointer is still down, so a press opened by a finger would draw a ring iOS never
 * draws (`tapback-bar.tsx` and `audio-recorder.tsx` carry the two fixes for the places that do have
 * to move focus). `send()` still returns the caret to the field afterwards, but that runs a frame
 * after the finger has already lifted.
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

/** Instant down, eased back up; `data-pressed` turns the transition off so the dim lands on the frame the finger does. */
const pressTransition = "transition-[opacity,transform] ease-out data-pressed:transition-none motion-reduce:transition-none";

/** The pressed pose, or nothing at all at rest so a settled composer renders byte for byte as before. */
function pressStyle(pressed: boolean) {
  return { transitionDuration: `${iosComposerPress.release}ms`, opacity: pressed ? iosComposerPress.alpha : undefined, transform: pressed ? `scale(${iosComposerPress.scale})` : undefined };
}

/** `clip` stops the shadow at the midpoint of the 12pt gap toward a neighboring glass element, so the two shadows read as one (they never add up on the device). */
function GlassLayers({ round = false, clip }: { round?: boolean; clip?: "left" | "right" }) {
  return (
    <>
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 rounded-[inherit]" style={{ boxShadow: round ? "var(--ios-cmp-shadow-round)" : "var(--ios-cmp-shadow)", clipPath: clip ? `inset(-60px ${clip === "right" ? "-6px" : "-60px"} -60px ${clip === "left" ? "-6px" : "-60px"})` : undefined }} />
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit]" style={{ background: "var(--ios-cmp-glass)", boxShadow: "var(--ios-cmp-rim)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }} />
    </>
  );
}

/**
 * SF "mic" as the conversation list's search pill draws it: a heavier weight than the composer's,
 * 1.60 of stroke on 18.33 of ink. Kept for `ios-conversation-list.tsx`, which is the only caller.
 */
export function IosMicIcon({ width = 12, height = 17.6667, color = "currentColor" }: { width?: number; height?: number; color?: string }) {
  return (
    <svg aria-hidden="true" width={width} height={height} viewBox="0 0 12 17.6667" fill="none" stroke={color} strokeLinecap="round">
      <rect x="3.6667" y="0.6667" width="4.6667" height="10.3333" rx="2.3333" strokeWidth="1.3333" />
      <path d="M0.75 6.3333V8.83A5.08 5.08 0 0 0 10.92 8.83V6.3333" strokeWidth="1.5" />
      <path d="M5.83 14.5V16.3" strokeWidth="1.5" />
      <path d="M2.3 16.9H9.4" strokeWidth="1.3333" />
    </svg>
  );
}

/**
 * The composer's mic, traced separately from `conv3-light.png` at 3x because iOS draws the symbol
 * lighter here than in the search pill: capsule 6.03 × 11.65, U 11.87 across, base bar 8.62, every
 * stroke 1.25. The viewBox is the ink box. One shared outline cannot serve both: drawing the
 * composer with the pill's leaves 81 mismatched pixels here against `conv3-light.png` where this
 * one leaves 0, and drawing the pill with this one takes its own 30pt window from 21 to 26.
 */
function ComposerMicIcon() {
  return (
    <svg aria-hidden="true" width="11.87" height="17.85" viewBox="0 0 11.87 17.85" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
      <rect x="3.535" y="0.625" width="4.78" height="10.4" rx="2.39" />
      <path d="M0.625 7.23V9.02A5.31 5.31 0 0 0 11.245 9.02V7.23" />
      <path d="M5.935 14.33V17.225" />
      <path d="M2.24 17.225H9.61" />
    </svg>
  );
}

export function IosComposer({
  value, defaultValue = "", onChange, onSend, hasAttachments = false, onAttach, attachExpanded, onMic, placeholder = "Message", disabled = false, raised = false, maxLines = 8, className, style, ...props
}: IosComposerProps) {
  const [draft, setDraft] = useState(defaultValue);
  const text = value ?? draft;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const sending = useRef(false);
  const id = useId();
  const hasText = text.trim().length > 0;
  const attach = usePress();
  const mic = usePress();
  const sendPress = usePress();

  function update(next: string) {
    if (value === undefined) setDraft(next);
    onChange?.(next);
  }

  // Grow with the content, one 20pt line at a time, up to `maxLines`.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "0px";
    const max = maxLines * LINE + PAD_Y * 2;
    const next = Math.max(LINE + PAD_Y * 2, Math.min(el.scrollHeight, max));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text, maxLines]);

  async function send() {
    const message = text.trim();
    if ((!message && !hasAttachments) || disabled || sending.current || composing.current) return;
    sending.current = true;
    try {
      await onSend?.(message);
      update("");
    } finally {
      sending.current = false;
      requestAnimationFrame(() => textarea.current?.focus());
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
    event.preventDefault();
    void send();
  }

  return (
    <form data-slot="ios-composer" data-raised={raised || undefined} aria-label="Send a message" className={cn("relative isolate flex w-full items-end select-none", vars, raised && composerLift, className)}
      style={{ padding: "0 28px 28px 28px", fontFamily: font, ...style }} onSubmit={event => { event.preventDefault(); void send(); }} {...props}>
      <button type="button" data-slot="attach" aria-label="Add attachment" aria-haspopup="menu" aria-expanded={attachExpanded} disabled={disabled} onClick={onAttach}
        data-pressed={attach.pressed || undefined} {...attach.handlers}
        className={cn("relative flex shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50", pressTransition)}
        style={{ width: 40, height: 40, ...pressStyle(attach.pressed) }}>
        <GlassLayers round clip="right" />
        <svg aria-hidden="true" className="relative" width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="var(--ios-cmp-glyph)" strokeWidth="1.6" strokeLinecap="round">
          <path d="M13.1 20H26.9M20 13.1V26.9" />
        </svg>
      </button>
      <div data-slot="field" className="relative min-w-0 flex-1" style={{ marginLeft: 12, paddingTop: TOP_EDGE, minHeight: LINE + PAD_Y * 2 + TOP_EDGE, borderRadius: 20 }}>
        <GlassLayers clip="left" />
        <label htmlFor={id} className="sr-only">Message</label>
        <textarea ref={textarea} id={id} rows={1} value={text} disabled={disabled} placeholder={placeholder}
          onChange={event => update(event.target.value)} onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          className="relative block w-full resize-none border-0 bg-transparent outline-none select-text placeholder:text-[var(--ios-cmp-placeholder)]"
          style={{ padding: `${PAD_Y}px 48px ${PAD_Y}px 16px`, fontFamily: font, fontSize: 17, lineHeight: `${LINE}px`, letterSpacing: 0, color: "var(--ios-cmp-text)", caretColor: "var(--ios-cmp-caret)", boxSizing: "border-box", margin: 0 }} />
        {hasText || hasAttachments ? (
          <button type="submit" data-slot="send" aria-label="Send message" disabled={disabled}
            data-pressed={sendPress.pressed || undefined} {...sendPress.handlers}
            className={cn("absolute flex items-center justify-center rounded-full bg-[#0088ff] text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500", pressTransition)}
            style={{ right: 6.3333, bottom: 6, width: 38, height: 28, ...pressStyle(sendPress.pressed) }}>
            <svg aria-hidden="true" width="38" height="28" viewBox="0 0 38 28" fill="none" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.6333 12.6667 18.5 7.3333 24.3667 12.6667M18.5 7.3333V20.7" />
            </svg>
          </button>
        ) : (
          <button type="button" data-slot="mic" aria-label="Record audio message" disabled={disabled} onClick={onMic}
            data-pressed={mic.pressed || undefined} {...mic.handlers}
            className={cn("absolute flex items-center justify-center focus-visible:outline-2 focus-visible:outline-blue-500", pressTransition)}
            /* 20×26 hit box; the insets centre the 11.87×17.85 glyph on its measured ink, x 346.85–358.72 and y 816.95–834.8 in a one-line field. */
            style={{ right: 11.22, bottom: 7.13, width: 20, height: 26, color: "var(--ios-cmp-mic)", ...pressStyle(mic.pressed) }}>
            <ComposerMicIcon />
          </button>
        )}
      </div>
    </form>
  );
}
