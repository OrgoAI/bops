"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { usePlatform, type Platform } from "@/components/message-ui/platform";
import { fontStack } from "@/components/message-ui/tokens";

/**
 * The centered timestamp that separates conversation history.
 *
 * Measured (references/ios/captures/conv3-light.png @3x, references/macos/captures/conversation-pane-light-partial.png @2x):
 * - iOS: two lines ("iMessage" then "Today 1:25 AM"), 11pt on a 14pt pitch, #8a8a8e. The service line and
 *   "Today" render at weight 500; the time is regular. The first bubble sits 7.6pt below the second line box.
 * - macOS: one line, 9pt on an 11pt pitch (ink 63 x 9pt for "Today 1:47 AM"; SPEC.md's 11pt is 20% too wide),
 *   "Today" at weight **500**, #808080 light / #9a9a9a dark. The first bubble's body top sits 6.0 below the
 *   header's ink bottom. Weight 500 is measured, not assumed: rendering the string at 9pt/2x and comparing
 *   the ten ink runs of `conversation-pane-light-partial.png` (normalised to the "T", pt from its left edge:
 *   0.00-10.50, 11.00-16.00, 16.50-21.00, 22.00-26.50, 30.00-33.00, 34.50-36.00, 37.00-42.50, 43.00-47.50,
 *   49.50-55.50, 56.50-63.00) puts weight 500 within one device px on all ten and on the 63.00 total, where
 *   600 runs 0.5 wide on seven of them and 63.50 overall, and 400 is 0.5 narrow on eight. Same weight as iOS.
 *   `gapBelow` is 6 even though the box wants 5.7: at 9pt/2x Blink paints the ink at `round(box top) + 2`,
 *   so 5.7 and 6 put the ink on the same device row, and 6 is the number the capture states.
 *
 * Only the header that opens a conversation carries the service name; a header inserted mid-list after an
 * hour-long gap is one line and sits in a gap of its own. Measured in `dateheader-mid-light.png`: the
 * previous body bottom is at 605.0, the header ink runs 621.0 to 631.33, the next bubble top is 639.0.
 * Chrome snaps a baseline to whole CSS px, so the ink can land a third of a point off the capture even
 * when the box is exactly right; the gaps below are the box positions, not the rasterised ink.
 */
export type DateSeparatorVariant = "first" | "mid";
export type DateSeparatorMetrics = {
  fontSize: number; lineHeight: number; weight: number; dayWeight: number;
  /** Space between the previous row and the line box, and between the line box and the next row. */
  gapAbove: number; gapBelow: number;
  /** The same two gaps for a mid-list header, which has no bubble above it to lean on. */
  midGapAbove: number; midGapBelow: number;
};

export const dateSeparatorMetrics: Record<Platform, DateSeparatorMetrics> = {
  ios: { fontSize: 11, lineHeight: 14, weight: 400, dayWeight: 500, gapAbove: 0, gapBelow: 7.6, midGapAbove: 13.33, midGapBelow: 6.67 },
  // No macOS capture of a mid-list header yet: it reuses the between-cluster gap above and the measured 6 below.
  macos: { fontSize: 9, lineHeight: 11, weight: 400, dayWeight: 500, gapAbove: 0, gapBelow: 6, midGapAbove: 11.5, midGapBelow: 6 },
};

export type DateLabel = {
  /** "Today", "Yesterday", a weekday name, or "Sep 8, 2026". */
  day: string;
  /** "1:25 AM" (narrow no-break space before the period, as Apple renders it). */
  time: string;
  /** " " for relative days, " at " before absolute dates. */
  joiner: " " | " at ";
  text: string;
  iso: string;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

export function formatClockTime(value: Date | number): string {
  const d = new Date(value);
  const hours = d.getHours();
  const h12 = hours % 12 || 12;
  return `${h12}:${String(d.getMinutes()).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

/** Apple's relative date style: Today / Yesterday / weekday within a week / "Sep 8, 2026 at 1:25 AM". */
export function formatDateLabel(value: Date | number, now: Date | number = Date.now()): DateLabel {
  const d = new Date(value);
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(d)) / 86_400_000);
  const time = formatClockTime(d);
  let day: string;
  let joiner: DateLabel["joiner"] = " ";
  if (days === 0) day = "Today";
  else if (days === 1) day = "Yesterday";
  else if (days > 1 && days < 7) day = WEEKDAYS[d.getDay()];
  else { day = `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; joiner = " at "; }
  return { day, time, joiner, text: `${day}${joiner}${time}`, iso: d.toISOString() };
}

export type DateSeparatorProps = Omit<ComponentProps<"div">, "children"> & {
  /** The moment the header describes. Omit to render `children` verbatim. */
  date?: Date | number;
  /** Reference time for "Today"/"Yesterday"; defaults to the current time. */
  now?: Date | number;
  /** iOS shows the conversation's service ("iMessage", "Text Message") above the date. Ignored on macOS. */
  service?: ReactNode;
  /** "first" opens the conversation; "mid" is inserted after an hour-long gap and gets its own spacing. */
  variant?: DateSeparatorVariant;
  platform?: Platform;
  /** Custom label used instead of the formatted date. */
  children?: ReactNode;
  dateTime?: string;
};

export function DateSeparator({ date, now, service, variant = "first", platform: platformProp, children, dateTime, className, style, ...props }: DateSeparatorProps) {
  const contextPlatform = usePlatform();
  const platform = platformProp ?? contextPlatform;
  const m = dateSeparatorMetrics[platform];
  const mid = variant === "mid";
  const label = date === undefined ? undefined : formatDateLabel(date, now);
  return (
    <div data-slot="date-separator" data-platform={platform} data-variant={variant} className={cn("text-center", className)}
      style={{ fontFamily: fontStack, fontSize: m.fontSize, lineHeight: `${m.lineHeight}px`, fontWeight: m.weight, letterSpacing: 0, color: "var(--im-secondary, #8a8a8e)", paddingTop: mid ? m.midGapAbove : m.gapAbove, paddingBottom: mid ? m.midGapBelow : m.gapBelow, ...style }} {...props}>
      {platform === "ios" && !mid && service ? <div data-slot="service" style={{ fontWeight: m.dayWeight }}>{service}</div> : null}
      <time dateTime={dateTime ?? label?.iso}>
        {children ?? (label ? <><span data-slot="day" style={{ fontWeight: m.dayWeight }}>{label.day}</span>{label.joiner}{label.time}</> : null)}
      </time>
    </div>
  );
}
