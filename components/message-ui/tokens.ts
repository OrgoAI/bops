import type { Platform } from "@/components/message-ui/platform";

/**
 * Measured design tokens (see references/SPEC.md). Points equal CSS px.
 * Colors that vary with vertical screen position are expressed as top/bottom pairs of a
 * screen-space linear gradient; `screenHeight` is the reference height they were measured on.
 */
export type Service = "imessage" | "sms";
export type Direction = "incoming" | "outgoing";

export type BubbleMetrics = {
  fontSize: number;
  lineHeight: number;
  paddingX: number;
  paddingY: number;
  radius: number;
  minWidth: number;
  /** Widest bubble in px (iOS uses a fixed width at 402pt screens). */
  maxWidth: number;
  /** Fraction of the message pane width a bubble may occupy (macOS). */
  maxWidthRatio: number;
  /** Scale applied to the traced iOS tail (1 on iOS, 0.7 on macOS). */
  tailScale: number;
  /** Gap between consecutive bubbles of the same group, and between groups. */
  gapInGroup: number;
  gapBetweenGroups: number;
  /** Inset from the pane edge on the bubble's own side. */
  edgeInset: number;
  /** Whether every bubble gets a tail. Both platforms only tail the last bubble of a cluster. */
  tailOnEveryBubble: boolean;
  /** Status label ("Delivered") typography and offsets. Always semibold. */
  statusFontSize: number;
  statusLineHeight: number;
  statusLetterSpacing: number;
  statusGap: number;
  statusInset: number;
  /** Large glyph size, line box, and edge inset for emoji-only messages. */
  emojiOnlySize: number;
  emojiOnlyLineHeight: number;
  emojiOnlyInset: number;
  /** Tracking applied to bubble text so the web's SF matches native widths. */
  letterSpacing: number;
};

export const bubbleMetrics: Record<Platform, BubbleMetrics> = {
  ios: {
    fontSize: 17,
    lineHeight: 20,
    paddingX: 13.85,
    paddingY: 10,
    /**
     * Two independent sources agree and the 19 that was here did not match either.
     *
     * Tracing the first bubble's top-right corner in `conv3-light.png` - the sub-pixel x where
     * coverage crosses 0.5, row by row for 69 rows - and least-squares fitting a circle over it
     * gives **r = 20.010**, rms 0.197. `-[CKUIBehaviorPhone balloonCornerRadius]` is **20.0107**,
     * and `CKUIBehaviorMac` inherits the same number. The shipped 19 fits the same trace at rms
     * 0.526, two and a half times worse.
     *
     * The real corner is very slightly *more* than circular: a superellipse fit lands at r 20.96,
     * n 2.14 (CSS `superellipse(1.10)`) for rms 0.142, and the measured edge is still 0.18 pt out
     * at 20 pt down where every circle has closed. That is Apple's continuous corner, and closing
     * it needs `corner-shape`, which this bubble does not use yet.
     */
    radius: 20.0107,
    minWidth: 48,
    maxWidth: 280.5,
    /** Unverified: 0.17 under `maxWidth`. `message-list` uses the ratio on iOS too, so a bubble is
     * 280.33 wide in a list and 280.5 standalone. The widest body in `conv3-light.png` measures 280.67. */
    maxWidthRatio: 280.33 / 402,
    tailScale: 1,
    gapInGroup: 4.3333,
    // 10.33 cannot reproduce the 50.000 pt step native puts between the third "V" and the long
    // bubble: solving all seven row origins at once pins this to 10.168-10.25.
    gapBetweenGroups: 10.2,
    edgeInset: 16,
    tailOnEveryBubble: false,
    statusFontSize: 11,
    statusLineHeight: 13,
    statusLetterSpacing: -0.25,
    statusGap: 4.65,
    statusInset: 20.3,
    /** Unverified: no iOS capture holds an emoji-only message. Scaled from the measured macOS 72/87.3. */
    emojiOnlySize: 58,
    emojiOnlyLineHeight: 70,
    emojiOnlyInset: 4,
    letterSpacing: 0,
  },
  macos: {
    fontSize: 13,
    lineHeight: 14.7,
    paddingX: 12.5,
    paddingY: 7.03,
    // 14.5, not 14. An arc anchored to the four-line bubble's own measured straight edges (left
    // 227.477, top 493.976 in conversation-pane-light.png) fits 25 sub-pixel rows of the top
    // corners at 0.119 rmse; r = 14 fits at 0.194 with all 25 residuals on the same side. The same
    // routine run against our own 14.5 render returns 14.42, so native's 14.39 reads as 14.46 once
    // that bias is removed. What is left at 14.5 is a symmetric S of +-0.15, twice our own render's,
    // which is the shape difference of a slightly continuous corner, not a radius error.
    //
    // ChatKit disagrees and the capture wins. `-[CKUIBehaviorMac balloonCornerRadius]`, read at
    // idiom 5, is **15.4118** - exactly the phone's 20.0107 times Catalyst's 0.77 - where the phone's
    // own 20.0107 matched an uncalibrated trace of `conv3-light.png` to three decimals. So the Mac
    // does not draw its balloon at the radius that property reports, and the calibrated 14.46 above
    // is what it actually paints. Worth knowing before anyone "fixes" this to match the framework.
    radius: 14.5,
    minWidth: 40,
    maxWidth: 382.5,
    maxWidthRatio: 0.6068,
    tailScale: 0.7,
    // Native lands every row's top on the device grid (0.5 at 2x), so a single gap reads anywhere
    // from 2.75 to 3.25. The run of six one-line bubbles in conversation-pane-dark.png settles it:
    // tops 379.5 / 411.5 / 443.0 / 475.0 / 506.5 / 538.5, a mean pitch of 31.7997 over five gaps
    // against a body height of 28.7545, so the gap is 3.045 +- 0.1. Do not re-derive it from one
    // pair of bubbles in a pane capture; those read 3.24 or 2.75 depending on the phase.
    gapInGroup: 3,
    gapBetweenGroups: 11.5,
    edgeInset: 20,
    tailOnEveryBubble: false,
    statusFontSize: 9,
    statusLineHeight: 11,
    statusLetterSpacing: 0,
    statusGap: 4,
    statusInset: 15.9,
    emojiOnlySize: 72,
    emojiOnlyLineHeight: 87.3,
    emojiOnlyInset: 4,
    letterSpacing: -0.4,
  },
};

export type ScreenGradient = { top: string; bottom: string; screenHeight: number };

export type Palette = {
  background: string;
  /** Outgoing iMessage blue, screen-space gradient. */
  imessage: ScreenGradient;
  /** Outgoing SMS green, screen-space gradient. */
  sms: ScreenGradient;
  /** Incoming gray, screen-space gradient (nearly flat). */
  incoming: ScreenGradient;
  incomingText: string;
  outgoingText: string;
  secondaryLabel: string;
  edited: string;
  /** Tapback balloon fills. */
  tapbackMine: string;
  tapbackTheirs: string;
  separator: string;
};

/**
 * iOS 26 measured: SMS green from the simulator. The blue and gray gradients are taken from macOS 26,
 * which shares Messages' palette; they are marked as such in SPEC.md until an iOS capture confirms them.
 *
 * Not measured, and not in SPEC.md either: `macos.*.sms` (no macOS capture holds a green bubble; the
 * only green in any of them is the plus-menu app icons), `macos.light.edited`, and both `ios.*.separator`
 * values. Treat them as placeholders, not as measurements.
 *
 * `macos.light` is now confirmed against a macOS light capture, not carried over from the dark one.
 * /lab/list?platform=macos&theme=light over 0 90 630 500 of conversation-pane-light.png scores 4.17%
 * with interior mean signed -0.10 (-0.4, -0.0, 0.2) and no tint. Per value, over that region:
 *   - `imessage`: the bubble fill agrees with the capture within 0.5/255 on every clean row of the ramp,
 *     device y 240 to 1140 (mean row error 0.0 to 0.5 in R and G, 0.5 in B), so both endpoints and
 *     `screenHeight: 640` are right. Rows 190-220 are the only misses and they are the capture's tapback.
 *   - `background`: #ffffff exactly, at every probe more than 31pt from the pane's leading edge.
 *   - `incoming`: the link preview fill reads (233,233,235) in the capture and in our render, every row.
 *   - `secondaryLabel`: the "Delivered" label's darkest pixel is (128,128,128) in both.
 * `bubbleMetrics.macos` holds too: `edgeInset` 20.0 on all six bubbles, `maxWidth` 382.5 on both wrapped
 * ones, line pitch 29.97/30.06 device px in the capture against 29.99/30.06 in ours.
 *
 * The 4.17% is entirely outside these files. See the report on that lab row: 30% of it is the ❤️ tapback
 * the fixture omits, the rest is glyph weight from `-webkit-font-smoothing: antialiased` in globals.css.
 */
export const palettes: Record<Platform, { light: Palette; dark: Palette }> = {
  ios: {
    light: {
      background: "#ffffff",
      /**
       * iMessage blue, from `-[CKUITheme balloonColorsForColorType:]` rather than borrowed from the
       * macOS captures, which is what this used to carry and what SPEC flagged. No iOS capture in
       * `references/` contains a blue bubble at all - the simulator's fixture chats are SMS-only, so
       * every blue in them is a tapback balloon, a button or the avatar - so the framework is the
       * only source, and three things say it is the right one:
       *
       * 1. `colorType 0` returns the SMS green, and its light top #53e678 is the value measured from
       *    `conv3-light.png` to the letter.
       * 2. Its dark top #30db5b is exactly what a fit over 1131 rows of four dark captures produced
       *    earlier today, independently and before this property was ever read.
       * 3. `colorType 1`'s light **bottom is #0088ff**, and the effects picker's preview bubble in
       *    `effects-picker-light.png` - which SPEC records as a flat #0088ff - samples (0, 136, 255).
       *
       * So these are the iOS screen-space endpoints. macOS keeps its own, which are measured: fitting
       * 530 rows of `conversation-pane-light.png` gives #7bc5f5 -> #3482f7 against the #77c7f5 ->
       * #3682f7 it ships, nowhere near this. The Mac paints a different blue from the one its own
       * `CKUIThemeMac` reports, exactly as it does with the balloon corner radius.
       */
      imessage: { top: "#5ac8fa", bottom: "#0088ff", screenHeight: 874 },
      // `balloonColorsForColorType:` 0, light. The top is the value already measured from
      // `conv3-light.png`; the bottom was fitted at #32c457 there, against this #34c759.
      sms: { top: "#53e678", bottom: "#34c759", screenHeight: 874 },
      incoming: { top: "#e9e9eb", bottom: "#e9e9eb", screenHeight: 874 },
      incomingText: "#000000",
      outgoingText: "#ffffff",
      secondaryLabel: "#8a8a8e",
      edited: "#3f8ff7",
      tapbackMine: "#0088ff",
      tapbackTheirs: "#e9e9eb",
      separator: "#c6c6c8",
    },
    dark: {
      background: "#000000",
      /** `balloonColorsForColorType:` 1, dark. See the light entry for why the framework is the source. */
      imessage: { top: "#409cff", bottom: "#0091ff", screenHeight: 874 },
      // Dark green is NOT the light ramp. Fitted over 1131 rows of core green pixels - green by a
      // wide margin, eroded by one pixel so no rim or glyph edge is in it, and with anything under
      // G 195 dropped so a bubble behind a long-press dim cannot pull it - across conv2-dark,
      // tapback-love-dark, longpress-dark and select-mode-dark: R 47.91 -> 52.42, G 218.80 ->
      // 197.39, B 90.82 -> 88.84 over the 874 pt screen, rms 0.40 / 0.53 / 0.44. Only green ramps;
      // red and blue are nearly flat and sit 35 and 30 levels below their light-mode selves at the
      // top of the screen, which is why the light ramp read washed out here.
      // `balloonColorsForColorType:` 0, dark: #30db5b -> #34c759. The fit below produced the same
      // top to the letter and a bottom 2 levels off, so the framework's pair ships.
      sms: { top: "#30db5b", bottom: "#34c759", screenHeight: 874 },
      incoming: { top: "#262629", bottom: "#262629", screenHeight: 874 },
      incomingText: "#ffffff",
      outgoingText: "#ffffff",
      secondaryLabel: "#8d8d93",
      edited: "#3f8ff7",
      tapbackMine: "#0088ff",
      /**
       * Not the incoming bubble's #262629, which is what this used to borrow. The balloon another
       * person's reaction gets is `messageAcknowledgmentBalloonColorTypeForStyle:` 0, whose
       * `balloonColorsForColorType:` resolves to **#e9e9eb** light and **#3b3b3d** dark - the same
       * pair at idiom 0 and idiom 5, which is why macOS below already ships #3b3b3d. No capture on
       * either platform contains someone else's balloon, so the framework is the only source.
       */
      tapbackTheirs: "#3b3b3d",
      separator: "#38383a",
    },
  },
  macos: {
    light: {
      background: "#ffffff",
      imessage: { top: "#77c7f5", bottom: "#3682f7", screenHeight: 640 },
      sms: { top: "#5fe083", bottom: "#35c65b", screenHeight: 640 },
      incoming: { top: "#e9e9eb", bottom: "#e9e9eb", screenHeight: 640 },
      incomingText: "#000000",
      outgoingText: "#ffffff",
      secondaryLabel: "#808080",
      edited: "#1f7cf5",
      tapbackMine: "#5498f8",
      tapbackTheirs: "#e9e9eb",
      separator: "#e1e1e1",
    },
    dark: {
      background: "#1e1e1e",
      imessage: { top: "#589af7", bottom: "#3d8ef7", screenHeight: 640 },
      sms: { top: "#4fd772", bottom: "#33bf56", screenHeight: 640 },
      incoming: { top: "#38383a", bottom: "#3c3c3e", screenHeight: 640 },
      incomingText: "#ffffff",
      outgoingText: "#ffffff",
      secondaryLabel: "#9a9a9a",
      edited: "#3f8ff7",
      tapbackMine: "#5498f8",
      tapbackTheirs: "#3b3b3d",
      separator: "#3a3a3a",
    },
  },
};

/** CSS custom properties that carry a palette, so components stay theme-aware through `.dark`. */
export function paletteVars(p: Palette): Record<string, string> {
  return {
    "--im-bg": p.background,
    "--im-blue-top": p.imessage.top,
    "--im-blue-bottom": p.imessage.bottom,
    "--im-green-top": p.sms.top,
    "--im-green-bottom": p.sms.bottom,
    "--im-gray-top": p.incoming.top,
    "--im-gray-bottom": p.incoming.bottom,
    "--im-incoming-text": p.incomingText,
    "--im-outgoing-text": p.outgoingText,
    "--im-secondary": p.secondaryLabel,
    "--im-edited": p.edited,
    "--im-tapback-mine": p.tapbackMine,
    "--im-tapback-theirs": p.tapbackTheirs,
    "--im-separator": p.separator,
    "--im-screen-h": `${p.imessage.screenHeight}px`,
  };
}

/** System font stacks. `-apple-system` resolves to SF Pro on Apple platforms, which is what native renders. */
export const fontStack = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "Helvetica Neue", Helvetica, Arial, sans-serif';
export const emojiFontStack = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
