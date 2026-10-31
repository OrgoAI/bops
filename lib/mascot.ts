/**
 * The bots' mascots, as SVG markup in a 0 0 40 40 box: plush blobs in the bot's color, each wearing
 * headphones (the Bops look). Idle, a bot vibes with its eyes closed; at work, it opens them, each
 * bot with its own expression. One source for the app, the bots' desktops, and their pictures in
 * Slack, Telegram and Discord (scripts/render-mascots.mjs). Plain TypeScript: no React, no imports.
 */

/**
 * How a bot looks: idle (eyes closed, vibing) or awake (eyes open), the two the pictures use; and, in
 * the app, what it's doing at work (lib/bot-mood.ts picks it): thinking, writing, coding, speaking or
 * working, or shy for a few seconds after it's thanked.
 */
export type Mood = "idle" | "awake" | MovingMood;
/** The moods a bot shows while it works, each a pose that app/globals.css sets moving (mascot-*). */
export type MovingMood = "thinking" | "writing" | "coding" | "speaking" | "working" | "shy";
export const MOVING_MOODS: readonly MovingMood[] = ["thinking", "writing", "coding", "speaking", "working", "shy"];
export const isMoving = (mood: Mood): mood is MovingMood => (MOVING_MOODS as readonly Mood[]).includes(mood);

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

/** The headphones: a band arching just clear of the head, and a cup on each side (each with its pad). */
const band = (c: string) => `<path d="M6.3 21.5C6.3 8.9 12.4 3.6 20 3.6s13.7 5.3 13.7 17.9" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round"/>`;
const cup = (x: number, c: string) => `<rect x="${x}" y="17" width="6.4" height="11" rx="3" fill="${c}"/>`;
const pad = (x: number, c: string) => `<rect x="${x}" y="18.6" width="1.6" height="7.8" rx=".8" fill="${c}"/>`;
const headphones = (b: string, p: string) => band(b) + cup(2.4, b) + cup(31.2, b) + pad(7.4, p) + pad(31, p);
/** The same headphones with each cup (and its pad) on its own, so they can bounce to the beat, one after the other. */
const bouncingHeadphones = (b: string, p: string) =>
  band(b) + `<g class="mascot-cup">${cup(2.4, b)}${pad(7.4, p)}</g><g class="mascot-cup mascot-cup-r">${cup(31.2, b)}${pad(31, p)}</g>`;

/** The body, smaller than the box so the ear cups fit and the band clears the head (flush, it reads as a helmet). */
const body = (inner: string) => `<g transform="translate(20 23) scale(.8) translate(-20 -21)">${inner}</g>`;

/**
 * A bot's figure (every bot but the main one, mainMarkup below): its body (with eyes, and a mouth
 * when it has one, drawn by `face` in the ink that shows on it) and its headphones' colors. Older
 * seed bots keep their own shapes.
 */
function figure(botId: string, color: string, face: (ink: string) => string) {
  const shine = `<ellipse cx="14" cy="11.5" rx="4" ry="2.2" fill="#fff" opacity=".28" transform="rotate(-18 14 11.5)"/>`;
  const blush = `<ellipse cx="11.6" cy="26" rx="2" ry="1.1" fill="#fff" opacity=".45"/><ellipse cx="28.4" cy="26" rx="2" ry="1.1" fill="#fff" opacity=".45"/>`;
  let inner: string;
  if (botId === "penny")
    inner = `<path d="M20 35C11 29 3 23 3 14.5 3 9 7 5 12 5c3.5 0 6.4 2 8 5 1.6-3 4.5-5 8-5 5 0 9 4 9 9.5C37 23 29 29 20 35z" fill="${color}"/>${face(INK)}`;
  else if (botId === "otto")
    inner = `<path d="${BLOB}" fill="${color}" stroke="#C9DD1F"/><circle cx="15.5" cy="22" r="4.4" fill="none" stroke="${INK}" stroke-width="1.6"/><circle cx="24.5" cy="22" r="4.4" fill="none" stroke="${INK}" stroke-width="1.6"/><path d="M19.9 22h.2" stroke="${INK}" stroke-width="1.6"/>${face(INK)}`;
  else inner = `<path d="${BLOB}" fill="${color}"/>${shine}${face(INK)}${blush}`;
  return { inner, band: INK, pad: "#3A3A38" };
}

/** Thinking: a thought bubble off the top right, over the band, its three dots pulsing one after another. */
const THOUGHT =
  `<g class="mascot-thought"><ellipse cx="32" cy="6.4" rx="6.6" ry="4.6" fill="#fff" stroke="${INK}"/>` +
  [29.4, 32, 34.6].map((cx, i) => `<circle class="mascot-thought-dot" cx="${cx}" cy="6.4" r="1.05" fill="${INK}" style="animation-delay:${(i * 0.2 - 1.4).toFixed(1)}s"/>`).join("") +
  `</g>`;

/**
 * Writing: the writer bot's pencil (highlighter body, wood and graphite tip, ferrule, pink eraser),
 * small, at the bottom left with its tip on a line of writing. Left, so the main bot's star (bottom
 * right on its card) never hides it.
 */
const PENCIL =
  `<path class="mascot-scribble" d="M3.2 38.9q.9-1.2 1.8 0t1.8 0 1.8 0" fill="none" stroke="${INK}" stroke-width=".8" stroke-linecap="round"/>` +
  `<g class="mascot-pencil"><g transform="translate(4.2 37) rotate(-40) scale(.9)">` +
  `<path d="M0 0L3.3-1.2V1.2z" fill="#F3D6A6" stroke="${INK}" stroke-width=".45" stroke-linejoin="round"/><path d="M0 0L1.2-.44V.44z" fill="${INK}"/>` +
  `<rect x="3.3" y="-1.2" width="7.8" height="2.4" fill="${HIGHLIGHTER}" stroke="${INK}" stroke-width=".45" stroke-linejoin="round"/>` +
  `<rect x="11.1" y="-1.3" width="1.4" height="2.6" fill="#C9C9C2" stroke="${INK}" stroke-width=".45"/>` +
  `<path d="M12.5-1.2h1.1q1 0 1 1.2t-1 1.2h-1.1z" fill="#FF8FB8" stroke="${INK}" stroke-width=".45" stroke-linejoin="round"/>` +
  `</g></g>`;

/**
 * Coding: a small laptop at the bottom left, its screen toward you, where the pencil writes (left, clear of
 * the main bot's star): a light lid outlined in `ink` (the main bot's in its cups' color), and on its dark
 * screen three short lines of code (highlighter, white, pink, the second indented) that type in one after
 * another, each in its turn, with a caret blinking after the last. Still, every line is there.
 */
const LID = "#E4E4DE";
const CODE_LINES: [x: number, y: number, w: number, fill: string][] = [
  [3.2, 29.4, 6.2, HIGHLIGHTER],
  [5.1, 31.5, 7, "#fff"],
  [3.2, 33.6, 3.8, "#FF8FB8"],
];
const laptop = (lid: string, ink: string) =>
  `<g class="mascot-laptop">` +
  `<rect x=".9" y="27" width="15" height="9.8" rx="1.3" fill="${lid}" stroke="${ink}" stroke-width=".7"/>` +
  `<rect x="2.1" y="28.2" width="12.6" height="7.4" rx=".6" fill="${ink}"/>` +
  CODE_LINES.map(([x, y, w, fill], i) => `<rect class="mascot-code-line" x="${x}" y="${y}" width="${w}" height="1.3" rx=".65" fill="${fill}" style="animation-delay:${(i * 0.6 - 1.8).toFixed(1)}s"/>`).join("") +
  `<rect class="mascot-caret" x="7.8" y="33.2" width="1.1" height="2.1" fill="${HIGHLIGHTER}"/>` +
  `<rect x=".4" y="36.6" width="16" height="2.1" rx="1.05" fill="${lid}" stroke="${ink}" stroke-width=".7"/>` +
  `</g>`;

/**
 * A coder's mark (lib/bot-mood.ts codersOf: a bot that works on one of the workspace's apps), still, on top of
 * every mood: a small ink pill with </> in highlighter at the top left of the box (the main bot's star sits at
 * the bottom right of its card, the pencil and the laptop at the bottom left, the thought bubble and the sound
 * at the top right), ringed in white so it stands off a black head. Too small to read below CODER_MIN_SIZE.
 */
const CODER =
  `<g class="coder-mark"><rect x=".7" y=".7" width="17" height="10.6" rx="5.3" fill="${INK}" stroke="#fff"/>` +
  `<path d="M6.5 3.4 4 6l2.5 2.6M11.9 3.4 14.4 6l-2.5 2.6M10.3 3l-2.2 6" fill="none" stroke="${HIGHLIGHTER}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></g>`;
/** The smallest mascot (in px) that shows the coder's mark: below it, the mark is a smudge. */
export const CODER_MIN_SIZE = 18;

/**
 * Shy: two flat cheeks below the eyes, glowing: pink on the main bot's black, a deeper rose on the
 * bots' colored bodies (so it shows on the pink and red ones too), where their pale blush is. Otto's
 * sit lower and wider, clear of its glasses.
 */
const BLUSH = "#FF8FB8";
const ROSE = "#E0245E";
const cheeks = (botId: string) => {
  const [l, r, y] = botId === "otto" ? [12.2, 27.8, 29.2] : [13.3, 26.7, 27];
  return `<g class="mascot-blush" fill="${ROSE}"><ellipse cx="${l}" cy="${y}" rx="2" ry="1.15"/><ellipse cx="${r}" cy="${y}" rx="2" ry="1.15"/></g>`;
};

/** Speaking: two sound arcs off the top of the right headphone cup, the inner one first. */
const SOUND =
  `<g class="mascot-sound" fill="none" stroke="${INK}" stroke-width="1.1" stroke-linecap="round">` +
  `<path d="M34.92 13.65A3 3 0 0 1 37.35 16.08"/><path d="M35.27 11.68A5 5 0 0 1 39.32 15.73"/></g>`;

/** The main bot's head, round and flat black, as on the app icon. */
const MAIN_HEAD = "M20 6c8.5 0 14 6 14 13.5S28.5 34 20 34 6 27 6 19.5 11.5 6 20 6z";
/** Its eyes: plain white ovals, or shut (two short arcs, bold enough to read at 20px). */
const mainEyes = (open: boolean) =>
  open
    ? `<ellipse cx="15.5" cy="20" rx="2.2" ry="2.9" fill="#fff"/><ellipse cx="24.5" cy="20" rx="2.2" ry="2.9" fill="#fff"/>`
    : `<path d="M13.3 20.4q2.2 2.2 4.4 0M22.3 20.4q2.2 2.2 4.4 0" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`;
/** The band: ink under a thinner stroke of the cups' color, arching clear of the head into the cups' tops. */
const mainBand = (fill: string) => {
  const d = "M5.3 17.6C4.4 8.4 11.1 2 20 2s15.6 6.4 14.7 15.6";
  return `<path d="${d}" fill="none" stroke="#0A0A0A" stroke-width="4.4" stroke-linecap="round"/><path d="${d}" fill="none" stroke="${fill}" stroke-width="2.8" stroke-linecap="round"/>`;
};
const mainCup = (x: number, fill: string) => `<rect x="${x}" y="16" width="7" height="11" rx="3.5" fill="${fill}" stroke="#0A0A0A" stroke-width="1.8"/>`;

/** Speaking, the main bot: the same two arcs, off the band's right shoulder. */
const MAIN_SOUND =
  `<g class="mascot-sound" fill="none" stroke="${INK}" stroke-width="1.1" stroke-linecap="round">` +
  `<path d="M31.03 5.62A3.6 3.6 0 0 1 33.36 7.58"/><path d="M31.55 3.69A5.6 5.6 0 0 1 35.18 6.73"/></g>`;

/** Shy, the main bot: its cheeks, clear of the cups and the eyes looking away. */
const MAIN_CHEEKS = `<g class="mascot-blush" fill="${BLUSH}"><ellipse cx="13.9" cy="25.7" rx="2.2" ry="1.3"/><ellipse cx="26.1" cy="25.7" rx="2.2" ry="1.3"/></g>`;

/**
 * The main bot, drawn like the app icon and flat: a round black head with white oval eyes, in
 * highlighter headphones outlined in ink (a band arching clear of the head, behind it, into the
 * cups), a little smaller than the box so the band fits. Awake, it's the app icon's "ooh": its head
 * tilted a little, its eyes glancing up, a small round mouth; thinking and working keep that face.
 * Idle shuts its eyes, upright. Writing leans toward its pencil, looking down; coding leans toward
 * its laptop the same way (the laptop's lid in its cups' highlighter), its cups bouncing as they do
 * at work; speaking faces you, its round mouth opening and closing; shy leans away, looking down,
 * its cheeks pink.
 */
function mainMarkup(mood: Mood, accent: boolean) {
  const fill = accent ? HIGHLIGHTER : "#3A3A38";
  const left = mainCup(4, fill);
  const right = mainCup(29, fill);
  let face: string;
  let tilt = 0;
  if (mood === "idle") face = mainEyes(false);
  else if (mood === "writing" || mood === "coding") {
    tilt = -5;
    face = `<g transform="translate(-.6 .9)">${mainEyes(true)}</g>`;
  } else if (mood === "speaking") face = `${mainEyes(true)}<ellipse class="mascot-mouth" cx="20" cy="25.8" rx="1.6" ry="1.9" fill="#fff"/>`;
  else if (mood === "shy") {
    tilt = 8;
    face = `<g transform="translate(-.6 .9)">${mainEyes(true)}</g>${MAIN_CHEEKS}`;
  } else {
    // Awake, thinking (its glance moving the eyes up and back) and working.
    tilt = -9;
    face = `<g${mood === "thinking" ? ` class="mascot-glance"` : ""} transform="translate(.6 -1.4)">${mainEyes(true)}</g><ellipse cx="20.8" cy="26.6" rx="1.35" ry="1.65" fill="#fff"/>`;
  }
  const cups = mood === "working" || mood === "coding" ? `<g class="mascot-cup">${left}</g><g class="mascot-cup mascot-cup-r">${right}</g>` : left + right;
  const head = `${mainBand(fill)}<path d="${MAIN_HEAD}" fill="#0A0A0A"/>${face}${cups}`;
  const drawn = `<g transform="translate(20 21.4) scale(.92) translate(-20 -20)">${tilt ? `<g transform="rotate(${tilt} 20 20)">${head}</g>` : head}</g>`;
  if (!isMoving(mood)) return drawn;
  const extra = mood === "thinking" ? THOUGHT : mood === "writing" ? PENCIL : mood === "coding" ? laptop(accent ? HIGHLIGHTER : LID, "#0A0A0A") : mood === "speaking" ? MAIN_SOUND : "";
  return `<g class="mascot-${mood}">${drawn}</g>${extra}`;
}

/**
 * A bot's mascot. `accent` false draws the main bot's headphones in ink instead of the highlighter
 * (for spots where the highlighter would clash). Idle and awake are the pictures' still poses; each
 * moving mood is a still pose too (where nothing sets it moving, or motion is reduced), with classes
 * app/globals.css animates: thinking glances up under its thought bubble, writing looks down at its
 * pencil, coding looks down at its laptop as code types in, its cups to the beat, speaking opens its
 * mouth with sound off a cup, working bops along, its cups to the beat, and shy looks away with its
 * cheeks glowing pink. `coder` adds the coder's mark on top, whatever the mood (the app passes it for
 * a bot that works on an app, at CODER_MIN_SIZE and up; the pictures never have it).
 */
export function mascotMarkup(botId: string, color: string, opts: { mood?: Mood; accent?: boolean; coder?: boolean } = {}) {
  const drawn = moodMarkup(botId, color, opts.mood ?? "idle", opts.accent !== false);
  return opts.coder ? drawn + CODER : drawn;
}

function moodMarkup(botId: string, color: string, mood: Mood, accent: boolean) {
  if (isMainBotId(botId)) return mainMarkup(mood, accent);
  if (!isMoving(mood)) {
    const f = figure(botId, color, (c) => eyes(mood === "idle" ? "vibe" : faceOf(botId), c));
    return body(f.inner) + headphones(f.band, f.pad);
  }
  const face = (c: string) => {
    const open = eyes(faceOf(botId), c);
    if (mood === "thinking") return `<g class="mascot-glance" transform="translate(.6 -1.4)">${open}</g>`;
    if (mood === "writing" || mood === "coding" || mood === "shy") return `<g transform="translate(-.6 .9)">${open}</g>`;
    if (mood === "speaking") return `${open}<path class="mascot-mouth" d="M17.8 26.6h4.4q0 2.8-2.2 2.8t-2.2-2.8z" fill="${c}"/>`;
    return open;
  };
  const f = figure(botId, color, face);
  const phones = mood === "working" || mood === "coding" ? bouncingHeadphones(f.band, f.pad) : headphones(f.band, f.pad);
  const extra = mood === "thinking" ? THOUGHT : mood === "writing" ? PENCIL : mood === "coding" ? laptop(LID, INK) : mood === "speaking" ? SOUND : "";
  return `<g class="mascot-${mood}">${body(f.inner)}${phones}${mood === "shy" ? cheeks(botId) : ""}</g>${extra}`;
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
