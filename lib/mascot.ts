/**
 * The bots' mascots, as SVG markup in a 0 0 40 40 box: plush blobs in the bot's color, each wearing
 * headphones (the Bops look). Idle, a bot vibes with its eyes closed; at work, it opens them, each
 * bot with its own expression. One source for the app, the bots' desktops, and their pictures in
 * Slack, Telegram and Discord (scripts/render-mascots.mjs). Plain TypeScript: no React, no imports.
 */

export type Mood = "idle" | "awake";

const BLOB =
  "M20 4c7.5 0 13.5 4.5 15.5 11 2.8 2.4 3.8 6 2.8 9.6C36.6 32.5 29.6 37 20 37S3.4 32.5 1.7 24.6C.7 21 1.7 17.4 4.5 15 6.5 8.5 12.5 4 20 4z";
const INK = "#1C1C1B";
const HIGHLIGHTER = "#E9FF3B";

/** A workspace's main bot (Boppy, or Sam on older installs): drawn in black, with highlighter headphones. */
export const isMainBotId = (botId: string) => /^(boppy|sam)(-\d+)?$/.test(botId);

/** Each bot's own face when it's working, fixed by its id: open eyes, a smile, or a wink. */
const FACES = ["open", "happy", "wink"] as const;
export function faceOf(botId: string): (typeof FACES)[number] {
  if (isMainBotId(botId)) return "open";
  let h = 0;
  for (const ch of botId.replace(/-\d+$/, "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FACES[h % FACES.length];
}

const eyes = (face: "vibe" | (typeof FACES)[number], c: string) => {
  const arc = (d: string) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`;
  if (face === "vibe") return arc("M13.6 22.2q1.9 1.8 3.8 0M22.6 22.2q1.9 1.8 3.8 0");
  if (face === "happy") return arc("M13.6 23.3q1.9-2.1 3.8 0M22.6 23.3q1.9-2.1 3.8 0");
  const dot = (cx: number) => `<ellipse cx="${cx}" cy="22.3" rx="1.9" ry="2.6" fill="${c}"/>`;
  if (face === "wink") return dot(15.5) + arc("M22.6 22.5q1.9 1.7 3.8 0");
  return dot(15.5) + dot(24.5);
};

/** The headphones: a band arching just clear of the head, and a cup on each side. */
const headphones = (band: string, pad: string) =>
  `<path d="M6.3 21.5C6.3 8.9 12.4 3.6 20 3.6s13.7 5.3 13.7 17.9" fill="none" stroke="${band}" stroke-width="2.1" stroke-linecap="round"/>` +
  `<rect x="2.4" y="17" width="6.4" height="11" rx="3" fill="${band}"/><rect x="31.2" y="17" width="6.4" height="11" rx="3" fill="${band}"/>` +
  `<rect x="7.4" y="18.6" width="1.6" height="7.8" rx=".8" fill="${pad}"/><rect x="31" y="18.6" width="1.6" height="7.8" rx=".8" fill="${pad}"/>`;

/** The body, smaller than the box so the ear cups fit and the band clears the head (flush, it reads as a helmet). */
const body = (inner: string) => `<g transform="translate(20 23) scale(.8) translate(-20 -21)">${inner}</g>`;

/**
 * A bot's mascot. `accent` false draws the main bot's headphones in ink instead of the highlighter
 * (for spots where the highlighter would clash). Older seed bots keep their own shapes.
 */
export function mascotMarkup(botId: string, color: string, opts: { mood?: Mood; accent?: boolean } = {}) {
  const mood = opts.mood ?? "idle";
  const face = mood === "idle" ? "vibe" : faceOf(botId);
  if (isMainBotId(botId)) {
    const lime = opts.accent !== false;
    return body(`<path d="${BLOB}" fill="#0A0A0A"/>${eyes(face, "#fff")}`) + headphones(lime ? HIGHLIGHTER : "#3A3A38", lime ? "#0A0A0A" : "#1C1C1B");
  }
  const shine = `<ellipse cx="14" cy="11.5" rx="4" ry="2.2" fill="#fff" opacity=".28" transform="rotate(-18 14 11.5)"/>`;
  const blush = `<ellipse cx="11.6" cy="26" rx="2" ry="1.1" fill="#fff" opacity=".45"/><ellipse cx="28.4" cy="26" rx="2" ry="1.1" fill="#fff" opacity=".45"/>`;
  let inner: string;
  if (botId === "penny")
    inner = `<path d="M20 35C11 29 3 23 3 14.5 3 9 7 5 12 5c3.5 0 6.4 2 8 5 1.6-3 4.5-5 8-5 5 0 9 4 9 9.5C37 23 29 29 20 35z" fill="${color}"/>${eyes(face, INK)}`;
  else if (botId === "otto")
    inner = `<path d="${BLOB}" fill="${color}" stroke="#C9DD1F"/><circle cx="15.5" cy="22" r="4.4" fill="none" stroke="${INK}" stroke-width="1.6"/><circle cx="24.5" cy="22" r="4.4" fill="none" stroke="${INK}" stroke-width="1.6"/><path d="M19.9 22h.2" stroke="${INK}" stroke-width="1.6"/>${eyes(face, INK)}`;
  else inner = `<path d="${BLOB}" fill="${color}"/>${shine}${eyes(face, INK)}${blush}`;
  return body(inner) + headphones(INK, "#3A3A38");
}

/**
 * The bots' pictures, rendered ahead of time (scripts/render-mascots.mjs) into edge/public/mascot,
 * which Bops Cloud and the self-hosted front door (edge/) serve at /mascot/<name>.png and .jpg for
 * Slack, Telegram and Discord: the main bot, a blob in each of these colors (new bots' colors and the
 * seed bots'), and the seed bots with shapes of their own.
 */
export const PICTURE_COLORS = ["#FF9F43", "#2EC4B6", "#A78BFA", "#F87171", "#60A5FA", "#34D399", "#E9FF3B", "#FF6FB5", "#47C46B", "#5B8CFF"];
export const PICTURE_SHAPES: Record<string, string> = { penny: "#FF6FB5", otto: "#E9FF3B", rook: "#47C46B" };

/** A bot's rendered picture ("blob-2EC4B6"), or null when its color has none (it shows the Bops logo instead). */
export function pictureName(b: { id: string; color: string; isMain: boolean }): string | null {
  if (b.isMain) return "main-0A0A0A";
  const hex = b.color.replace("#", "").toUpperCase();
  if (PICTURE_SHAPES[b.id]?.slice(1).toUpperCase() === hex) return `${b.id}-${hex}`;
  return PICTURE_COLORS.some((c) => c.slice(1).toUpperCase() === hex) ? `blob-${hex}` : null;
}

/** A whole SVG document for a bot's mascot, for pages outside the app. */
export const mascotSvg = (botId: string, color: string, size: number, mood: Mood = "idle") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="${size}" height="${size}">${mascotMarkup(botId, color, { mood })}</svg>`;
