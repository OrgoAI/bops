import type { ComponentProps, CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * Contact avatar: initials over the native gray-blue gradient, a photo, or the generic silhouette.
 *
 * **Fill.** A vertical linear gradient across the circle's own box: light #a9c2e1 → #747fb9, dark
 * #575368 → #302649. Fitted to the Ø45 row avatars in `references/ios/captures/list-light.png` and
 * `list-dark.png`, and re-fitted independently to the Ø60 nav-bar avatar in `conv3-light.png`, which
 * returns the same endpoints (max residual 0.7/255 against a straight line). The gradient does not
 * change with the circle's size.
 *
 * **Initials.** White, weight 600, at **7/15 of the diameter** (0.4667). Three diameters in the
 * captures pin that ratio, and Chrome reproduces each one's ink exactly:
 *
 * | Where | Ø | Type | Native ink | Chrome at 3x |
 * |---|---|---|---|---|
 * | List row (`list-light.png`), circle x 26-71 y 188-233 | 45 | 21 | "JA" 24.67 wide, cap 15.00, ink top 15.33 below the circle | 24.67 wide, ink top 15.33 |
 * | Nav bar (`conv3-light.png`), circle x 171-231 y 62-122 | 60 | 28 | "JA" 32.67 wide, cap 19.67, ink top 20.33 below the circle | 33.00 wide, ink top 20.67 |
 * | Details (`details-light.png`), circle x 161-241 y 62-142 | 80 | 37.33 | "JA" 44.00 wide, cap 26.67, ink top 27.00 below the circle | 44.00 wide, ink top 27.00 |
 *
 * Chrome rasterises the caps one to two device px taller than the simulator, so no offset can land both
 * edges. `translateY(0.02em)` puts the ink *top* on native at Ø45 and Ø80 and one device px low at Ø60,
 * which no other offset beats; the ink then hangs a device px below native. Diffed against the captures
 * that hold an avatar, that leaves 0.74% of Ø45 "JA", 0.62% of Ø45 "KB" and 0.50% of Ø80 "JA" mismatched,
 * all of it glyph edges: the circle and the gradient are exact.
 *
 * **Photo.** A plain circular clip, no rim and no shadow: measured on the Ø40 macOS header avatar in
 * `references/macos/captures/conversation-pane-light.png` (x 592-671, y 16-95 at 2x = 40.0 square).
 *
 * **Silhouette: unverified.** No committed capture has a contact without initials or a photo, so the
 * glyph's proportions are drawn from the SF Symbol, not measured. Do not quote them as measured.
 *
 * `ios-nav-bar.tsx`, `ios-conversation-list.tsx` and `ios-details.tsx` each draw their own circle with
 * their own copy of these values instead of importing this component.
 */
export type AvatarSize = 40 | 45 | 60 | 72 | 80 | number;

export type AvatarProps = Omit<ComponentProps<"span">, "children"> & {
  size?: AvatarSize;
  /** One or two letters. Ignored when `src` is set. */
  initials?: string;
  /** Photo variant. */
  src?: string;
  /** Accessible name; falls back to the initials. */
  name?: string;
};

/** Initials type size for a circle of `size`: the measured 7/15 of the diameter (45 → 21, 60 → 28, 80 → 37.33). */
export function avatarFontSize(size: number): number {
  return (size * 7) / 15;
}

/** The literal value of `fontStack` in tokens.ts, inlined so the avatar installs with no dependencies. */
const fontStack = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "Helvetica Neue", Helvetica, Arial, sans-serif';

export function Avatar({ size = 40, initials, src, name, className, style, ...props }: AvatarProps) {
  const label = name ?? initials ?? "Contact";
  const vars = { "--av-top": "#a9c2e1", "--av-bottom": "#747fb9" } as CSSProperties;
  return (
    <span
      data-slot="avatar"
      data-size={size}
      role="img"
      aria-label={label}
      className={cn("relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full align-middle text-white dark:[--av-bottom:#302649] dark:[--av-top:#575368]", className)}
      style={{
        width: size, height: size, fontSize: avatarFontSize(size), fontWeight: 600, lineHeight: 1, letterSpacing: 0,
        fontFamily: fontStack,
        background: "linear-gradient(var(--av-top), var(--av-bottom))",
        ...vars, ...style,
      }}
      {...props}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- registry components stay framework-neutral
        <img data-slot="avatar-photo" src={src} alt="" className="size-full object-cover" draggable={false} />
      ) : initials ? (
        <span data-slot="avatar-initials" aria-hidden="true" style={{ transform: "translateY(0.02em)" }}>{initials.slice(0, 2)}</span>
      ) : (
        <Silhouette size={size} />
      )}
    </span>
  );
}

/**
 * The generic contact glyph: head above shoulders, white, clipped by the circle.
 * Unverified: no capture in this repo shows a contact without initials or a photo.
 */
function Silhouette({ size }: { size: number }) {
  return (
    <svg data-slot="avatar-silhouette" aria-hidden="true" viewBox="0 0 40 40" width={size} height={size} className="absolute inset-0" fill="#ffffff">
      <circle cx="20" cy="15.5" r="7.5" />
      <path d="M6 40c0-9 5.8-14.5 14-14.5S34 31 34 40Z" />
    </svg>
  );
}
