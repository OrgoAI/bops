/**
 * What changed on a watched page, worked out from its lines of text. A page that shows a clock, "5
 * minutes ago", a view count or a cache buster changes on every read without anything new on it, so
 * each line is first put in a steady form (normalizeLine): those parts taken out, prices and other
 * numbers kept ("Bitcoin 86,200" and "$49" stay as they are, since a watch may be for them). Dates and
 * times are taken out only where they stamp the page ("Updated 3:45 PM", a line that's only a time), never
 * where they are what's on it ("Next available: 11/30/2026 9:00 AM", "Departs 16:30", a score "28:25").
 * Two reads of a page are then compared line by line, and only the lines that are new (addedLines,
 * pageDiff) are worth a model's look. Used for web page watches and screen watches on the Mac
 * (lib/server/watches.ts), and by Bops Cloud when it runs monitors later: so it stays erasable
 * TypeScript with no imports.
 */

/** "updated", "posted"… in front of a relative time ("Updated 3 days ago"): taken out with it. */
const VERB = String.raw`(?:\b(?:last\s+)?(?:updated|edited|posted|published|modified|refreshed|active|seen|online)\s+)?`;
/** How many of a unit: "5", "an", "a few". */
const COUNT = String.raw`(?:\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:a\s+)?few|several)`;
/** Units of time, long names before the short ones they start with ("minutes" before "m"). */
const UNIT = String.raw`(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?|s|m|h|d|w|y)`;
/** A countdown's units that tick while it's watched: seconds, minutes, hours. "Ships in 2 days" is news when it moves. */
const TICKING_UNIT = String.raw`(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)`;

/** Relative times and countdowns: always the page's clock moving on, never what's on it. */
const RELATIVE: RegExp[] = [
  // "5 minutes ago", "2h ago", "updated 3 days ago", "about an hour ago".
  new RegExp(String.raw`${VERB}(?:about\s+|over\s+|almost\s+|nearly\s+|less\s+than\s+|under\s+)?\b${COUNT}\s*${UNIT}\s+ago\b`, "gi"),
  new RegExp(String.raw`${VERB}\b(?:just\s+now|(?:a\s+)?moments?\s+ago)\b`, "gi"),
  new RegExp(String.raw`${VERB}\b(?:yesterday|today)\b(?!['’])(?:\s+at\b)?`, "gi"),
  // Countdowns that tick: "in 5 minutes", "3 hours left".
  new RegExp(String.raw`\bin\s+(?:about\s+)?${COUNT}\s*${TICKING_UNIT}\b`, "gi"),
  new RegExp(String.raw`\b${COUNT}\s*${TICKING_UNIT}\s+(?:left|remaining)\b`, "gi"),
  // A bare age between separators, as feeds show it: "@jordan · 2h".
  /(^|[·•|])\s*\d{1,2}\s?[smhdw](?=\s*(?:[·•|]|$))/gi,
];

/** Ids and cache busters: UUIDs, long hex. */
const IDS: RegExp[] = [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, /\b[0-9a-f]{17,}\b/gi];

/** Long letter and digit runs: an id or a token only when it mixes both ("internationalization" stays). */
const TOKEN = /[A-Za-z0-9_]{17,}/g;

/** A clock time: "3:45", "3:45 PM", "15:45:10", "9:05 a.m. EST". */
const CLOCK = String.raw`\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[ap]\.?m\b\.?)?(?:\s*(?:UTC|GMT|[A-Z]{1,2}[SD]T)\b)?`;
/** A date in numbers (10/13/2026, 13.10.2026, 2026/10/13; not versions like 2.10.15), maybe with a time after it. */
const NUM_DATE = String.raw`\b(?:\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})|\d{1,2}\.\d{1,2}\.\d{4}|\d{4}\/\d{1,2}\/\d{1,2})\b(?:,?\s+(?:at\s+)?${CLOCK})?`;
/** An ISO date, maybe with a time and a zone: 2026-10-13, 2026-10-13T15:45:10.123Z, 2026-10-13 15:45 +02:00. */
const ISO = String.raw`\b\d{4}-\d{2}-\d{2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)?(?:\s?(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT)(?![A-Za-z]))?`;
/** Any of them, the longest form first. */
const STAMP = new RegExp(`${ISO}|${NUM_DATE}|${CLOCK}`, "gi");
/** An ISO time with seconds (or parts of one): a machine's timestamp, never something to watch. */
const MACHINE_TIME = /\d{4}-\d{2}-\d{2}[T\s]\d{1,2}:\d{2}:\d{2}/;
/** Words that say a date or time just after them is when the page was made or read, not what's on it. */
const NOISE_BEFORE =
  /(?:^|[^\p{L}])(?:(?:last\s+)?(?:updated|edited|posted|published|modified|refreshed|generated|built|checked|synced|fetched|retrieved|crawled|cached|seen|active|online)|as\s+of|server\s+time|current\s+time|local\s+time|time\s+now|page\s+(?:loaded|rendered))\s*[:,]?\s*(?:on\s+|at\s+)?$/iu;
/** Separators feeds and tables put between parts of a line. */
const SEP = /[·•|]/;

/**
 * Counts that tick with no news, next to the word they count ("1.2K views", "Likes: 340"): the word stays,
 * the number goes. Counts people do watch for (followers, stars, points, votes) are taken out only in a
 * feed's line about a post (one with an age or a separator: "123 points by pg 2 hours ago | 45 comments"),
 * and kept on a line of their own ("10,002 followers", "Dow down 500 points").
 */
const TICKING = String.raw`(?:views?|likes?|comments?|watching|viewers?|watchers?|replies|reply|reposts?|retweets?|reactions?|upvotes?|downvotes?|plays?|reads|listeners?|online|sold|bought|reviews?|ratings?)`;
const WATCHED = String.raw`(?:followers?|following|subscribers?|stars?|points?|votes?|members?|connections?|fans?|backers?)`;
const counterBefore = (words: string) => new RegExp(String.raw`\b\d[\d,.]*\s?[kmb]?\+?\s*((?:people\s+|users\s+)?${words})\b`, "gi");
const counterAfter = (words: string) => new RegExp(String.raw`\b(${words})\s*:\s*\d[\d,.]*\s?[kmb]?\+?(?![\w])`, "gi");
const TICKING_BEFORE = counterBefore(TICKING);
const TICKING_AFTER = counterAfter(TICKING);
const WATCHED_BEFORE = counterBefore(WATCHED);
const WATCHED_AFTER = counterAfter(WATCHED);
/** "Viewed 1,204 times", "played 3K times". */
const TIMES = /\b(viewed|read|played|downloaded|watched|shared)\s+\d[\d,.]*\s?[kmb]?\+?\s+times\b/gi;
/** A rank in front ("3. "), which moves as a list reorders. */
const RANK = /^\d{1,3}\.\s+(?=\S)/;

/** The part of `s` between the separators around `at` (or its ends). */
function segment(s: string, start: number, end: number) {
  let a = start;
  while (a > 0 && !SEP.test(s[a - 1])) a--;
  let b = end;
  while (b < s.length && !SEP.test(s[b])) b++;
  return { before: s.slice(a, start), after: s.slice(end, b) };
}

/**
 * Dates and times that stamp the page, out: after words like "Updated" or "as of", a machine's ISO time,
 * or one that is all there is in its part of the line ("3:45 PM", "Bulletin · 10/13/2026" keeps
 * "Bulletin"). One with words on both sides ("Departs 16:30 from Gate 4", "Kiel 28:25 Flensburg") stays.
 */
function stripStamps(s: string): string {
  return s.replace(STAMP, (m: string, at: number) => {
    const { before, after } = segment(s, at, at + m.length);
    if (NOISE_BEFORE.test(s.slice(0, at))) return " ";
    if (MACHINE_TIME.test(m)) return " ";
    if (/^[\s,]*(?:(?:at|on)\s*)?$/i.test(before) && /^[\s.,;:!?)]*$/.test(after)) return " ";
    return m;
  });
}

/**
 * One line of a page in a steady form for comparing: relative times ("yesterday", "5m ago"), ticking
 * countdowns, dates and times that stamp the page (stripStamps), ids and cache busters, ticking counters,
 * and a rank in front taken out; whitespace collapsed. Every other number stays, and so do dates and
 * times that are what's on the page. "" when nothing is left (a line that was only a time).
 */
export function normalizeLine(line: string): string {
  let s = String(line ?? "").replace(/\s+/g, " ");
  // A feed's line about a post: its counts are all ticking (decided before anything is taken out).
  const meta = SEP.test(s) || /\bago\b|\bjust now\b/i.test(s);
  for (const p of RELATIVE) s = s.replace(p, (_m: string, lead?: unknown) => (typeof lead === "string" ? lead : " "));
  s = stripStamps(s);
  for (const p of IDS) s = s.replace(p, " ");
  s = s.replace(TOKEN, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? " " : m));
  s = s.replace(TICKING_BEFORE, " $1").replace(TICKING_AFTER, "$1").replace(TIMES, "$1");
  if (meta) s = s.replace(WATCHED_BEFORE, " $1").replace(WATCHED_AFTER, "$1");
  s = s
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/([·•|])(?:\s*[·•|])+/g, "$1")
    .replace(/\s+/g, " ")
    // Separators left at the ends go too; a minus in front of a number ("-2.3%") stays.
    .replace(/^(?:[\s·•|,;:/–—]|-(?!\d))+|[\s·•|,;:/–—-]+$/g, "")
    .replace(RANK, "");
  return /[\p{L}\p{N}]/u.test(s) ? s : "";
}

/**
 * A page's title in its steady form for telling whether a screen moved on: like a line, with every date
 * and time out too (a title is where a tab shows a clock or an unread stamp; what's news is in the lines).
 */
export function normalizeTitle(title: string): string {
  const s = normalizeLine(title).replace(STAMP, " ").replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : "";
}

/** Whitespace collapsed: a line as the page has it, for telling two lines apart. */
const rawOf = (line: string) => String(line ?? "").replace(/\s+/g, " ").trim();

/**
 * A page's lines in their steady form: empty ones dropped, in page order. Lines are told apart as the
 * page has them (two that differ only by a stamp both stay), so an item that differs from another only
 * by its date isn't lost.
 */
export function normalizeLines(lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const raw = rawOf(line);
    if (seen.has(raw)) continue;
    seen.add(raw);
    const n = normalizeLine(raw);
    if (n) out.push(n);
  }
  return out;
}

/**
 * The lines of `after` that are new since `before`, compared in their steady form, in page order and
 * each once. They come back as `after` has them (whitespace collapsed), so whoever reads them sees the
 * page's own words. `before` is raw lines, or (`normalized`) lines already in their steady form, which
 * are taken as they are: normalizing twice can take out more ("Episode 12 views" loses its 12).
 */
export function addedLines(before: string[], after: string[], opts: { normalized?: boolean } = {}): string[] {
  const seen = new Set(opts.normalized ? before : normalizeLines(before));
  const out: string[] = [];
  for (const line of after) {
    const n = normalizeLine(line);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(rawOf(line));
  }
  return out;
}

/**
 * A page's first lines in their steady form, up to `maxLines` lines and `maxChars` characters in all,
 * told apart as the page has them; `raw` is the same lines as the page has them. For a bounded copy of a
 * page's text: a watch compares every line of a page (pageLinesOf, snapshotOf, pageDiff), not just these.
 */
export function snapshotLines(lines: string[], maxLines = 200, maxChars = 16_000): { lines: string[]; raw: string[] } {
  const kept: string[] = [];
  const raw: string[] = [];
  let size = 0;
  for (const l of pageLinesOf(lines)) {
    if (kept.length >= maxLines || size + l.line.length + 1 > maxChars) break;
    kept.push(l.line);
    raw.push(l.raw);
    size += l.line.length + 1;
  }
  return { lines: kept, raw };
}

/**
 * A short fingerprint of a line in its steady form (cyrb53, 53 bits, in base 36: about 11 characters),
 * so a watch can keep every line of a page in a few kilobytes. Pure, the same everywhere.
 */
export function lineDigest(normalized: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** One line of a page as a watch reads it: as the page has it, in its steady form, and that form's digest. */
export type PageLine = { raw: string; line: string; digest: string };

/** A page's lines as a watch reads them (every one, in page order, each line once as the page has it; empty ones dropped). */
export function pageLinesOf(lines: string[]): PageLine[] {
  const out: PageLine[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const raw = rawOf(l);
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const line = normalizeLine(raw);
    if (line) out.push({ raw, line, digest: lineDigest(line) });
  }
  return out;
}

/** A page's fingerprint: the digests of its lines, in order (a line moved, added or gone changes it). */
export const pageHash = (digests: string[]) => lineDigest(digests.join(","));

/**
 * What a watch keeps of a page between reads (about 13 characters a line): every line's digest (`digests`,
 * in order, each once), and the page's fingerprint (`hash`). Lines added below whatever it shows first
 * count like any other.
 */
export function snapshotOf(lines: PageLine[]): { digests: string[]; hash: string } {
  const digests = [...new Set(lines.map((l) => l.digest))];
  return { digests, hash: pageHash(digests) };
}

/**
 * What's new on a page since the watch last kept it (`kept`: the digests it kept; `recent`: digests of
 * lines that were on it lately and went, so a banner that rotates or a block that comes back isn't new):
 * the added lines in page order, each once, and how much of the kept page is still there (`stillThere`,
 * 0 to 1: a consent wall or a "please enable JavaScript" page shares almost nothing with it).
 */
export function pageDiff(kept: string[], recent: string[], now: PageLine[]): { added: PageLine[]; stillThere: number } {
  const known = new Set([...kept, ...recent]);
  const present = new Set(now.map((l) => l.digest));
  const added: PageLine[] = [];
  const once = new Set<string>();
  for (const l of now) {
    if (known.has(l.digest) || once.has(l.digest)) continue;
    once.add(l.digest);
    added.push(l);
  }
  const stillThere = kept.length ? kept.filter((d) => present.has(d)).length / kept.length : 1;
  return { added, stillThere };
}
