import type { Bot } from "./types";

/* Bot colors as the UI paints them, shared by the app and the computers Bops dresses (lib/server/desktop). */

export const DESKTOP_BG =
  "linear-gradient(160deg in oklab, oklab(96.8% -0.056 0.130) 0%, oklab(95.2% -0.090 0.182) 45%, oklab(86% -0.087 0.168) 100%)";

/** A soft wash of a bot's color, for its desktop wallpaper and Details card. */
export function botWash(b: Bot) {
  if (b.color.toUpperCase() === "#E9FF3B" || b.isMain) return DESKTOP_BG;
  return `linear-gradient(160deg, color-mix(in oklab, ${b.color} 22%, white) 0%, color-mix(in oklab, ${b.color} 38%, white) 55%, color-mix(in oklab, ${b.color} 62%, white) 100%)`;
}

/** The bezel color when you've taken over a bot's computer: the bot's own color (Sam's lime). */
export function botBezel(b: Bot) {
  if (b.isMain || b.color.toUpperCase() === "#E9FF3B") return "#C6DE12";
  return b.color;
}

/** The bot's color as text or an accent on black (its buttons): Sam's highlighter, others' own color, lifted a little. */
export function botOnInk(b: Bot) {
  if (b.isMain || b.color.toUpperCase() === "#E9FF3B") return "#E8FF3A";
  return `color-mix(in oklab, ${b.color} 85%, white)`;
}
