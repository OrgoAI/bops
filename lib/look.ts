import { BRAND } from "./brand";
import type { Bot } from "./types";

/* Bot colors as the UI paints them, shared by the app and the computers Bops dresses (lib/server/desktop). */

// The main bot's wash: Bops' highlighter, or a partner's color (lib/brand.ts).
export const DESKTOP_BG = BRAND.wash;

/** A soft wash of a bot's color, for its desktop wallpaper and Details card. */
export function botWash(b: Bot) {
  if (b.color.toUpperCase() === "#E9FF3B" || b.isMain) return DESKTOP_BG;
  return `linear-gradient(160deg, color-mix(in oklab, ${b.color} 22%, white) 0%, color-mix(in oklab, ${b.color} 38%, white) 55%, color-mix(in oklab, ${b.color} 62%, white) 100%)`;
}

/** The bezel color when you've taken over a bot's computer: the bot's own color (Sam's lime). */
export function botBezel(b: Bot) {
  if (b.isMain || b.color.toUpperCase() === "#E9FF3B") return BRAND.bezel;
  return b.color;
}

/** The bot's color as text or an accent on black (its buttons): Sam's highlighter, others' own color, lifted a little. */
export function botOnInk(b: Bot) {
  if (b.isMain || b.color.toUpperCase() === "#E9FF3B") return BRAND.onInk;
  return `color-mix(in oklab, ${b.color} 85%, white)`;
}
