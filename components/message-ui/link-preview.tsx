"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { usePlatform, type Platform } from "@/components/message-ui/platform";
import { fontStack } from "@/components/message-ui/tokens";

/**
 * The link card Messages shows for a URL without rich metadata: a gray rounded card with the hostname on
 * the left and a Safari compass disc on the right. With `media` (or an `image`) it becomes the rich card:
 * the image on top, then the title and hostname.
 *
 * macOS metrics are measured from the apple.com card in `references/macos/captures/conversation-pane-light.png`
 * and `conversation-pane-dark-2.png` (630x640 pt @2x, so every pixel pair is one point):
 *
 * | Part | Measurement |
 * |---|---|
 * | Card | 140 x 60 (x 470-610, y 179-239 in the light capture), radius 14 |
 * | Fill | #e9e9eb light / #3b3b3d dark (the incoming gray) |
 * | Hostname | "apple.com" ink 49.5 x 10, left ink edge 10 in from the card, baseline 35 below the card top |
 * | Host colour | #808084 light / #a6a6a9 dark |
 * | Disc | 24 x 24, right edge 16 in from the card's right edge (centre 28 in), #757576 light / #a7a7a7 dark |
 * | Content shift | hostname baseline and disc centre both sit 1 below the card's vertical centre |
 *
 * The corner is really one of Apple's continuous corners: a superellipse of radius 17.375 and exponent
 * 2.5 fits the light capture to 0.09 px, where the best circle (14.3) is off by up to 0.27 pt. Radius 14
 * keeps the card on the same circular geometry as the macOS bubble, which is within that error.
 *
 * There is **no native capture of the iOS card or of either rich variant**. iOS reuses what iOS itself
 * measures - the 19 bubble radius, the incoming gray (#e9e9eb / #262629), the secondary label
 * (#8a8a8e / #8d8d93), the 280.5 max bubble width and the 13.85/10 bubble padding - and its card box,
 * hostname size and disc size are the macOS ones re-proportioned for 17pt type. Treat those as a
 * considered guess, not a measurement.
 */
export type LinkPreviewMetrics = {
  width: number;
  height: number;
  radius: number;
  hostSize: number;
  hostLineHeight: number;
  padStart: number;
  disc: number;
  /** Distance from the card's right edge to the disc's right edge. */
  discInsetEnd: number;
  /** Native draws the hostname and disc this much below the card's vertical center. */
  contentShift: number;
  richWidth: number;
  titleSize: number;
  titleLineHeight: number;
  richPadX: number;
  richPadY: number;
};

export const linkPreviewMetrics: Record<Platform, LinkPreviewMetrics> = {
  macos: { width: 140, height: 60, radius: 14, hostSize: 10, hostLineHeight: 12, padStart: 10, disc: 24, discInsetEnd: 16, contentShift: 1, richWidth: 280, titleSize: 12, titleLineHeight: 15, richPadX: 12.5, richPadY: 8 },
  ios: { width: 198, height: 85, radius: 19, hostSize: 14, hostLineHeight: 17, padStart: 14, disc: 34, discInsetEnd: 23, contentShift: 1.4, richWidth: 280.5, titleSize: 17, titleLineHeight: 20, richPadX: 13.85, richPadY: 10 },
};

export type LinkPreviewProps = Omit<ComponentProps<"a">, "title" | "children" | "href" | "media"> & {
  href: string;
  title?: string;
  description?: string;
  /** Hostname label; defaults to the URL's host without "www.". */
  host?: string;
  /** Rich card image slot (any node, e.g. an <img>). */
  media?: ReactNode;
  /** Convenience for the rich card: an image URL rendered in the media slot. */
  image?: string;
  /** Description of the preview image for assistive technology. */
  imageAlt?: string;
  platform?: Platform;
};

function SafariDisc({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" data-slot="safari-icon" viewBox="0 0 24 24" width={size} height={size} style={{ display: "block", color: "var(--im-card-icon)" }}>
      <circle cx="12" cy="12" r="12" fill="currentColor" />
      <g transform="rotate(45 12 12)">
        <path d="M12 3.6 L14.2 12 L12 20.4 L9.8 12 Z" fill="var(--im-card)" stroke="var(--im-card)" strokeWidth="0.9" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      </g>
    </svg>
  );
}

/**
 * macOS values are measured off the apple.com card. iOS swaps in its own measured grays - the incoming
 * bubble (#e9e9eb / #262629) and the secondary label (#8a8a8e / #8d8d93) - because #3b3b3d is the macOS
 * incoming gray and reads wrong next to iOS bubbles. The Safari disc keeps the macOS gray: nothing on
 * iOS measures it.
 */
const themeVars: Record<Platform, string> = {
  macos: "[--im-card:#e9e9eb] [--im-card-fg:#808084] [--im-card-icon:#757576] [--im-card-title:#000000] dark:[--im-card:#3b3b3d] dark:[--im-card-fg:#a6a6a9] dark:[--im-card-icon:#a7a7a7] dark:[--im-card-title:#ffffff]",
  ios: "[--im-card:#e9e9eb] [--im-card-fg:#8a8a8e] [--im-card-icon:#757576] [--im-card-title:#000000] dark:[--im-card:#262629] dark:[--im-card-fg:#8d8d93] dark:[--im-card-icon:#a7a7a7] dark:[--im-card-title:#ffffff]",
};

export function LinkPreview({ href, title, description, host, media, image, imageAlt = "", platform: platformProp, className, style, target, rel, ...props }: LinkPreviewProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const m = linkPreviewMetrics[platform];
  let url: URL;
  try { url = new URL(href); } catch { throw new Error("LinkPreview requires an absolute HTTP(S) URL."); }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("LinkPreview requires an absolute HTTP(S) URL.");
  const hostname = host ?? url.hostname.replace(/^www\./, "");
  // A plain <img>: registry components stay framework-agnostic (pass `media` to use next/image).
  // eslint-disable-next-line @next/next/no-img-element
  const mediaNode = media ?? (image ? <img src={image} alt={imageAlt} style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} /> : null);
  const rich = Boolean(mediaNode || title || description);
  const shared = { fontFamily: fontStack, letterSpacing: 0, color: "var(--im-card-fg)", background: "var(--im-card)", borderRadius: m.radius, textDecoration: "none", ...style };
  if (!rich) {
    return (
      <a href={url.href} target={target} rel={rel ?? (target === "_blank" ? "noopener noreferrer" : undefined)} data-slot="link-preview" data-variant="compact" data-platform={platform}
        className={cn("relative block overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500", themeVars[platform], className)}
        style={{ ...shared, width: m.width, height: m.height, boxSizing: "border-box" }} aria-label={title ? `${title}, ${hostname}` : hostname} {...props}>
        <span data-slot="host" className="absolute truncate" style={{ left: m.padStart, right: m.discInsetEnd + m.disc + m.padStart / 2, top: (m.height - m.hostLineHeight) / 2 + m.contentShift, fontSize: m.hostSize, lineHeight: `${m.hostLineHeight}px` }}>{hostname}</span>
        <span className="absolute" style={{ right: m.discInsetEnd, top: (m.height - m.disc) / 2 + m.contentShift, width: m.disc, height: m.disc }}><SafariDisc size={m.disc} /></span>
      </a>
    );
  }
  return (
    <a href={url.href} target={target} rel={rel ?? (target === "_blank" ? "noopener noreferrer" : undefined)} data-slot="link-preview" data-variant="rich" data-platform={platform}
      className={cn("block max-w-full overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500", themeVars[platform], className)}
      style={{ ...shared, width: m.richWidth }} {...props}>
      {mediaNode && <div data-slot="media" className="overflow-hidden" style={{ aspectRatio: "1.91 / 1", background: "color-mix(in srgb, var(--im-card-fg) 20%, var(--im-card))" }}>{mediaNode}</div>}
      <div data-slot="meta" style={{ padding: `${m.richPadY}px ${m.richPadX}px` }}>
        {title && <p data-slot="title" className="m-0 line-clamp-2" style={{ fontSize: m.titleSize, lineHeight: `${m.titleLineHeight}px`, fontWeight: 600, color: "var(--im-card-title)" }}>{title}</p>}
        {description && <p data-slot="description" className="m-0 line-clamp-2" style={{ fontSize: m.hostSize, lineHeight: `${m.hostLineHeight}px`, marginTop: 2 }}>{description}</p>}
        <p data-slot="host" className="m-0 truncate" style={{ fontSize: m.hostSize, lineHeight: `${m.hostLineHeight}px`, marginTop: title || description ? 2 : 0 }}>{hostname}</p>
      </div>
    </a>
  );
}
