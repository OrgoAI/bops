"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@/lib/utils";
import { usePlatform, type Platform } from "@/components/message-ui/platform";
import { bubbleMetrics, fontStack } from "@/components/message-ui/tokens";
import { IosStatusBar } from "@/components/message-ui/ios-status-bar";
import { Tapback, TapbackGlyph, balloonGeometry, balloonSlot, pickerBalloonGeometry, tapbackVars } from "@/components/message-ui/tapback";
import { SmileyIcon, TapbackBar, tapbackBarMetrics, type TapbackSelection } from "@/components/message-ui/tapback-bar";

/**
 * The full-screen photo viewer: what a photo in a bubble opens into.
 *
 * THIS SURFACE IS NOW CAPTURED. Messages does not draw a photo browser of its own — it presents
 * QuickLook, and `ChatKit.CKQLPreviewController` is the `QLPreviewController` subclass it presents.
 * That subclass can be instantiated outside Messages, so the screen was reproduced and shot:
 *
 *   1. A throwaway iOS app (`clang -target arm64-apple-ios18.0-simulator`) with a `QLPreviewItem`
 *      data source over five generated JPEGs, installed on a private iPhone 17 Pro / iOS 26.0
 *      (23A343) simulator with `xcrun simctl install`.
 *   2. `dlopen("/System/Library/PrivateFrameworks/ChatKit.framework/ChatKit")` inside that app,
 *      `objc_getClass("CKQLPreviewController")`, present it full screen.
 *   3. `xcrun simctl io <udid> screenshot` at 402x874 @3x, and a walk of the live view hierarchy
 *      logging every frame in window coordinates — so the bar geometry is read off the runtime, not
 *      guessed from pixels, and the screenshot only confirms it.
 *
 * Captures: `references/ios/captures/image-viewer-chrome-dark.png` (chrome up over the black ground)
 * and `image-viewer-fit-dark.png` (a 3:4 photo fitted, chrome auto-hidden). Written up in
 * `references/image-viewer.md` and `references/SPEC.md`.
 *
 * WHAT THE CAPTURE OVERTURNED. The chrome is not two opaque bars with a scrim and a centred title.
 * On iOS 26 it is Liquid Glass circles floating over the photo: a close X top right, and a bottom row
 * with a leading and a trailing group. There is no "Done" text button, no title text and no thumbnail
 * tray. `loadView` only sets `navigationBar.barStyle`, and QuickLook lays the buttons out itself
 * (`-tapbackButtonFrameForFullScreenBalloonViewController:` forwards to
 * `-frameForAdditionalButtonWithActionName:`, QuickLook's own additional-button slot).
 *
 * CORRECTION, 2026-09-10. This comment used to add "`-[CKQLPreviewController updateBarButtonItems]`
 * disassembles to a single `ret`, so ChatKit builds no bars at all". That reading was taken from the
 * **macCatalyst** ChatKit. The **iOS** build of the same method is 872 bytes and installs a tapback,
 * a reply and a save item through QuickLook's additional-bar-button-item groups; see
 * `imageViewerMetrics.footerGroups`, which is what decides the sides this file draws them on. The
 * capture showed only reply and share because the probe had no chat item and no delegate, not
 * because the bar is empty.
 *
 * FRAMEWORK values are read out of the binaries on this Mac (macOS 26.5.2, Messages 26.0) from a
 * macCatalyst process that dlopens the iOSSupport frameworks. `PUOneUpSettings` is idiom-dependent
 * and its singleton latches the idiom at first `+sharedInstance`, so every read below was taken in a
 * fresh process with `-[UIDevice userInterfaceIdiom]` swizzled to 0 (phone) BEFORE the first access.
 * That is the difference between `interpageSpacing` 40 (phone and mac) and 100 (pad); a plain
 * Catalyst process reports pad. Method bodies come from `lldb ... -o "disassemble -n '-[Class sel]'"`
 * against the loaded image, because the on-disk binaries are shared-cache stubs.
 *
 * The accessible names are ChatKit's own, from
 * `AccessibilityBundles/ChatKitFramework.axbundle/Contents/Resources/Accessibility.loctable`:
 * `photo.attachment` = "Photo", `messages.attachment.stack.view.format` = "attachment %1$d of %2$d",
 * `save.photo.button` = "Save photo", `balloon.message.reply` = "Reply". The live bar buttons carry
 * `accessibilityLabel` "close", "reply" and "Share".
 *
 * JUDGEMENT, with no framework symbol and no capture behind it — each one says so again where it
 * lives, and they are listed in SPEC's "what is not measured": the thresholds that commit a swipe or
 * a dismissal, the scale the photo shrinks to while it is being flung away, where an applied tapback
 * balloon sits on a full-screen photo, the save and tapback buttons' glyphs and their slot in the
 * bar, and the whole macOS presentation.
 *
 * SEEKABLE. The entrance and the exit are one Web Animations timeline per layer, so
 * `document.getAnimations()` reaches them and `progress` pauses and seeks instead of playing. With
 * `progress` set, every CSS transition in the tree is switched off and the chrome's auto-hide timer
 * never arms, so a checkpoint renders the same frame every run.
 */
export const imageViewerMetrics = {
  /**
   * The viewer's ground. `PUBlackOneUpInterfaceTheme -photoBrowserChromeVisibleBackgroundColor` and
   * `-photoBrowserChromeHiddenBackgroundColor` both resolve to opaque black in the light AND the dark
   * trait collection, so the viewer does not follow the theme: it is black either way. Confirmed in
   * `image-viewer-fit-dark.png`, where every pixel outside the fitted photo is exactly (0,0,0).
   */
  ground: "#000000",
  /**
   * The Liquid Glass disc every chrome button is drawn on, MEASURED off
   * `image-viewer-chrome-dark.png` over the viewer's own black ground: the disc's interior reads
   * #131313 (19/255), i.e. white at 7.45% over black, and its outer edge peaks at 52/255, i.e. a rim
   * of white at 14% on top of that fill. The glyph ink reads #f3f3f3, not pure white. A disabled
   * glyph (the capture's reply button, which had no delegate to enable it) peaks at 90/255, which is
   * 0.32 of the enabled ink over the same disc.
   *
   * `blur` is the one number here that a capture cannot give back: the ground behind the discs is
   * flat black, so no radius is recoverable from it. UNMEASURED.
   */
  glass: {
    fill: "rgba(255,255,255,0.0745)",
    rim: "rgba(255,255,255,0.14)",
    ink: "#f3f3f3",
    disabledInk: 0.32,
    blur: 20,
  },
  /**
   * Where the chrome sits. iOS is MEASURED from the live view hierarchy of `CKQLPreviewController`
   * on an iPhone 17 Pro at 402x874:
   *   - `UIWindow.safeAreaInsets` = {62, 0, 34, 0}. Note this is NOT the 54 the status bar's ink
   *     occupies (SPEC's "status bar 0-54"): the layout inset is 62, and there is a 34pt home
   *     indicator inset the conversation captures never showed.
   *   - `UINavigationBar` frame {0, 62, 402, 54}, i.e. it begins exactly at the safe-area top; its
   *     `_UIBarBackground` spans {0, 0, 402, 116}, which is the bar plus `barsOutset`.
   *   - The nav bar's `_UINavigationBarPlatterView`s are 44x44 at (16, 62) and (342, 62), so 16 in
   *     from each edge. ChatKit's build has only the right one (`accessibilityLabel` "close").
   *   - The floating bottom bar is {0, 798, 402, 76}; its button row is {28, 798, 346, 48} and its
   *     `UIPlatformGlassInteractionView`s are 48x48 at (28, 798) and (326, 798).
   * Both slots reproduce numbers SPEC already carries for other screens: the conversation's back
   * button is "a 44pt circle centered (38, 84)" = (16, 62, 44, 44), and the list's compose button is
   * "Ø48 centered (350, 822)" = (326, 798, 48, 48). Same slots, independently measured twice.
   *
   * macOS is UNMEASURED. Messages on macOS is the same Catalyst binary presenting the same
   * QuickLook, so the disc sizes and the horizontal insets are carried over unchanged and only
   * `header.top` is invented — a window has no safe area to hang the bar off.
   */
  chrome: {
    ios: {
      // The header's top IS the safe-area top: `UINavigationBar.frame.origin.y` and
      // `safeAreaInsets.top` are both 62, measured in the same hierarchy dump.
      safeArea: { top: 62, bottom: 34 },
      header: { size: 44, inset: 16 },
      footer: { size: 48, inset: 28, bottom: 28 },
    },
    macos: {
      // A window has no safe area, so `top` here is the inset the chrome keeps instead. UNMEASURED;
      // everything else is carried over from iOS, which is the same Catalyst binary.
      safeArea: { top: 16, bottom: 0 },
      header: { size: 44, inset: 16 },
      footer: { size: 48, inset: 28, bottom: 28 },
    },
  },
  /**
   * Glyph ink boxes, MEASURED. The reply and share sizes are the `UIImage` symbol sizes logged off
   * the live `_UIModernBarButton`s (`arrowshape.turn.up.left` 21.333 x 17.333,
   * `square.and.arrow.up` 19 x 22); the close X is the ink box traced in the capture, 17 x 17
   * centred on the disc.
   *
   * `save` and `tapback` are UNMEASURED: ChatKit has `-saveTapped:` and `-tapbackTapped:` and the
   * axbundle has "Save photo", but neither button appears in the bar unless a
   * `ckQLPreviewControllerDelegate` supplies a chat item, which a probe outside Messages cannot do.
   * Their glyphs and their slot in the bar are drawn to match the two that were measured.
   */
  glyph: {
    close: 17,
    reply: { width: 21.67, height: 19.67, offsetX: -1.17, offsetY: 0.17 },
    share: { width: 18.67, height: 24 },
    save: { width: 18.67, height: 24 },
    tapback: 21,
  },
  /**
   * `PUOneUpSettings -barsAreaVerticalOutset` = 10: how far the bars' AREA runs past the bars
   * themselves. It checks out against the capture — the nav bar's background is 116 tall and the bar
   * itself ends at 62 + 44 = 106.
   */
  barsOutset: 10,
  /**
   * Which side of the footer each control sits on. MEASURED in the **iOS** ChatKit — the simulator
   * runtime's binary is a plain Mach-O rather than a shared-cache stub, so
   * `lldb -b -o 'target create --arch arm64 <RuntimeRoot>/System/Library/PrivateFrameworks/ChatKit.framework/ChatKit'`
   * `-o 'disassemble -n "-[CKQLPreviewController updateBarButtonItems]"'` reads it off disk with no
   * device at all.
   *
   * THIS OVERTURNS A NOTE THIS FILE USED TO CARRY. "`updateBarButtonItems` disassembles to a single
   * `ret`, so ChatKit builds no bars" is true of the **macCatalyst** build and only that one. The iOS
   * build is 872 bytes and does this, in order:
   *   - bail to two empty lists unless `currentPreviewItem` is the expected class, unless the
   *     delegate's `-shouldHideInteractionOptions` is set, and unless
   *     `-shouldDisableTranscriptCapabilitiesForFileTransfer:` on the item's transfer;
   *   - `currentChatItem.canSendTapbacks` → `+[UIBarButtonItem ck_tapbackItemWithChatItem:target:action:]`,
   *     `-setTapbackButton:`, and add it to the LEFT list when
   *     `CKFeatureFlags.sharedFeatureFlags.isTapbacksRefreshEnabled`, to the RIGHT list otherwise
   *     (`csel x0, [sp,#8], x20, ne` — the same `csel` twice, on the same flag);
   *   - `-replyButton`, added to the same side by the same test;
   *   - `-canCurrentPreviewItemQuickSave` → a `UIBarButtonItem` over `+[UIImage systemImageNamed:]`,
   *     added ALWAYS to the right list (`mov x0, x20`);
   *   - `-setAdditionalLeftBarButtonItems:` with the first list, `-setAdditionalRightBarButtonItems:`
   *     with the second.
   *
   * The flag's value is not readable from a binary, but the capture settles it: the probe had no chat
   * item and no delegate, so it took the reply button and nothing else — and
   * `image-viewer-chrome-dark.png` shows that reply on the LEADING edge at x 28. Reply only lands in
   * the left list when the flag is on, so on this build it is. Hence tapback and reply lead, save
   * trails, and QuickLook's own share button trails beyond it.
   *
   * UNMEASURED: the gap between two discs inside one group (this file draws 8), and the order within
   * the leading group is taken from the order they are appended in.
   */
  footerGroups: { leading: ["tapback", "reply"], trailing: ["save", "share"] },
  /**
   * `PUOneUpSettings -interpageSpacing`. 40 under idiom 0 (phone) and idiom 5 (mac), 100 under idiom
   * 1 (pad). This file used to carry the pad value, which put 60pt too much black between photos on
   * every swipe and threw the parallax off with it. The gap is the viewer's ground, so it reads as
   * black.
   */
  interpageSpacing: 40,
  /** `PUOneUpSettings -doubleTapZoomFactor` = 2.5. */
  doubleTapZoom: 2.5,
  /** `PUOneUpSettings -defaultZoomInFactor` = 6, the pinch ceiling. */
  maxZoom: 6,
  /** `PUOneUpSettings -allowDoubleTapZoom`, `-allowChromeHiding` and `-allowUserTransform` are all 1. */
  allowDoubleTapZoom: true,
  allowChromeHiding: true,
  /**
   * `-doubleTapZoomAreaExcludesBackground` = 1 and `-doubleTapZoomAreaExcludesBars` = 1: a double tap
   * on the letterboxed black, or inside the bars' area, does not zoom. `doubleTapTarget` below is
   * where it does.
   */
  doubleTapExcludesBackground: true,
  doubleTapExcludesBars: true,
  /**
   * `PUOneUpSettings -parallaxFactor` = 12.5 with `-allowParallax` = 1 and `-parallaxModel` = 1:
   * while a page moves, its photo lags by 1/12.5 of that page's offset, so the strip does not slide
   * as one sheet.
   */
  parallaxFactor: 12.5,
  /**
   * `PUOneUpSettings -chromeAutoHideDelay` = 3 s with `-allowChromeHiding` = 1 and
   * `-persistChromeVisibility` = 0. This is not theoretical: in the capture run the chrome was up at
   * 1.4 s and gone by 2.6 s without any input, so the viewer really does drop its chrome on a timer.
   */
  chromeAutoHideDelay: 3000,
  /**
   * `PUOneUpSettings -chromeAutoHideBehaviorOnZoom` = 2. The raw value is measured; what the enum's
   * cases mean is not, so this component takes the only reading that is consistent with the other
   * two `chromeAutoHideBehavior*` settings and hides the chrome when the photo leaves fit.
   */
  hideChromeOnZoom: true,
  /**
   * `PUOneUpSettings -userNavigationMaximumDistance` = 2: how far ahead of the current item the pager
   * keeps content ready. Used as the mount window, so a twenty-photo message mounts five pages, not
   * twenty.
   */
  pageWindow: 2,
  /**
   * Rubber band. UIScrollView's documented resistance constant, which every Apple scroll view uses
   * and the one-up pager is one. NOT read out of PhotosUI: platform default, not a measurement.
   */
  rubberBand: 0.55,
  /**
   * Committing a swipe. JUDGEMENT, no framework value: the page flips when the drag passes a third of
   * the frame or the flick is faster than 500 pt/s. (`-pagingFrictionAdjustment` = 2 and
   * `-pagingSpringPullAdjustment` = 0 are the only paging numbers PhotosUI exposes and neither is a
   * threshold.)
   */
  pageCommit: { distance: 1 / 3, velocity: 500 },
  /**
   * Committing a drag-to-dismiss, and how far the photo shrinks on the way down. JUDGEMENT:
   * `PUOneUpSettings` carries no dismissal threshold. 120 pt of travel or a 700 pt/s flick, with the
   * photo scaling to 0.6 across that travel.
   */
  dismiss: { distance: 120, velocity: 700, minScale: 0.6 },
  /**
   * How far the ground dims under an interactive dismissal.
   * `PUTilingViewSettings -interactiveTransitionBackgroundDimming` = 0.5, so the black goes to 50%
   * across the drag and the conversation shows through behind it — it does not fade away entirely.
   */
  dismissDimming: 0.5,
  /** How far a pointer has to move before a drag stops being a tap. JUDGEMENT. */
  slop: 6,
  /** How long a second tap counts as a double tap, and how far it may land from the first. JUDGEMENT. */
  doubleTap: { window: 300, slop: 24 },
  timing: {
    /** `PUTilingViewSettings -springAnimationDuration` = 0.3, with `-useSpringAnimations` = 1. The open zoom, the exit that reverses it, and every settle of the photo's own transform. */
    zoom: 300,
    /** `PUTilingViewSettings -transitionDuration` = 0.2: the ground coming up behind the zoom. */
    backdrop: 200,
    /** `PUOneUpSettings -chromeDefaultAnimationDuration` = 0.2. */
    chrome: 200,
    /** `PUTilingViewSettings -transitionChromeDelay` = 0: the chrome arrives with the zoom, not after it. */
    chromeDelay: 0,
    /** `PUOneUpSettings -finalFadeOutDuration` = 0.2. Used when there is no tile to zoom out of. */
    fade: 200,
    /**
     * `PUOneUpSettings -bounceDuration` = 0.5 with `-bounceSpringDamping` = 1 (critically damped, no
     * overshoot) and `-bounceDelay` = 0. This is the snap back from an OVERSCROLLED pan and nothing
     * else. A double tap, a pinch settle and a page settle all take `zoom` (0.3); this file used to
     * route every one of them through 0.5.
     */
    bounce: 500,
    /** Paging under its own steam, e.g. an arrow key. `PUTilingViewSettings -springAnimationDuration`. */
    page: 300,
    /** `ChatKit.CKUIBehaviorPhone -tapbackDismissalDuration` = 0.5: how long the picker takes to leave. */
    tapbackDismiss: 500,
  },
  /**
   * The easing on the zoom. `PUTilingViewSettings` says spring, overshoot allowed
   * (`-useOvershootingSpringAnimations` = 1), but carries no stiffness or damping to read, so this is
   * the standard curve the rest of the kit uses. JUDGEMENT.
   */
  ease: "cubic-bezier(0.32, 0.72, 0, 1)",
} as const;

export type ImageViewerRect = { x: number; y: number; width: number; height: number };
export type ImageViewerPhoto = { src: string; alt?: string; width?: number; height?: number };
export type ImageViewerSize = { width: number; height: number };

export type ImageViewerProps = Omit<ComponentProps<"div">, "children" | "onSelect"> & {
  /**
   * The photos paging runs over. NOT the tapped message's photos — MEASURED in ChatKit, the native
   * viewer's list is the tapped photo's whole **layout group**, which spans messages:
   * `-[CKChatController(QuickLook) previewItemsForMediaObject:currentItemIndex:containsRestoring:]`
   * enumerates the entire transcript's `chatItems` and keeps every one whose `layoutGroupIdentifier`
   * matches the tapped item's, then reports the tapped item's position in that list as the index to
   * open on. Since a send of N photos makes N separate messages, tapping any one of them opens a
   * viewer that pages over all N. `IosMessagesApp` assembles that run with its exported `photoRun`;
   * a shell of your own has to do the same, because this component pages over exactly what it is
   * given and cannot see the transcript.
   */
  photos: ImageViewerPhoto[];
  /** Which one is showing. Controlled when given, otherwise the viewer keeps its own. */
  index?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
  /**
   * The tapped tile's box in the viewer's OWN coordinates, i.e. relative to the element this viewer
   * fills. A caller holding a viewport `DOMRect` (which is what `MessageImages onOpenImage` hands
   * over) subtracts the viewer host's own `getBoundingClientRect()` first. The open zoom starts here;
   * null falls back to a fade, which is what a viewer opened from a keyboard or a deep link should
   * do.
   */
  sourceRect?: ImageViewerRect | null;
  /**
   * Where each photo's tile is, so the EXIT lands on the photo that is actually showing. Native
   * returns the current item to its own tile and fades when that tile is off-screen; a viewer given
   * only `sourceRect` flies photo 4 back into photo 1's thumbnail. Return null for a tile that is not
   * on screen and the exit fades instead.
   */
  rectForIndex?: (index: number) => ImageViewerRect | null;
  /** The tile's corner radius, so the zoom starts with the bubble's corner and squares off on the way out. */
  sourceRadius?: number;
  /** False plays the exit and then calls `onExited`. Derive it during render, never in an effect. */
  open?: boolean;
  onExited?: () => void;
  onClose?: () => void;
  /** Seek the entrance to this fraction (0..1) instead of playing it, and freeze every transition. */
  progress?: number;
  /**
   * Header lines. OFF by default and rendered only when given, because the measured iOS 26 chrome has
   * none: `CKQLPreviewController` sets `navigationItem.title` to the preview item's title, but the
   * bar draws no title view and the capture shows no text anywhere in the chrome.
   */
  title?: string;
  subtitle?: string;
  /** Show "2 of 5" beside the subtitle. Off by default: neither `PUOneUpSettings` nor QuickLook has a page indicator. */
  pageIndicator?: boolean;
  /** Header and footer visibility. Controlled when given; tapping the photo toggles it either way. */
  chrome?: boolean;
  onChromeChange?: (visible: boolean) => void;
  /**
   * Drop the chrome after `chromeAutoHideDelay` with no input, the way the capture run showed the
   * real viewer doing. Never arms while `progress` is set, so a scrubbed checkpoint is stable.
   */
  autoHideChrome?: boolean;
  /**
   * Drive the drag-to-dismiss pose from outside: 0 at rest, 1 at the commit threshold. Given, it
   * replaces the finger's own travel, so a harness checkpoint or a lab scene can hold the pose the
   * gesture passes through instead of having to synthesise a drag.
   */
  dismissProgress?: number;
  /** Hold a paging gesture at a fraction of the page pitch. Negative moves toward the next photo. */
  pageOffset?: number;
  /** Fit is 1. Controlled when given. */
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  /**
   * The reaction on the photo that is showing, and the picker over it. Reacting from inside the
   * viewer is real: `CKQLPreviewController` has `-tapbackTapped:`, `-tapbackButton`,
   * `-_sendTapback:targetChatItem:isRemoval:` and a full `CKFullScreenBalloonViewController` delegate
   * surface, and `-shouldShowTapbackPickerForFullScreenBalloonViewController:` asks the chat
   * controller per item.
   */
  reaction?: TapbackSelection | null;
  onReact?: (selection: TapbackSelection) => void;
  tapbackOpen?: boolean;
  onTapbackOpenChange?: (open: boolean) => void;
  recent?: string[];
  /**
   * Who reacted, shown beside the balloon.
   * `-shouldShowTapbackAttributionForFullScreenBalloonViewController:` is delegated per chat item, so
   * the real surface can show it. Its placement here is UNMEASURED.
   */
  reactionAttribution?: string;
  /** QuickLook's own share button, `_actionButtonTapped:`. Always in the bar. */
  onShare?: () => void;
  /** ChatKit's `-replyTapped:`. The button is always in the bar and is DISABLED when this is absent, which is what `-shouldShowReplyButtonForMediaObject:previewController:` does to it natively. */
  onReply?: () => void;
  /** ChatKit's `-saveTapped:`, gated natively on `-canCurrentPreviewItemQuickSave`. Omit and no save button is drawn. */
  onSave?: () => void;
  /** `-currentPreviewItemIsSaved`: the save button reports the item is already in the library. */
  saved?: boolean;
  /** Insets the chrome stays inside. Defaults to the platform's measured ones. */
  safeArea?: { top?: number; bottom?: number };
  /** Draw the status bar. `PUOneUpSettings -allowStatusBar` = 1 and the capture shows it, in white over the black ground. */
  statusBar?: boolean;
  /** Clock text for that status bar. */
  time?: string;
  /** The viewer's own size before it can measure itself, e.g. during a server render. */
  frame?: ImageViewerSize;
  platform?: Platform;
};

/** The largest box of `aspect` that fits inside `frame`, centred. Native fits a photo, it does not fill. */
export function fitPhotoRect(aspect: number, frame: ImageViewerSize): ImageViewerRect {
  const width = Math.min(frame.width, frame.height * aspect);
  const height = width / aspect;
  return { x: (frame.width - width) / 2, y: (frame.height - height) / 2, width, height };
}

/**
 * UIScrollView's resistance: the first point of overscroll moves almost one for one and the curve
 * flattens from there, never passing `c * dimension`.
 */
export function rubberBand(distance: number, dimension: number, c: number = imageViewerMetrics.rubberBand): number {
  if (!dimension) return 0;
  const magnitude = Math.abs(distance);
  return Math.sign(distance) * (1 - 1 / (magnitude / (c * dimension) + 1)) * c * dimension;
}

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * The two poses of the open zoom, in the zoom layer's own coordinates with `transform-origin: 0 0`.
 * The end pose is the identity, because the photo is already fitted in the frame. The start pose
 * scales the whole frame down until the fitted photo covers `source` exactly, clips away everything
 * outside it, and divides the tile's corner radius by the same scale so it lands at `radius` on
 * screen. Both poses are `inset()` clips of the same shape, which is what makes the pair animatable.
 */
export function zoomPose(source: ImageViewerRect | null, fit: ImageViewerRect, frame: ImageViewerSize, radius: number) {
  const settled = { transform: "translate(0px, 0px) scale(1)", clipPath: "inset(0px 0px 0px 0px round 0px)", opacity: 1 };
  if (!source || !fit.width || !fit.height) {
    return { start: { transform: "translate(0px, 0px) scale(0.94)", clipPath: settled.clipPath, opacity: 0 }, end: settled };
  }
  const scale = Math.max(source.width / fit.width, source.height / fit.height);
  const tx = source.x + source.width / 2 - scale * (fit.x + fit.width / 2);
  const ty = source.y + source.height / 2 - scale * (fit.y + fit.height / 2);
  const left = (source.x - tx) / scale;
  const top = (source.y - ty) / scale;
  const width = source.width / scale;
  const height = source.height / scale;
  return {
    start: {
      transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
      clipPath: `inset(${top}px ${frame.width - left - width}px ${frame.height - top - height}px ${left}px round ${radius / scale}px)`,
      opacity: 1,
    },
    end: settled,
  };
}

/**
 * Where a double tap is allowed to zoom, from `-doubleTapZoomAreaExcludesBackground` = 1 and
 * `-doubleTapZoomAreaExcludesBars` = 1: inside the fitted photo, and outside the bars' areas — which
 * are each bar's band grown by `barsAreaVerticalOutset`.
 */
export function doubleTapTarget(point: { x: number; y: number }, fit: ImageViewerRect, frame: ImageViewerSize, bars: { top: number; bottom: number }): boolean {
  const m = imageViewerMetrics;
  if (m.doubleTapExcludesBackground) {
    const inside = point.x >= fit.x && point.x <= fit.x + fit.width && point.y >= fit.y && point.y <= fit.y + fit.height;
    if (!inside) return false;
  }
  if (m.doubleTapExcludesBars) {
    if (point.y < bars.top || point.y > frame.height - bars.bottom) return false;
  }
  return true;
}

/**
 * Which pages are mounted. `PUOneUpSettings -userNavigationMaximumDistance` = 2, so the pager keeps
 * two items either side ready and everything past that is not in the tree at all.
 */
export function pageWindow(index: number, count: number, distance: number = imageViewerMetrics.pageWindow): number[] {
  const pages: number[] = [];
  for (let i = Math.max(0, index - distance); i <= Math.min(count - 1, index + distance); i++) pages.push(i);
  return pages;
}

/* --------------------------------------------------------------------------------- glyphs */

/**
 * The close button's X, traced off `image-viewer-chrome-dark.png` at 3x: ink x 355.0-371.67,
 * y 75.67-92.67 inside a disc at (342, 62, 44, 44), i.e. 16.67 x 17.0 centred on the disc to within
 * two thirds of a point. Each diagonal reads 9.5 device px across a row, and a 45 degree stroke
 * measured along a row is its true width times root two, so the stroke is 9.5 / 3 / 1.414 = 2.24.
 */
function CloseIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 17 17" fill="none" aria-hidden="true">
      <path d="M1.2 1.2 15.8 15.8M15.8 1.2 1.2 15.8" stroke="currentColor" strokeWidth="2.24" strokeLinecap="round" />
    </svg>
  );
}

/**
 * SF Symbol `arrowshape.turn.up.left`, the image ChatKit's `-replyButton` is built with
 * (`[[CKUIBehavior sharedBehaviors] replyImage]`, logged off the live bar button as a 21.333 x 17.333
 * symbol). The silhouette is traced off `image-viewer-chrome-dark.png` at 3x, where its ink runs
 * x 40.0-61.67 and y 812.67-832.33 inside a disc at (28, 798, 48, 48):
 *   - the arrowhead's tip is the leftmost ink, at y 822.17;
 *   - its top and bottom corners sit at x 50.17, y 812.67 and y 832.33;
 *   - the back edge between them is a 2.0 pt vertical run at x 50.0-51.67, broken where the hook
 *     leaves it at y 818.0 and rejoins it at y 825.33;
 *   - the hook's outer edge reaches x 61.67 and comes down to a tip at (61.3, 832), which is why
 *     the bottom row of the mask has TWO ink runs and not one.
 * Stroke 1.9 = the 6 device px the back edge measures.
 */
function ReplyIcon({ width, height }: { width: number; height: number }) {
  return (
    <svg width={width} height={height} viewBox="0 0 21.67 19.67" fill="none" aria-hidden="true">
      <path
        d="M1.35 9.6 10.9 1.05v4.85c6.5 0 9.5 3.7 9.5 12.6 0-3.9-3.4-5.3-9.5-5.3v5.4Z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * SF Symbol `square.and.arrow.up`, QuickLook's own action button (`_actionButtonTapped:`), logged as
 * a 19 x 22 symbol and traced off `image-viewer-chrome-dark.png`, where its ink runs x 340.33-359.0
 * and y 809.67-833.67 inside a disc at (326, 798, 48, 48) — 18.67 x 24.0, centred on the disc to
 * within a third of a point. The tray's walls are 1.67 pt runs whose centres sit at x 341.17 and
 * 358.17; its top edge is at y 817.5 and is broken between x 347 and x 352.67 for the shaft; its
 * bottom is at y 832.8 with corners of about r 2.5. The chevron's apex is at (349.67, 810.5) and its
 * arms end at (345.5, 814.67) and (353.8, 814.67).
 */
function ShareIcon({ width, height }: { width: number; height: number }) {
  return (
    <svg width={width} height={height} viewBox="0 0 19 24" fill="none" aria-hidden="true">
      <path d="M9.5 1v14.8M5.35 5.15 9.5 1l4.15 4.15" stroke="currentColor" strokeWidth="1.67" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.9 7.85H3.5A2.5 2.5 0 0 0 1 10.35v10.25a2.5 2.5 0 0 0 2.5 2.5h12a2.5 2.5 0 0 0 2.5-2.5V10.35a2.5 2.5 0 0 0-2.5-2.5h-3.4" stroke="currentColor" strokeWidth="1.67" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The save button. UNMEASURED: ChatKit has `-saveTapped:` and the axbundle has "Save photo", but the
 * button never appears without a chat item, so its symbol is a `square.and.arrow.down` look-alike
 * drawn to the share glyph's box, and the saved state is a checkmark in the same box.
 */
function SaveIcon({ width, height, saved }: { width: number; height: number; saved?: boolean }) {
  if (saved) {
    return (
      <svg width={width} height={height} viewBox="0 0 19 24" fill="none" aria-hidden="true">
        <path d="M3.6 12.6 7.9 17l7.5-9.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width={width} height={height} viewBox="0 0 19 24" fill="none" aria-hidden="true">
      <path d="M9.5 1v14.8M5.35 11.65 9.5 15.8l4.15-4.15" stroke="currentColor" strokeWidth="1.67" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.9 7.85H3.5A2.5 2.5 0 0 0 1 10.35v10.25a2.5 2.5 0 0 0 2.5 2.5h12a2.5 2.5 0 0 0 2.5-2.5V10.35a2.5 2.5 0 0 0-2.5-2.5h-3.4" stroke="currentColor" strokeWidth="1.67" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type Point = { x: number; y: number };

type Gesture = {
  pointers: Map<number, Point>;
  mode: "none" | "undecided" | "page" | "dismiss" | "pan" | "pinch";
  start: Point;
  startPan: Point;
  startZoom: number;
  startSpread: number;
  startMid: Point;
  last: Point;
  lastTime: number;
  velocity: Point;
  tapTime: number;
  doubleTapTime: number;
  tapPoint: Point;
};

function spreadOf(points: Point[]) {
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

function midpointOf(points: Point[]): Point {
  return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
}

/** How long the photo's own transform takes to settle, per the thing that started it moving. */
type Motion = "none" | "settle" | "bounce" | "page";

export function ImageViewer({
  photos,
  index: indexProp,
  defaultIndex = 0,
  onIndexChange,
  sourceRect = null,
  rectForIndex,
  sourceRadius,
  open = true,
  onExited,
  onClose,
  progress,
  title,
  subtitle,
  pageIndicator = false,
  chrome: chromeProp,
  onChromeChange,
  autoHideChrome = true,
  dismissProgress,
  pageOffset,
  zoom: zoomProp,
  onZoomChange,
  reaction = null,
  onReact,
  tapbackOpen: tapbackOpenProp,
  onTapbackOpenChange,
  recent,
  reactionAttribution,
  onShare,
  onReply,
  onSave,
  saved = false,
  safeArea,
  statusBar,
  time,
  frame: frameProp,
  platform: platformProp,
  className,
  style,
  ...props
}: ImageViewerProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const m = imageViewerMetrics;
  const chromeBox = m.chrome[platform];
  const inset = { ...chromeBox.safeArea, ...safeArea };
  const radius = sourceRadius ?? bubbleMetrics[platform].radius;
  const scrubbed = progress !== undefined;
  const count = photos.length;
  const showStatusBar = statusBar ?? platform === "ios";

  const root = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const zoomLayer = useRef<HTMLDivElement>(null);
  const chromeLayer = useRef<HTMLDivElement>(null);
  const tapbackButton = useRef<HTMLButtonElement>(null);
  const exited = useRef(false);
  const tapTimer = useRef<number | undefined>(undefined);
  const motionTimer = useRef<number | undefined>(undefined);

  // The viewer lays out in its own coordinates, so it has to know its own box before it can fit a
  // photo or read `sourceRect`. `frame` covers the render before the observer has fired.
  const [measuredFrame, setMeasuredFrame] = useState<ImageViewerSize | null>(null);
  const frame = useMemo(
    () => measuredFrame ?? frameProp ?? (platform === "ios" ? { width: 402, height: 874 } : { width: 960, height: 640 }),
    [measuredFrame, frameProp, platform],
  );
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const sync = () => setMeasuredFrame({ width: node.clientWidth, height: node.clientHeight });
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const [internalIndex, setInternalIndex] = useState(defaultIndex);
  const index = clamp(indexProp ?? internalIndex, 0, Math.max(0, count - 1));
  const setIndex = useCallback(
    (next: number) => {
      const bounded = clamp(next, 0, Math.max(0, count - 1));
      if (indexProp === undefined) setInternalIndex(bounded);
      onIndexChange?.(bounded);
    },
    [indexProp, onIndexChange, count],
  );

  const [internalChrome, setInternalChrome] = useState(true);
  const chromeVisible = chromeProp ?? internalChrome;
  const setChrome = useCallback(
    (next: boolean) => {
      if (chromeProp === undefined) setInternalChrome(next);
      onChromeChange?.(next);
    },
    [chromeProp, onChromeChange],
  );
  // Callers pass `onChromeChange` inline, so `setChrome` is a new function every parent render. The
  // auto-hide timer reads it through a ref instead, or a render would restart the countdown.
  const setChromeRef = useRef(setChrome);
  useLayoutEffect(() => {
    setChromeRef.current = setChrome;
  });

  const [internalZoom, setInternalZoom] = useState(1);
  const zoom = clamp(zoomProp ?? internalZoom, 1, m.maxZoom);
  const setZoom = useCallback(
    (next: number) => {
      const bounded = clamp(next, 1, m.maxZoom);
      if (zoomProp === undefined) setInternalZoom(bounded);
      onZoomChange?.(bounded);
    },
    [zoomProp, onZoomChange, m.maxZoom],
  );

  const [internalTapback, setInternalTapback] = useState(false);
  const tapbackOpen = tapbackOpenProp ?? internalTapback;
  const setTapbackOpen = useCallback(
    (next: boolean) => {
      if (tapbackOpenProp === undefined) setInternalTapback(next);
      onTapbackOpenChange?.(next);
    },
    [tapbackOpenProp, onTapbackOpenChange],
  );
  // The same derive-during-render rule the shells use for the long-press overlay: the picker has to
  // outlive the flag that opened it, because an effect would leave one committed frame with it
  // already gone and its dismissal would never be seen.
  const [seenTapbackOpen, setSeenTapbackOpen] = useState(tapbackOpen);
  const [tapbackClosing, setTapbackClosing] = useState(false);
  if (seenTapbackOpen !== tapbackOpen) {
    setSeenTapbackOpen(tapbackOpen);
    setTapbackClosing(!tapbackOpen && seenTapbackOpen);
  }

  // Where the footer's tapback button actually sits, so the picker's thought bubble points at it
  // rather than at the middle of the bar: how many controls the footer holds depends on which
  // handlers the caller wired.
  const [tapbackCentre, setTapbackCentre] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = tapbackButton.current;
    const host = root.current;
    if (!node || !host) return;
    // Against the viewer's own box, not `offsetLeft`: the footer is an inset positioned element, so
    // `offsetLeft` is measured from ITS left edge and lands the picker's tail 28 pt off.
    const sync = () => {
      const button = node.getBoundingClientRect();
      const box = host.getBoundingClientRect();
      setTapbackCentre((button.left - box.left + button.width / 2) * host.clientWidth / box.width);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    observer.observe(host);
    return () => observer.disconnect();
  }, [frame.width, onSave, onReply]);

  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [dragX, setDragX] = useState(0);
  const [drop, setDrop] = useState<Point>({ x: 0, y: 0 });
  const [motion, setMotionState] = useState<Motion>("none");
  const [aspects, setAspects] = useState<Record<string, number>>({});

  /**
   * A photo's shape learned on mount as well as on load, which is the same trap `message-image` already
   * documents: an image the browser already has is `complete` before React attaches `onLoad`, and
   * then `onLoad` never fires at all. The aspect stayed unknown, the page kept the fallback box, and
   * the viewer opened with the photograph drawn at a size nothing asked for — for a photo you had
   * already looked at once. It read as a flaky checkpoint here (a different `photo-viewer` frame
   * failing every run) but it is a real thing to see: open a photo, close it, open it again.
   */
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const seed = () => setAspects(known => {
      let next = known;
      for (const image of Array.from(node.querySelectorAll("img"))) {
        const src = image.getAttribute("src");
        if (!src || known[src] || !image.complete || !image.naturalWidth || !image.naturalHeight) continue;
        if (next === known) next = { ...known };
        next[src] = image.naturalWidth / image.naturalHeight;
      }
      return next;
    });
    seed();
    // A photo two pages away mounts `loading="lazy"`; it becomes complete later, and paging to it
    // must not be the first time anything measures it.
    const timer = window.setTimeout(seed, 0);
    return () => window.clearTimeout(timer);
  });

  // `motion` used to be a boolean that only `onPointerDown` ever cleared, so any keyboard action left
  // the settle transition armed for good. It now clears itself after the animation it describes.
  const beginMotion = useCallback((kind: Exclude<Motion, "none">) => {
    setMotionState(kind);
    window.clearTimeout(motionTimer.current);
    const duration = kind === "bounce" ? imageViewerMetrics.timing.bounce : kind === "page" ? imageViewerMetrics.timing.page : imageViewerMetrics.timing.zoom;
    motionTimer.current = window.setTimeout(() => setMotionState("none"), duration);
  }, []);
  const endMotion = useCallback(() => {
    window.clearTimeout(motionTimer.current);
    setMotionState("none");
  }, []);

  const aspectOf = useCallback(
    (photo: ImageViewerPhoto | undefined) => (photo && photo.width && photo.height ? photo.width / photo.height : (photo && aspects[photo.src]) || 4 / 3),
    [aspects],
  );
  const fit = useMemo(() => fitPhotoRect(aspectOf(photos[index]), frame), [aspectOf, photos, index, frame]);

  const pitch = frame.width + m.interpageSpacing;
  const trackX = -index * pitch + (pageOffset === undefined ? dragX : clamp(pageOffset, -1, 1) * pitch);

  /* ------------------------------------------------------------------ chrome geometry */

  // The bars' areas, which the double-tap zoom is not allowed into and which the picker has to clear.
  const headerBand = inset.top + chromeBox.header.size + m.barsOutset;
  const footerBand = chromeBox.footer.bottom + chromeBox.footer.size + m.barsOutset;
  // How far the whole thought bubble hangs below the pill. `TapbackBar` puts the blob's centre
  // `pickerDrop` below the pill's bottom, and the two trailing circles hang further still: the small
  // one's bottom lands `pickerDrop + smallOffset[1] + small / 2` = 49.37 down. Measuring only to the
  // blob (36.67) drove the trail 12.7 pt into the button it is meant to be pointing at.
  const pickerLift = tapbackBarMetrics.ios.pickerDrop + pickerBalloonGeometry.smallOffset[1] + pickerBalloonGeometry.small / 2;
  // The pill floats far enough above the footer that the thought bubble's lowest dot lands exactly on
  // the tapback button's top edge. Derived from the measured footer and the measured bubble geometry
  // — not itself a measured gap.
  const pickerBottom = chromeBox.footer.bottom + chromeBox.footer.size + pickerLift;
  const pickerInset = tapbackBarMetrics.ios.edgeInset;
  const pickerWidth = frame.width - pickerInset * 2;
  // Where the thought bubble's blob goes, in the pill's own coordinates. `TapbackBar` hangs the blob
  // at `pickerX` and its trailing circles down and to the LEFT of it, the small one landing on the
  // blob's own centre line minus `smallOffset[0]`. Over a bubble that trail points at the bubble, so
  // over a photo it points at the button the picker belongs to: the blob is offset by that much so
  // the small circle, not the blob, lands on the tapback button. Derived from the measured balloon
  // geometry; nothing measures the placement itself.
  const pickerAim = (tapbackCentre ?? frame.width / 2) - pickerInset - pickerBalloonGeometry.smallOffset[0];
  const pickerX = clamp(pickerAim, pickerBalloonGeometry.main / 2, Math.max(pickerBalloonGeometry.main / 2, pickerWidth - pickerBalloonGeometry.main / 2));

  // How far the drag has carried the dismissal: 0 at rest, 1 where it commits. Only DOWNWARD travel
  // counts — dragging up used to shrink the photo, fade the ground and hide the chrome before
  // snapping back, because this read `Math.abs(drop.y)` while the commit test read `drop.y`.
  const shift = dismissProgress === undefined ? drop : { x: 0, y: clamp(dismissProgress, 0, 1) * m.dismiss.distance };
  const dropProgress = clamp(Math.max(0, shift.y) / m.dismiss.distance, 0, 1);
  const dropScale = 1 - (1 - m.dismiss.minScale) * dropProgress;

  /* ------------------------------------------------------------------ entrance and exit */

  // Which item the viewer opened on. The entrance keys off THIS one, so paging cannot restart it,
  // while the pose below tracks whichever photo is showing so the exit lands on its own tile.
  // State, not a ref, because it is read during render: a lazy initial value that never changes.
  const [openIndex] = useState(index);
  const openRect = rectForIndex ? rectForIndex(openIndex) : sourceRect;
  const openFit = fitPhotoRect(aspectOf(photos[openIndex]), frame);
  const exitRect = rectForIndex ? rectForIndex(index) : index === openIndex ? sourceRect : null;

  const pose = useMemo(() => zoomPose(exitRect, fit, frame, radius), [exitRect, fit, frame, radius]);
  // The keyframes are read from a ref inside the timeline effect, so a re-render that only moves the
  // page or the pan cannot restart the entrance mid-flight.
  const poseRef = useRef(pose);
  const durationRef = useRef(0);
  // Written in a layout effect rather than in render: layout effects all run before the passive
  // effect below, so the timeline still reads the pose this render computed.
  useLayoutEffect(() => {
    poseRef.current = open ? zoomPose(openRect, openFit, frame, radius) : pose;
    durationRef.current = exitRect ? m.timing.zoom : m.timing.fade;
  });
  // `sourceRect` is a fresh object on every parent render, so the timeline keys off its values.
  const sourceKey = openRect ? `${openRect.x},${openRect.y},${openRect.width},${openRect.height}` : "";

  // Callers normally pass `onExited` inline, and it must not be an effect dependency: a parent
  // re-render mid-exit would cancel the exit and start it again, and it would never finish.
  const onExitedRef = useRef(onExited);
  useLayoutEffect(() => {
    onExitedRef.current = onExited;
  });

  useEffect(() => {
    exited.current = false;
    return () => {
      window.clearTimeout(tapTimer.current);
      window.clearTimeout(motionTimer.current);
    };
  }, []);

  /**
   * A layout effect, not a plain one, and that is what makes a scrubbed checkpoint reproducible. The
   * entrance is a Web Animation created here and then paused and seeked; run after paint, there is
   * one frame in which the layer sits at its own base pose with no animation on it yet, and a
   * screenshot that lands in that frame catches the viewer part-open. It is invisible to a person and
   * it made `photo-viewer` fail differently on every run — 0.42 of the frame different, a different
   * checkpoint each time. Before paint there is no such frame. The playing case loses nothing by
   * starting a frame earlier either.
   */
  useLayoutEffect(() => {
    const stage = zoomLayer.current;
    const ground = backdrop.current;
    const chromeNode = chromeLayer.current;
    if (!stage || !ground) return;
    const reduced = prefersReducedMotion();
    const duration = durationRef.current || (sourceKey ? m.timing.zoom : m.timing.fade);
    const { start, end } = poseRef.current;

    const finish = () => {
      if (exited.current) return;
      exited.current = true;
      onExitedRef.current?.();
    };

    if (open) {
      if (reduced && !scrubbed) return;
      const running = [
        stage.animate([start, end], { duration, easing: m.ease, fill: "both" }),
        ground.animate([{ opacity: 0 }, { opacity: 1 }], { duration: m.timing.backdrop, easing: "linear", fill: "both" }),
        chromeNode?.animate([{ opacity: 0 }, { opacity: 1 }], { duration, delay: m.timing.chromeDelay, easing: "linear", fill: "both" }),
      ].filter(Boolean) as Animation[];
      if (scrubbed) {
        // Seeked, not played: a scrubbed checkpoint has to land on the same frame every run.
        const at = clamp(progress ?? 0, 0, 1) * duration;
        for (const animation of running) {
          animation.pause();
          animation.currentTime = Math.min(at, Number(animation.effect?.getTiming().duration ?? duration));
        }
      }
      return () => running.forEach(animation => animation.cancel());
    }

    if (reduced) {
      // `finish` is the parent's `onExited`, i.e. a setState in another component. Calling it in the
      // effect body is the exact thing the lint rule forbids one boundary further in, so it goes out
      // on a task of its own.
      const id = window.setTimeout(finish, 0);
      return () => window.clearTimeout(id);
    }
    // The exit reverses the entrance: back down into the tile the CURRENT photo came out of, with the
    // ground fading out under it.
    const running = [
      stage.animate([end, start], { duration, easing: m.ease, fill: "forwards" }),
      ground.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: "linear", fill: "forwards" }),
      chromeNode?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: m.timing.chrome, easing: "linear", fill: "forwards" }),
    ].filter(Boolean) as Animation[];
    running[0].addEventListener("finish", finish);
    return () => {
      running[0].removeEventListener("finish", finish);
      running.forEach(animation => animation.cancel());
    };
  // A decoded portrait replaces the provisional landscape fit. Rebuild its entrance too, or a
  // cold load and a cached load use different transforms for the same photo and checkpoint.
  // Keep this keyed to the OPENED photo, so paging to a different aspect cannot replay the entrance.
  }, [open, scrubbed, progress, sourceKey, openFit.width, openFit.height, frame.width, frame.height, m.ease, m.timing.zoom, m.timing.fade, m.timing.backdrop, m.timing.chrome, m.timing.chromeDelay]);

  /**
   * Modal, so it takes focus when it opens. A scrubbed entrance does not: the harness seeks frames
   * and must not move the caret.
   *
   * The focus lands on the root and not on the close button, and that is load-bearing rather than
   * incidental. A control focused programmatically while the pointer that opened the viewer is still
   * down matches `:focus-visible` in Chrome and WebKit alike - the gesture has not resolved, so the
   * modality is still the keyboard default - and paints a ring on a photo the person opened by
   * touch. The root carries `outline-none`, so it holds the focus and paints nothing; `onKeyDown`
   * below is on this element, so Escape, the arrows and the Tab trap all still arrive, and the first
   * Tab moves to a control where a ring is right. See `tapback-bar.tsx` for the same shape and
   * `audio-recorder.tsx` for the other one, where a single control keeps the focus and passes
   * `focusVisible: false` instead.
   */
  useEffect(() => {
    if (!open || scrubbed) return;
    root.current?.focus({ preventScroll: true });
  }, [open, scrubbed]);

  // `-chromeAutoHideDelay` = 3 s: the chrome drops on its own. Never while scrubbing, never while the
  // picker is up, and never while a reaction is being chosen.
  useEffect(() => {
    if (!autoHideChrome || !m.allowChromeHiding || scrubbed || !open) return;
    if (!chromeVisible || tapbackOpen) return;
    const id = window.setTimeout(() => {
      if (document.activeElement !== root.current && root.current?.contains(document.activeElement)) return;
      setChromeRef.current(false);
    }, m.chromeAutoHideDelay);
    return () => window.clearTimeout(id);
  }, [autoHideChrome, scrubbed, open, chromeVisible, tapbackOpen, index, zoom, m.allowChromeHiding, m.chromeAutoHideDelay]);

  /* ------------------------------------------------------------------ zoom, pan and paging */

  const panLimit = useCallback(
    (currentZoom: number) => ({
      x: Math.max(0, (fit.width * currentZoom - frame.width) / 2),
      y: Math.max(0, (fit.height * currentZoom - frame.height) / 2),
    }),
    [fit.width, fit.height, frame.width, frame.height],
  );

  const settle = useCallback(
    (nextZoom: number, nextPan: Point, kind: Exclude<Motion, "none"> = "settle") => {
      const limit = panLimit(nextZoom);
      beginMotion(kind);
      setZoom(nextZoom);
      setPan({ x: clamp(nextPan.x, -limit.x, limit.x), y: clamp(nextPan.y, -limit.y, limit.y) });
      // `-chromeAutoHideBehaviorOnZoom` = 2: leaving fit takes the chrome with it.
      if (m.hideChromeOnZoom && nextZoom > 1) setChrome(false);
    },
    [panLimit, setZoom, beginMotion, setChrome, m.hideChromeOnZoom],
  );

  const zoomAbout = useCallback(
    (nextZoom: number, point: Point) => {
      // Keep whatever is under the finger under the finger: the photo's centre moves by the change in
      // scale taken about that point.
      const centre = { x: frame.width / 2, y: frame.height / 2 };
      const ratio = nextZoom / zoom;
      const next = {
        x: point.x - centre.x - ratio * (point.x - centre.x - pan.x),
        y: point.y - centre.y - ratio * (point.y - centre.y - pan.y),
      };
      settle(nextZoom, nextZoom <= 1 ? { x: 0, y: 0 } : next);
    },
    [frame.width, frame.height, pan.x, pan.y, zoom, settle],
  );

  const page = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next < 0 || next > count - 1) return;
      beginMotion("page");
      setDragX(0);
      setPan({ x: 0, y: 0 });
      setZoom(1);
      setIndex(next);
    },
    [index, count, setIndex, setZoom, beginMotion],
  );

  /* ------------------------------------------------------------------ gestures */

  const gesture = useRef<Gesture>({
    pointers: new Map(),
    mode: "none",
    start: { x: 0, y: 0 },
    startPan: { x: 0, y: 0 },
    startZoom: 1,
    startSpread: 0,
    startMid: { x: 0, y: 0 },
    last: { x: 0, y: 0 },
    lastTime: 0,
    velocity: { x: 0, y: 0 },
    tapTime: 0,
    doubleTapTime: -Infinity,
    tapPoint: { x: 0, y: 0 },
  });

  const localPoint = useCallback((clientX: number, clientY: number): Point => {
    const node = root.current;
    const box = node?.getBoundingClientRect();
    if (!node || !box?.width || !box.height) return { x: 0, y: 0 };
    return { x: (clientX - box.left) * node.clientWidth / box.width, y: (clientY - box.top) * node.clientHeight / box.height };
  }, []);

  /** Start a one-finger drag from `point`, whether it is the first finger down or the last one left. */
  function armDrag(g: Gesture, point: Point, time: number) {
    g.mode = "undecided";
    g.start = point;
    g.startPan = { ...pan };
    g.last = point;
    g.lastTime = time;
    g.velocity = { x: 0, y: 0 };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const g = gesture.current;
    const point = localPoint(event.clientX, event.clientY);
    g.pointers.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    endMotion();
    if (g.pointers.size === 2) {
      window.clearTimeout(tapTimer.current);
      g.tapTime = 0;
      const points = [...g.pointers.values()];
      g.mode = "pinch";
      g.startSpread = spreadOf(points) || 1;
      g.startMid = midpointOf(points);
      g.startZoom = zoom;
      g.startPan = { ...pan };
      return;
    }
    if (g.pointers.size > 2) return;
    // Always undecided to begin with, even zoomed in: a tap on a zoomed photo still has to reach the
    // double-tap and chrome paths, so the pan only starts once the pointer has moved past the slop.
    armDrag(g, point, event.timeStamp);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g.pointers.has(event.pointerId)) return;
    const point = localPoint(event.clientX, event.clientY);
    g.pointers.set(event.pointerId, point);

    if (g.mode === "pinch") {
      const points = [...g.pointers.values()].slice(0, 2);
      if (points.length < 2) return;
      const next = clamp((spreadOf(points) / g.startSpread) * g.startZoom, 1, m.maxZoom);
      const mid = midpointOf(points);
      const centre = { x: frame.width / 2, y: frame.height / 2 };
      const ratio = next / g.startZoom;
      const limit = panLimit(next);
      const wanted = {
        x: mid.x - centre.x - ratio * (g.startMid.x - centre.x - g.startPan.x),
        y: mid.y - centre.y - ratio * (g.startMid.y - centre.y - g.startPan.y),
      };
      setZoom(next);
      // Banded, not free: a mid-pinch pan used to be written straight through, so the photo could be
      // shoved arbitrarily far off-centre and only came back on release.
      setPan({ x: band(wanted.x, limit.x, frame.width), y: band(wanted.y, limit.y, frame.height) });
      return;
    }

    const dx = point.x - g.start.x;
    const dy = point.y - g.start.y;
    const dt = Math.max(1, event.timeStamp - g.lastTime);
    g.velocity = { x: ((point.x - g.last.x) / dt) * 1000, y: ((point.y - g.last.y) / dt) * 1000 };
    g.last = point;
    g.lastTime = event.timeStamp;

    if (g.mode === "undecided") {
      if (Math.hypot(dx, dy) < m.slop) return;
      // A zoomed photo pans in both axes; at fit, sideways is paging and downwards is a dismissal.
      // Upwards is neither: it bands like an overscroll and springs back.
      g.mode = zoom > 1 ? "pan" : Math.abs(dx) > Math.abs(dy) ? "page" : "dismiss";
    }

    if (g.mode === "page") {
      // Rubber band at the two ends, where there is no page to bring on.
      const atStart = index === 0 && dx > 0;
      const atEnd = index === count - 1 && dx < 0;
      setDragX(atStart || atEnd ? rubberBand(dx, frame.width) : dx);
      return;
    }

    if (g.mode === "dismiss") {
      setDrop({ x: dx, y: dy > 0 ? dy : rubberBand(dy, frame.height) });
      return;
    }

    if (g.mode === "pan") {
      const limit = panLimit(zoom);
      const wanted = { x: g.startPan.x + dx, y: g.startPan.y + dy };
      setPan({ x: band(wanted.x, limit.x, frame.width), y: band(wanted.y, limit.y, frame.height) });
    }
  }

  function endGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    const point = g.pointers.get(event.pointerId);
    if (!point) return;
    g.pointers.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);

    if (g.mode === "pinch") {
      if (g.pointers.size >= 2) return;
      const collapsed = zoom < 1.05;
      settle(collapsed ? 1 : zoom, collapsed ? { x: 0, y: 0 } : pan);
      // The remaining finger keeps its capture and becomes a drag. Clearing the map here — which is
      // what this used to do — threw that pointer's id away, so its own pointerup bailed out before
      // `releasePointerCapture` and the capture was never given back.
      const rest = [...g.pointers.entries()][0];
      if (rest) armDrag(g, rest[1], event.timeStamp);
      else g.mode = "none";
      return;
    }

    const mode = g.mode;
    g.mode = "none";

    if (mode === "page") {
      const flick = Math.abs(g.velocity.x) > m.pageCommit.velocity;
      const dragged = Math.abs(dragX) > frame.width * m.pageCommit.distance;
      // Direction follows whichever test fired. Taking it from `dragX` alone paged FORWARD on a drag
      // 8px left followed by a hard flick right.
      const direction = flick ? (g.velocity.x < 0 ? 1 : -1) : dragX < 0 ? 1 : -1;
      // Armed before the branch, because `page` refuses to run past either end and the track still
      // has to slide back to centre from wherever the finger left it.
      beginMotion("page");
      setDragX(0);
      if (flick || dragged) page(direction);
      return;
    }

    if (mode === "dismiss") {
      if (drop.y > m.dismiss.distance || g.velocity.y > m.dismiss.velocity) {
        // Reset the drop as well as closing. Leaving it committed pinned `dropProgress` at its
        // release value, so the chrome stayed hidden, the ground stayed dimmed and the exit reversed
        // out of the dropped pose instead of the fitted one — and an uncontrolled viewer, whose
        // `open` never goes false, was stuck mid-drop for good.
        setDrop({ x: 0, y: 0 });
        beginMotion("settle");
        onClose?.();
        return;
      }
      beginMotion("bounce");
      setDrop({ x: 0, y: 0 });
      return;
    }

    if (mode === "pan") {
      const limit = panLimit(zoom);
      const outside = Math.abs(pan.x) > limit.x || Math.abs(pan.y) > limit.y;
      settle(zoom, pan, outside ? "bounce" : "settle");
      return;
    }

    if (mode !== "undecided") return;

    // A tap. Two in a row toggle the zoom; one on its own toggles the chrome, after waiting out the
    // window in which a second tap could still arrive.
    const doubled = event.timeStamp - g.tapTime < m.doubleTap.window && Math.hypot(point.x - g.tapPoint.x, point.y - g.tapPoint.y) < m.doubleTap.slop;
    g.tapTime = doubled ? 0 : event.timeStamp;
    g.tapPoint = point;
    window.clearTimeout(tapTimer.current);
    if (doubled) {
      doubleTap(point, event.timeStamp);
      return;
    }
    if (!m.allowChromeHiding) return;
    const stamp = event.timeStamp;
    tapTimer.current = window.setTimeout(() => {
      if (gesture.current.tapTime === stamp) setChrome(!chromeVisible);
    }, m.doubleTap.window);
  }

  function doubleTap(point: Point, timeStamp: number) {
    const g = gesture.current;
    window.clearTimeout(tapTimer.current);
    g.tapTime = 0;
    // Real iOS Safari can coalesce a double tap into one pointer pair and a dblclick. Desktop
    // browsers emit both pairs and dblclick, so consume either path exactly once.
    if (timeStamp - g.doubleTapTime < m.doubleTap.window) return;
    g.doubleTapTime = timeStamp;
    const displayed = { x: frame.width / 2 + pan.x - fit.width * zoom / 2, y: frame.height / 2 + pan.y - fit.height * zoom / 2, width: fit.width * zoom, height: fit.height * zoom };
    if (m.allowDoubleTapZoom && doubleTapTarget(point, displayed, frame, { top: headerBand, bottom: footerBand })) {
      zoomAbout(zoom > 1 ? 1 : m.doubleTapZoom, point);
    }
  }

  function cancelGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    for (const id of g.pointers.keys()) {
      if (event.currentTarget.hasPointerCapture(id)) event.currentTarget.releasePointerCapture(id);
    }
    g.pointers.clear();
    g.mode = "none";
    g.tapTime = 0;
    window.clearTimeout(tapTimer.current);
    setDragX(0);
    setDrop({ x: 0, y: 0 });
    settle(zoom, pan, "bounce");
  }

  // A trackpad pinch arrives as a ctrl-wheel, which is how a photo zooms on macOS. React attaches
  // `wheel` passively, so preventing the page from zooming needs a listener of our own.
  useEffect(() => {
    const node = zoomLayer.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      zoomAbout(clamp(zoom * (1 - event.deltaY / 100), 1, m.maxZoom), localPoint(event.clientX, event.clientY));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [zoom, zoomAbout, localPoint, m.maxZoom]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      setChrome(true);
      // `aria-modal` promises the rest of the page is inert, so Tab has to stay inside. Without this
      // the first Tab walked straight out into the conversation behind the viewer.
      const focusable = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? []).filter(
        node => node.offsetParent !== null,
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === root.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || active === root.current)) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (tapbackOpen) {
        setTapbackOpen(false);
        root.current?.focus({ preventScroll: true });
      } else onClose?.();
      return;
    }
    if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && zoom === 1) {
      event.preventDefault();
      page(event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAbout(clamp(zoom * 1.5, 1, m.maxZoom), { x: frame.width / 2, y: frame.height / 2 });
      return;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomAbout(clamp(zoom / 1.5, 1, m.maxZoom), { x: frame.width / 2, y: frame.height / 2 });
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      settle(1, { x: 0, y: 0 });
    }
  }

  /* ------------------------------------------------------------------ painting */

  // The balloon's measured slot hangs it outside the bubble's trailing edge, which works over a
  // bubble and does not over a photo whose trailing edge can be the screen's. Keep the slot, then
  // pull it back inside the frame by the same edge inset a bubble keeps, and below the header.
  const balloon = balloonSlot[platform];
  const balloonSize = balloonGeometry[platform].main;
  const balloonLeft = Math.min(fit.x + fit.width + balloon.side, frame.width - balloonSize - bubbleMetrics[platform].edgeInset);
  const balloonTop = Math.max(headerBand, fit.y + balloon.top);

  const chromeAlpha = chromeVisible && dropProgress === 0 ? 1 : 0;
  const barTransition = scrubbed ? "none" : `opacity ${m.timing.chrome}ms linear`;
  const trackTransition = scrubbed || motion === "none" ? "none" : `transform ${m.timing.page}ms ${m.ease}`;
  const photoDuration = motion === "bounce" ? m.timing.bounce : m.timing.zoom;
  const photoTransition = scrubbed || motion === "none" ? "none" : `transform ${photoDuration}ms ${m.ease}`;

  // The ground under the chrome is measured black in both themes, so the picker's glass takes the
  // dark tokens whatever the page's theme is.
  const vars = tapbackVars("dark", platform) as CSSProperties;

  const photo = photos[index];
  const position = count > 1 ? `attachment ${index + 1} of ${count}` : "";
  const visible = pageWindow(index, count);

  const glass: CSSProperties = {
    background: m.glass.fill,
    backdropFilter: `blur(${m.glass.blur}px)`,
    WebkitBackdropFilter: `blur(${m.glass.blur}px)`,
    boxShadow: `inset 0 0 0 0.5px ${m.glass.rim}`,
  };

  const discButton = (size: number): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: size,
    height: size,
    borderRadius: "50%",
    border: 0,
    padding: 0,
    color: m.glass.ink,
    fontFamily: "inherit",
    cursor: "default",
    ...glass,
  });

  return (
    <div
      ref={root}
      data-slot="image-viewer"
      data-platform={platform}
      role="dialog"
      aria-modal="true"
      aria-label={title ?? "Photo"}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // A stacking context keeps transcript reactions and earlier modal surfaces below every layer.
      className={cn("absolute inset-0 z-50 isolate select-none overflow-hidden outline-none", className)}
      // WebKit supports this legacy value to bypass its low-quality animated-resize heuristic.
      style={{ fontFamily: fontStack, touchAction: "none", imageRendering: "optimizeQuality" as CSSProperties["imageRendering"], ...vars, ...style }}
      {...props}
    >
      {/* The ground: measured black in both themes, so it does not follow the palette.
          `-interactiveTransitionBackgroundDimming` = 0.5 is how far it dims under a drag — it does
          not clear away entirely, so the conversation shows through at half strength.

          TWO nested layers, and the nesting is the fix. The drag's dimming used to be an inline
          `opacity` on the same element the entrance animates, so it was written and then ignored:
          `document.getAnimations()` showed the entrance holding this element at `fill: "both"`,
          progress 1, and a filling animation beats an inline style. Measured at
          `?scene=photo-viewer-dismiss&t=200`, where the drag is two thirds of the way to committing:
          inline `opacity: 0.666667`, computed `1`. So the ground stayed solid black through every
          drag and the conversation never showed through at all. The outer layer carries the drag,
          which no animation touches; the inner one keeps the entrance. Opacity multiplies through
          the nesting, which is the composition that was wanted in the first place. */}
      <div aria-hidden="true" data-slot="viewer-dimming" style={{ position: "absolute", inset: 0, opacity: 1 - m.dismissDimming * dropProgress }}>
        <div
          ref={backdrop}
          data-slot="viewer-ground"
          style={{ position: "absolute", inset: 0, background: m.ground }}
        />
      </div>

      <div ref={zoomLayer} data-slot="viewer-zoom" style={{ position: "absolute", inset: 0, transformOrigin: "0 0" }}>
        <div
          data-slot="viewer-stage"
          role="group"
          aria-label={["Photo", position].filter(Boolean).join(", ")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={cancelGesture}
          onDoubleClick={event => { event.preventDefault(); doubleTap(localPoint(event.clientX, event.clientY), event.timeStamp); }}
          style={{ position: "absolute", inset: 0 }}
        >
          <div
            data-slot="viewer-track"
            style={{ position: "absolute", inset: 0, transform: `translateX(${trackX}px)`, transition: trackTransition, willChange: "transform" }}
          >
            {/* Only `-userNavigationMaximumDistance` items either side are in the tree: a twenty-photo
                message used to mount twenty full-resolution images at once. */}
            {visible.map(i => {
              const item = photos[i];
              const active = i === index;
              // Every page's photo lags its own page by 1/parallaxFactor of that page's offset, so a
              // swipe does not slide the whole strip as one sheet. At rest the active page's is 0.
              const parallax = -(trackX + i * pitch) / m.parallaxFactor;
              const box = fitPhotoRect(aspectOf(item), frame);
              const offset = active
                ? { x: pan.x + shift.x + parallax, y: pan.y + shift.y, scale: zoom * dropScale }
                : { x: parallax, y: 0, scale: 1 };
              return (
                <div key={`${item.src}-${i}`} data-slot="viewer-page" data-index={i} aria-hidden={!active} style={{ position: "absolute", left: i * pitch, top: 0, width: frame.width, height: frame.height }}>
                  <div
                    data-slot="viewer-photo"
                    style={{
                      position: "absolute",
                      left: box.x,
                      top: box.y,
                      width: box.width,
                      height: box.height,
                      transform: `translate(${offset.x}px, ${offset.y}px) scale(${offset.scale})`,
                      transformOrigin: "center center",
                      transition: active ? photoTransition : "none",
                      willChange: "transform",
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.src}
                      alt={item.alt ?? "Photo"}
                      draggable={false}
                      decoding="async"
                      loading={Math.abs(i - index) <= 1 ? "eager" : "lazy"}
                      onLoad={event => {
                        const image = event.currentTarget;
                        if (!image.naturalWidth || !image.naturalHeight) return;
                        setAspects(known => (known[item.src] ? known : { ...known, [item.src]: image.naturalWidth / image.naturalHeight }));
                      }}
                      style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", pointerEvents: "none" }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div ref={chromeLayer} data-slot="viewer-chrome" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {/* A reaction on the photo: the same balloon a bubble carries, on the photo's top trailing
            corner and clamped so it never rides under the header or off the frame. The slot is the
            measured bubble one, because no capture shows a balloon on a full-screen photo, so its
            placement here is JUDGEMENT. It lives in the chrome layer so it fades up with the rest of
            the overlay instead of hanging in the air while the photo is still zooming. */}
        {reaction && (
          <div data-slot="viewer-reaction" style={{ position: "absolute", left: balloonLeft, top: balloonTop, opacity: 1 - dropProgress }}>
            <Tapback
              platform={platform}
              side="left"
              own
              reaction={"type" in reaction ? reaction.type : undefined}
              emoji={"emoji" in reaction ? reaction.emoji : undefined}
            />
            {reactionAttribution && (
              <span
                data-slot="viewer-reaction-attribution"
                style={{ position: "absolute", top: balloonSize + 4, right: 0, whiteSpace: "nowrap", fontSize: 11, lineHeight: 1.2, color: m.glass.ink, opacity: 0.72 }}
              >
                {reactionAttribution}
              </span>
            )}
          </div>
        )}

        {/* `-allowStatusBar` = 1, and the capture shows it: white ink over the black ground, drawn
            with the same component the conversation uses, forced to its dark values. */}
        {showStatusBar && (
          <div
            data-slot="viewer-status-bar"
            aria-hidden="true"
            style={{ position: "absolute", left: 0, right: 0, top: 0, opacity: chromeAlpha, transition: barTransition }}
          >
            <IosStatusBar
              time={time}
              style={
                {
                  "--ios-sb-label": "#ffffff",
                  "--ios-sb-dot": "#333333",
                  "--ios-sb-battery": "#666666",
                  "--ios-sb-nub": "#808080",
                } as CSSProperties
              }
            />
          </div>
        )}

        {/* Header. One glass disc on the trailing side, `accessibilityLabel` "close" — there is no
            "Done" text button and no title view in the measured chrome. `title`/`subtitle` render
            only when a caller asks for them. */}
        <div
          data-slot="viewer-header"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: inset.top,
            height: chromeBox.header.size,
            paddingInline: chromeBox.header.inset,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            opacity: chromeAlpha,
            transition: barTransition,
            pointerEvents: chromeAlpha ? "auto" : "none",
          }}
        >
          {(title || subtitle || (pageIndicator && count > 1)) && (
            <div
              data-slot="viewer-title"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 0,
                height: chromeBox.header.size,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
                color: m.glass.ink,
              }}
            >
              {title && <span style={{ fontSize: 15, lineHeight: 1.2 }}>{title}</span>}
              {(subtitle || (pageIndicator && count > 1)) && (
                <span style={{ display: "flex", gap: 6, fontSize: 11, lineHeight: 1.2, opacity: 0.72 }}>
                  {subtitle && <span>{subtitle}</span>}
                  {pageIndicator && count > 1 && <span>{`${index + 1} of ${count}`}</span>}
                </span>
              )}
            </div>
          )}
          <button type="button" data-slot="viewer-close" aria-label="close" onClick={onClose} style={discButton(chromeBox.header.size)}>
            <CloseIcon size={m.glyph.close} />
          </button>
        </div>

        {/* Footer. MEASURED: reply on the leading edge, share on the trailing edge, both Ø48 discs
            28 in from their own edge and 28 up from the bottom. The reply button is always drawn and
            is disabled without a handler, the way `-shouldShowReplyButtonForMediaObject:` disables
            it natively. Save and tapback are UNMEASURED additions in the trailing group. */}
        <div
          data-slot="viewer-footer"
          style={{
            position: "absolute",
            left: chromeBox.footer.inset,
            right: chromeBox.footer.inset,
            bottom: chromeBox.footer.bottom,
            height: chromeBox.footer.size,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            opacity: chromeAlpha,
            transition: barTransition,
            pointerEvents: chromeAlpha ? "auto" : "none",
          }}
        >
          {/* LEADING GROUP: tapback then reply. MEASURED, in the **iOS** build of
              `-[CKQLPreviewController updateBarButtonItems]` — see `imageViewerMetrics.footerGroups`
              for the reading and for why the earlier "ChatKit builds no bars" note was a Catalyst
              artefact. The gap between two discs in a group is UNMEASURED; 8 is carried over from
              the trailing group, which was invented the same way. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {onReact && (
              <button
                type="button"
                ref={tapbackButton}
                data-slot="viewer-tapback"
                aria-label={reaction ? "Change reaction" : "Add a reaction"}
                aria-expanded={tapbackOpen}
                onClick={() => setTapbackOpen(!tapbackOpen)}
                style={discButton(chromeBox.footer.size)}
              >
                {reaction ? (
                  <TapbackGlyph type={"type" in reaction ? reaction.type : undefined} emoji={"emoji" in reaction ? reaction.emoji : undefined} size={m.glyph.tapback} />
                ) : (
                  <SmileyIcon size={m.glyph.tapback} color={m.glass.ink} strokeWidth={1.6} />
                )}
              </button>
            )}
            <button
              type="button"
              data-slot="viewer-reply"
              aria-label="reply"
              disabled={!onReply}
              onClick={onReply}
              style={{ ...discButton(chromeBox.footer.size), opacity: onReply ? 1 : undefined, color: onReply ? m.glass.ink : `rgba(243,243,243,${m.glass.disabledInk})` }}
            >
              {/* The reply symbol does not sit centred in its button: its ink centre measures 1.17
                  left and 0.17 below the disc's, which is the symbol's own content insets showing
                  through. */}
              <span style={{ display: "inline-flex", transform: `translate(${m.glyph.reply.offsetX}px, ${m.glyph.reply.offsetY}px)` }}>
                <ReplyIcon width={m.glyph.reply.width} height={m.glyph.reply.height} />
              </span>
            </button>
          </div>
          {/* TRAILING GROUP: save, then QuickLook's own share. `updateBarButtonItems` always adds the
              save item to the right array; share is not ChatKit's at all. The gap is UNMEASURED. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {onSave && (
              <button type="button" data-slot="viewer-save" aria-label="Save photo" aria-pressed={saved} onClick={onSave} style={discButton(chromeBox.footer.size)}>
                <SaveIcon width={m.glyph.save.width} height={m.glyph.save.height} saved={saved} />
              </button>
            )}
            <button type="button" data-slot="viewer-share" aria-label="Share" onClick={onShare} style={discButton(chromeBox.footer.size)}>
              <ShareIcon width={m.glyph.share.width} height={m.glyph.share.height} />
            </button>
          </div>
        </div>

        {(tapbackOpen || tapbackClosing) && (
          <ViewerTapbackPicker
            platform={platform}
            open={tapbackOpen}
            scrubbed={scrubbed}
            selected={reaction ?? undefined}
            recent={recent}
            width={pickerWidth}
            bottom={pickerBottom}
            left={pickerInset}
            pickerX={pickerX}
            onSelect={selection => {
              onReact?.(selection);
              setTapbackOpen(false);
              root.current?.focus({ preventScroll: true });
            }}
            onClose={() => {
              setTapbackOpen(false);
              root.current?.focus({ preventScroll: true });
            }}
            onExited={() => setTapbackClosing(false)}
          />
        )}
      </div>

      {/* One string per item, so it announces on an index change and stays silent on every other
          render: identical text written back into a live region is not re-announced. */}
      <span aria-live="polite" className="sr-only">{[photo?.alt || "Photo", position].filter(Boolean).join(", ")}</span>
    </div>
  );
}

/** Rubber-banded past `edge`, one-for-one inside it. */
function band(value: number, edge: number, dimension: number) {
  return Math.abs(value) > edge ? Math.sign(value) * edge + rubberBand(value - Math.sign(value) * edge, dimension) : value;
}

/**
 * The reaction picker over a full-screen photo: the same `TapbackBar` a bubble gets, floated above
 * the footer instead of above a balloon, because a full-screen photo has no bubble to hang off.
 * `CKQLPreviewController -tapbackButtonFrameForFullScreenBalloonViewController:` anchors it on the
 * toolbar's tapback button.
 *
 * Its thought bubble points DOWN at that button.
 * `-fullScreenBalloonViewControllerPickerViewUsesBottomTail:` is not a constant, though the docblock
 * here used to say so: it disassembles to `CGRectGetMinY(tapbackButtonFrame)` compared against
 * `CGRectGetMaxY(navigationBar.frame)` and returns 1 only when the button sits at or below the nav
 * bar's bottom (and when the frame is empty). The tapback button is in the FOOTER, always below the
 * header (footer button top = height - 76, header bottom = 106 on a 402x874 frame), so this layout
 * always takes the bottom-tail branch — but it takes it because the geometry says so, not because
 * the method is a constant.
 *
 * Its dismissal takes `CKUIBehaviorPhone -tapbackDismissalDuration`, 0.5 s. Its entrance has no
 * framework value: JUDGEMENT, the same 0.2 s the chrome fades in over.
 */
function ViewerTapbackPicker({
  platform,
  open,
  scrubbed,
  selected,
  recent,
  width,
  bottom,
  left,
  pickerX,
  onSelect,
  onClose,
  onExited,
}: {
  platform: Platform;
  open: boolean;
  scrubbed: boolean;
  selected?: TapbackSelection;
  recent?: string[];
  width: number;
  bottom: number;
  left: number;
  pickerX: number;
  onSelect: (selection: TapbackSelection) => void;
  onClose: () => void;
  onExited: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const m = imageViewerMetrics;
  // Same reason as the viewer's own exit: an inline `onExited` must not restart the dismissal.
  const onExitedRef = useRef(onExited);
  useLayoutEffect(() => {
    onExitedRef.current = onExited;
  });

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const reduced = prefersReducedMotion();
    if (open) {
      done.current = false;
      if (reduced || scrubbed) return;
      const animation = node.animate(
        [
          { opacity: 0, transform: "translateY(8px) scale(0.92)" },
          { opacity: 1, transform: "translateY(0px) scale(1)" },
        ],
        { duration: m.timing.chrome, easing: m.ease, fill: "both" },
      );
      return () => animation.cancel();
    }
    const finish = () => {
      if (done.current) return;
      done.current = true;
      onExitedRef.current();
    };
    if (reduced) {
      const id = window.setTimeout(finish, 0);
      return () => window.clearTimeout(id);
    }
    const animation = node.animate(
      [
        { opacity: 1, transform: "translateY(0px) scale(1)" },
        { opacity: 0, transform: "translateY(8px) scale(0.92)" },
      ],
      { duration: m.timing.tapbackDismiss, easing: m.ease, fill: "forwards" },
    );
    animation.addEventListener("finish", finish);
    return () => {
      animation.removeEventListener("finish", finish);
      animation.cancel();
    };
  }, [open, scrubbed, m.timing.chrome, m.timing.tapbackDismiss, m.ease]);

  // The pill's recents run past its trailing edge and are reached by scrolling, which is what the
  // capture of the bar over a bubble shows too. The viewer's root sets `touch-action: none` so its
  // own gestures work, which left that scroll unreachable on a touch device; the picker takes it back.
  const scrollable: CSSProperties = { touchAction: "pan-x" };

  if (platform === "macos") {
    // UNVERIFIED, like the rest of the macOS presentation: the two-row picker lives in a context menu
    // natively, so over a photo it is given the menu's own surface as a floating panel, centred on
    // the same tapback button the iOS pill points at. The panel keeps its own centring transform and
    // the host carries the entrance, because one element cannot hold both: an animated `transform`
    // replaces the inline one outright.
    return (
      <div
        ref={host}
        data-slot="viewer-tapback-picker"
        style={{ position: "absolute", bottom, left: 0, right: 0, height: 0, pointerEvents: "none", transformOrigin: `${left + pickerX}px 100%`, ...scrollable }}
      >
        <div
          data-slot="viewer-tapback-panel"
          style={{
            position: "absolute",
            bottom: 0,
            left: left + pickerX,
            transform: "translateX(-50%)",
            borderRadius: 12,
            background: "var(--im-menu-bg, rgba(30,34,39,0.92))",
            boxShadow: "0 12px 40px rgba(0,0,0,0.5), inset 0 0 0 0.5px var(--im-menu-rim, rgba(255,255,255,0.28))",
            backdropFilter: "blur(30px) saturate(1.6)",
            WebkitBackdropFilter: "blur(30px) saturate(1.6)",
            color: "var(--im-menu-text, #dcddde)",
            pointerEvents: "auto",
          }}
        >
          <TapbackBar layout="macos" selected={selected} recent={recent} onSelect={onSelect} onClose={onClose} autoFocus={!scrubbed} />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={host}
      data-slot="viewer-tapback-picker"
      style={{ position: "absolute", bottom, left, width, pointerEvents: "auto", transformOrigin: `${pickerX}px 100%`, ...scrollable }}
    >
      <TapbackBar layout="ios" selected={selected} recent={recent} onSelect={onSelect} onClose={onClose} autoFocus={!scrubbed} pickerX={pickerX} pickerSide="left" width={width} />
    </div>
  );
}

/**
 * The two bars' AREAS, i.e. each bar's band grown by `barsAreaVerticalOutset`. This is what
 * `doubleTapTarget` excludes, so anything testing or reusing that needs the same derivation.
 */
export type ImageViewerChrome = { header: number; footer: number };
export function imageViewerChromeBands(platform: Platform, safeArea?: { top?: number; bottom?: number }): ImageViewerChrome {
  const box = imageViewerMetrics.chrome[platform];
  const inset = { ...box.safeArea, ...safeArea };
  return {
    header: inset.top + box.header.size + imageViewerMetrics.barsOutset,
    footer: box.footer.bottom + box.footer.size + imageViewerMetrics.barsOutset,
  };
}
