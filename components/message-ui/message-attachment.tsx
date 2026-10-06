"use client";

import { useId, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { bubblePath, tailBox } from "@/components/message-ui/bubble-shape";
import { usePlatform, type Platform } from "@/components/message-ui/platform";

/**
 * A file attachment message: the document card Messages draws instead of a text bubble.
 *
 * macOS numbers are measured from `references/macos/captures/attachment-not-delivered-dark-2x.png`
 * (960×640 @2x, so every pixel pair is one point):
 *
 * | Part | Measurement |
 * |---|---|
 * | Card | body 275 × 88.75 (x 17–292, y 5.5–94.4 in the crop), plus the 0.7-scale tail hanging 4.6 |
 * | Corner | best circle 14.5 (rmse 0.28 px on both top corners); the earlier 18 was off by 2.7 px |
 * | Fill | #3b3b3d dark (the incoming gray — file cards are gray in both directions) |
 * | Icon | 38.6 × 51.6 page at (22.7, 18.6) inside the card, 14 fold, 2 corner radius |
 * | Filename | 12pt semibold #f7f7f7 tracked −0.5 (ink 90.0 × 11.0, x-height 6.6), ink left 84.5, baseline 43.5 |
 * | Subtitle | 11pt #a6a6a9 tracked −0.45 (ink 128.5 × 10.0), ink left 84.0, baseline 58.5 |
 * | Failed | #eb534e ring, outer Ø 16.5, stroke 1.2; left edge 9.5 past the card, centre at 50.25 (body centre + 0.4) |
 * | Not Delivered | 10pt semibold #eb534e, ink 60.0 × 7.0, right ink edge 11.0 past the card's trailing edge |
 *
 * The corner is really a continuous one (superellipse radius 17.4, exponent 2.5, rmse 0.08 px), the same
 * shape the compact link card shows. `bubblePath` draws circular arcs so the card takes the best circle.
 * The badge and the label live in `ios-notices.tsx`; the numbers above are what they have to hit.
 *
 * `titleTop` and `subtitleTop` are the two baselines minus Chrome's baseline offset inside their line
 * boxes (12 for 12/15, 11 for 11/13), so the ink lands on the native baseline whenever the card sits on
 * whole points. A host that offsets the card by half a point (`/lab/ios-screens?scene=attachment` does,
 * through a `translateY(0.5px)`) puts the whole subtree in a composited layer whose text snaps a point at
 * a time, so every glyph and the icon land half a point off; that is the host's, not the card's.
 *
 * The iOS variant is that layout re-proportioned for the 17/13pt type world. **It is not verified
 * against a capture** — no iOS attachment frame exists in `references/` — so treat its numbers as a
 * considered guess, not a measurement.
 */

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

/**
 * macOS is measured off the dark crop. iOS keeps the same shape but takes its own measured grays, the
 * incoming bubble (#e9e9eb / #262629) and the secondary label (#8a8a8e / #8d8d93): #3b3b3d is the macOS
 * incoming gray and reads wrong beside iOS bubbles.
 */
const vars: Record<Platform, string> = {
  macos:
    "[--im-att-fill:#e9e9eb] [--im-att-title:#000000] [--im-att-subtitle:#6e6e6d] " +
    "dark:[--im-att-fill:#3b3b3d] dark:[--im-att-title:#f7f7f7] dark:[--im-att-subtitle:#a6a6a9]",
  ios:
    "[--im-att-fill:#e9e9eb] [--im-att-title:#000000] [--im-att-subtitle:#8a8a8e] " +
    "dark:[--im-att-fill:#262629] dark:[--im-att-title:#ffffff] dark:[--im-att-subtitle:#8d8d93]",
};

type AttachmentMetrics = {
  width: number; height: number; radius: number; tailScale: number;
  iconWidth: number; iconHeight: number; iconLeft: number; iconTop: number;
  textLeft: number; textRight: number;
  titleSize: number; titleLine: number; titleTop: number; titleTracking: number;
  subtitleSize: number; subtitleLine: number; subtitleTop: number; subtitleTracking: number;
};

/** macOS is measured; iOS is the same layout scaled to 17/13pt type and is unverified. */
export const attachmentMetrics: Record<Platform, AttachmentMetrics> = {
  macos: {
    width: 275, height: 88.75, radius: 14.5, tailScale: 0.7,
    iconWidth: 38.6, iconHeight: 51.6, iconLeft: 22.7, iconTop: 18.6,
    textLeft: 83.75, textRight: 12,
    titleSize: 12, titleLine: 15, titleTop: 31.5, titleTracking: -0.5,
    subtitleSize: 11, subtitleLine: 13, subtitleTop: 47.5, subtitleTracking: -0.45,
  },
  ios: {
    width: 280.5, height: 100, radius: 19, tailScale: 1,
    iconWidth: 44, iconHeight: 58, iconLeft: 18, iconTop: 21,
    textLeft: 74, textRight: 14,
    titleSize: 17, titleLine: 22, titleTop: 31, titleTracking: 0,
    subtitleSize: 13, subtitleLine: 16, subtitleTop: 53, subtitleTracking: 0,
  },
};

/**
 * The page with a folded corner that macOS draws for a generic document, traced off the same crop.
 *
 * The user space is the page's own 38.6 × 51.6 box. Its top-right corner is cut at 45° over the last 14,
 * and the flap folds back onto the page as the triangle (24.6,0)–(38.6,14)–(24.6,14). Sampling the crop on
 * a grid gives a flat #f5f5f5 body shading one level per point of distance along the (1,−1) diagonal, down
 * to about #e0e0e0 at the cut; the flap runs the other way, #e7e7e7 at the cut up to #ffffff about 4.6 in,
 * and drops a short shadow along its two straight edges. The page sits on a soft shadow of its own (peak
 * alpha ≈ 0.3 at the bottom edge, gone by 3 out).
 *
 * `preserveAspectRatio="none"` because the drawing is the box: any letterboxing would offset the whole
 * page by a fraction of a point against the card.
 */
function DocumentIcon({ width, height }: { width: number; height: number }) {
  const id = useId();
  return (
    <svg aria-hidden="true" width={width} height={height} viewBox="0 0 38.6 51.6" preserveAspectRatio="none"
      style={{ display: "block", overflow: "visible", filter: "drop-shadow(0 0.45px 1.2px rgba(0,0,0,0.42))" }}>
      <defs>
        {/* Both ramps run along the page's (1,−1) diagonal, in the page's own coordinates. */}
        <linearGradient id={`${id}-page`} gradientUnits="userSpaceOnUse" x1="10.74" y1="14.28" x2="25.02" y2="0">
          <stop offset="0" stopColor="#f5f5f5" />
          <stop offset="1" stopColor="#e0e0e0" />
        </linearGradient>
        <linearGradient id={`${id}-flap`} gradientUnits="userSpaceOnUse" x1="31.6" y1="7" x2="28.35" y2="10.25">
          <stop offset="0" stopColor="#e7e7e7" />
          <stop offset="1" stopColor="#ffffff" />
        </linearGradient>
        <linearGradient id={`${id}-crease-x`} gradientUnits="userSpaceOnUse" x1="21.6" y1="0" x2="24.6" y2="0">
          <stop offset="0" stopColor="#000000" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.09" />
        </linearGradient>
        <linearGradient id={`${id}-crease-y`} gradientUnits="userSpaceOnUse" x1="0" y1="14" x2="0" y2="16">
          <stop offset="0" stopColor="#000000" stopOpacity="0.06" />
          <stop offset="1" stopColor="#000000" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M2 0h22.6l14 14v35.6a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2z" fill={`url(#${id}-page)`} />
      <rect x="21.6" y="0" width="3" height="14" fill={`url(#${id}-crease-x)`} />
      <rect x="24.6" y="14" width="14" height="2" fill={`url(#${id}-crease-y)`} />
      <path d="M24.6 0l14 14H24.6z" fill={`url(#${id}-flap)`} />
    </svg>
  );
}

export type MessageAttachmentProps = Omit<ComponentProps<"div">, "children" | "title"> & {
  /** File name, e.g. "design-notes.txt". */
  name: string;
  /** Kind, e.g. "Text Document". Joined with `size` by a middle dot. */
  kind?: string;
  /** Human size, e.g. "275 bytes". Used alone when `kind` is absent. */
  size?: string;
  /** Overrides the whole second line. */
  subtitle?: ReactNode;
  /** Turns the card into a link. */
  href?: string;
  download?: boolean;
  onOpen?: () => void;
  direction?: "incoming" | "outgoing";
  /** The card only tails when it ends a cluster, exactly like a text bubble. */
  tail?: boolean;
  platform?: Platform;
  /** Custom artwork in place of the document page (a thumbnail, say). */
  icon?: ReactNode;
};

export function MessageAttachment({
  name, kind, size, subtitle, href, download, onOpen,
  direction = "outgoing", tail = false, platform: platformProp, icon, className, style, ...props
}: MessageAttachmentProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const m = attachmentMetrics[platform];
  const side = direction === "outgoing" ? "right" : "left";
  const hang = tailBox.hang * m.tailScale;
  const secondLine = subtitle ?? (kind && size ? `${kind} · ${size}` : (kind ?? size));

  const surface: CSSProperties = { background: "var(--im-att-fill)" };
  const Inner = href ? "a" : onOpen ? "button" : "div";
  const innerProps = href
    ? { href, download, target: href.startsWith("http") ? "_blank" : undefined, rel: href.startsWith("http") ? "noreferrer" : undefined }
    : onOpen ? { type: "button" as const, onClick: onOpen } : {};

  return (
    <div data-slot="message-attachment" data-direction={direction} data-platform={platform}
      className={cn("relative select-none", vars[platform], className)}
      style={{ width: m.width, height: m.height, fontFamily: font, ...style }} {...props}>
      {/*
        Body and tail are one clipped box, not two adjacent ones. Chrome rasterises two abutting
        clip paths independently and snaps the second to a whole device pixel, which left a 1px
        hairline of the page showing along the tail's leading and top edges at 2x (the card's
        88.75 height puts that join on a half device pixel).
      */}
      <div aria-hidden="true" data-slot="fill" className="pointer-events-none absolute left-0 top-0 w-full"
        style={tail
          ? { height: m.height + hang, clipPath: `path("${bubblePath(m.width, m.height, side, m.radius, m.tailScale)}")`, ...surface }
          : { height: m.height, borderRadius: m.radius, ...surface }} />
      <Inner data-slot="card" {...innerProps}
        className="absolute inset-0 block text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0088ff]"
        style={{ borderRadius: m.radius }}>
        <span aria-hidden="true" data-slot="icon" className="absolute flex items-center justify-center"
          style={{ left: m.iconLeft, top: m.iconTop, width: m.iconWidth, height: m.iconHeight }}>
          {icon ?? <DocumentIcon width={m.iconWidth} height={m.iconHeight} />}
        </span>
        <span data-slot="name" className="absolute block overflow-hidden text-ellipsis whitespace-nowrap"
          style={{ left: m.textLeft, right: m.textRight, top: m.titleTop, fontSize: m.titleSize, lineHeight: `${m.titleLine}px`, fontWeight: 600, letterSpacing: m.titleTracking, color: "var(--im-att-title)" }}>
          {name}
        </span>
        {secondLine !== undefined && (
          <span data-slot="subtitle" className="absolute block overflow-hidden text-ellipsis whitespace-nowrap"
            style={{ left: m.textLeft, right: m.textRight, top: m.subtitleTop, fontSize: m.subtitleSize, lineHeight: `${m.subtitleLine}px`, letterSpacing: m.subtitleTracking, color: "var(--im-att-subtitle)" }}>
            {secondLine}
          </span>
        )}
      </Inner>
    </div>
  );
}
