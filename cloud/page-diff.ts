/**
 * What changed on a watched page, worked out from its lines of text. Two reads of a page are compared
 * line by line, each line first put in a steady form (normalizeLine), and only the lines that are new
 * are worth a model's look (the judge, lib/server/watches.ts).
 *
 * The rule for the steady form: take out only what is certainly noise, and let the judge decide
 * everything else. Certainly noise is what moves on every read of a page that has nothing new:
 * - relative times: "5 minutes ago", "2h ago", "just now", "yesterday", "in 3 hours", "@jordan · 2h";
 * - countdowns and timers: "ends in 02:14:33", "3 hours left", "Time left: 2h 15m", "Elapsed: 01:23:45";
 * - a date or time right after a word that says it stamps the page: "Updated 3:45 PM", "Last updated:
 *   Mon, 13 Oct 2026 15:45:10 GMT", "Data as of Oct 13, 2026", "Generated on ...", "Server time 15:45";
 * - a full timestamp with seconds, as machines write them: "2026-10-13T15:45:10Z", "Mon, 13 Oct 2026
 *   15:45:10 +0000" (a feed's build date);
 * - ids and tokens: UUIDs, and runs of over 16 letters and digits mixed (cache busters, nonces).
 * Everything else stays as the page has it: a time or a date on its own or in a table cell (a booking
 * slot, a departure, "Today 3:00 PM"), prices, scores, counts (views, likes, points, stars, votes), a
 * rank in front ("3. "). Taking out too much hides what the user waits for, and nothing tells them; a
 * page whose counter ticks costs one cheap judge call a read, and the judge is told that a moved stamp,
 * counter, ad or order isn't news unless the watch is for it.
 *
 * Used for web page watches and screen watches on the Mac (lib/server/watches.ts), and by Bops Cloud
 * when it runs monitors later: so it stays erasable TypeScript with no imports.
 */

/** How many of a unit: "5", "an", "a few". */
const COUNT = String.raw`(?:\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:a\s+)?few|several)`;
/** Units of time, long names before the short ones they start with ("minutes" before "m"). */
const UNIT = String.raw`(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?|s|m|h|d|w|y)`;
/** "updated", "posted"… in front of a relative time ("Updated 3 days ago"): taken out with it. */
const VERB = String.raw`(?:\b(?:last\s+)?(?:updated|edited|posted|published|modified|refreshed|active|seen|online)\s+)?`;
/**
 * A span a countdown ticks in while it's watched: "3 hours", "2h 15m", "3 hrs 12 mins", "a few minutes".
 * Days aren't in it: "ships in 2 days" moves once a day, and may be news.
 */
const TICK = String.raw`(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)`;
const SPAN = String.raw`(?:\d+\s*${TICK}|\d+[smh]|(?:an?|one|a\s+few|few|several)\s+${TICK})(?:[\s,]+(?:and\s+)?(?:\d+\s*${TICK}|\d+[smh]))*\b`;
/** A timer's digits: "02:14:33", "4:59" (never "3:00 PM", a time of day). */
const TIMER = String.raw`\d{1,3}:\d{2}(?::\d{2})?(?![:\d])(?!\s*[ap]\.?m\b)`;

/** A time zone after a clock time: "UTC", "ET", "PDT", "+0000", "+02:00". */
const ZONE = String.raw`(?:\s*(?:utc|gmt|z|[ecmp][sd]?t|bst|cest|cet|ist|jst)\b|\s*[+-]\d{2}:?\d{2}\b)`;
/** A clock time: "3:45", "3:45 PM", "15:45:10", "9:05 a.m. EST". */
const CLOCK = String.raw`\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s*[ap]\.?m\b\.?)?${ZONE}?`;
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const WEEKDAY = String.raw`(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\.?`;
const MDAY = String.raw`\d{1,2}(?:st|nd|rd|th)?`;
/** A date: ISO (maybe with a time), in numbers (10/13/2026, 10/13, 13.10.2026), or with the month's name ("Oct 13", "13 October", "Oct 2026"). */
const DATE = String.raw`\d{4}-\d{2}-\d{2}(?:[t\s]${CLOCK})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\d{1,2}\.\d{1,2}\.\d{4}\b|\d{4}\/\d{1,2}\/\d{1,2}\b|${MONTH}\s+${MDAY}\b|${MDAY}\s+${MONTH}(?!\w)|${MONTH}\s+\d{4}\b`;
/** A date or a time, and what may follow it: "Mon, 13 Oct 2026 15:45:10 GMT", "October 13, 2026 at 3:45 PM", "today at 9:00". */
const MOMENT = String.raw`(?:${DATE}|${CLOCK}|today|yesterday|tonight)`;
const WHEN = String.raw`(?:${WEEKDAY},?\s+)?${MOMENT}(?:(?:\s*,\s*|\s+)(?:(?:at|on)\s+)?(?:${MOMENT}|\d{4}\b))*`;
/** Words that say a date or time just after them is when the page was made or read, not what's on it. */
const STAMP_WORD = String.raw`(?:last\s+)?(?:updated|modified|edited|refreshed|refresh|synced|sync|checked|generated|rendered|built|published|posted)|as\s+of|server\s+time|current\s+time|local\s+time`;

/** What's taken out of a line, in this order. A pattern with a group keeps what the group caught. */
const NOISE: RegExp[] = [
  // Relative times: "5 minutes ago", "2h ago", "updated 3 days ago", "about an hour ago", "just now".
  new RegExp(String.raw`${VERB}(?:about\s+|over\s+|almost\s+|nearly\s+|less\s+than\s+|under\s+)?\b${COUNT}\s*${UNIT}\s+ago\b`, "gi"),
  new RegExp(String.raw`${VERB}\b(?:just\s+now|(?:a\s+)?moments?\s+ago)\b`, "gi"),
  // "Yesterday", and its time: always a stamp ("today" may be a slot: "Today 3:00 PM").
  new RegExp(String.raw`${VERB}\byesterday\b(?:,?\s+(?:at\s+)?${CLOCK})?`, "gi"),
  // A bare age between separators, as feeds show it: "@jordan · 2h".
  /(^|[·•|])\s*\d{1,2}[smhdw](?=\s*(?:[·•|]|$))/gi,
  // Countdowns and timers: "in 5 minutes", "ends in 02:14:33", "within 3 hrs 12 mins", "3 hours left", "Elapsed: 01:23:45".
  new RegExp(String.raw`\b(?:in|within)\s+(?:about\s+|under\s+|less\s+than\s+)?(?:${SPAN}|${TIMER})`, "gi"),
  new RegExp(String.raw`\b${SPAN}\s+(?:left|remaining|to\s+go)\b`, "gi"),
  new RegExp(String.raw`\b(?:time\s+)?(?:left|remaining|elapsed)\s*:\s*(?:${SPAN}|${TIMER})`, "gi"),
  // Full timestamps with seconds, as machines write them.
  new RegExp(String.raw`\b\d{4}-\d{2}-\d{2}[t\s]\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?${ZONE}?`, "gi"),
  new RegExp(String.raw`\b(?:${WEEKDAY},?\s+)?\d{1,2}\s+${MONTH}\s+\d{4}\s+\d{1,2}:\d{2}:\d{2}${ZONE}?`, "gi"),
  // A date or time that stamps the page, with the word that says so: "Updated 3:45 PM", "as of Oct 13".
  new RegExp(String.raw`\b(?:${STAMP_WORD})\b[\s:,]*(?:(?:on|at)\s+)?${WHEN}`, "gi"),
  // Ids: UUIDs, long hex.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b[0-9a-f]{17,}\b/gi,
];

/** Long letter and digit runs: an id or a token only when it mixes both ("internationalization" stays). */
const TOKEN = /[A-Za-z0-9_]{17,}/g;

/**
 * One line of a page in a steady form for comparing: what's certainly noise taken out (NOISE, TOKEN),
 * whitespace collapsed, separators left at the ends gone. Everything else stays as the page has it.
 * "" when nothing is left (a line that was only a stamp).
 */
export function normalizeLine(line: string): string {
  let s = String(line ?? "").replace(/\s+/g, " ");
  for (const p of NOISE) s = s.replace(p, (_m: string, lead?: unknown) => (typeof lead === "string" ? lead : " "));
  s = s
    .replace(TOKEN, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? " " : m))
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/([·•|])(?:\s*[·•|])+/g, "$1")
    .replace(/\s+/g, " ")
    // Separators left at the ends go too; a minus in front of a number ("-2.3%") stays.
    .replace(/^(?:[\s·•|,;:/–—]|-(?!\d))+|[\s·•|,;:/–—-]+$/g, "");
  return /[\p{L}\p{N}]/u.test(s) ? s : "";
}

/** Every date and time, for a title (where a tab shows a clock or an unread stamp). */
const ANY_TIME = new RegExp(String.raw`\b(?:${DATE}|${CLOCK})`, "gi");

/**
 * A page's title in its steady form for telling whether a screen moved on: like a line, with every date
 * and time out too (what's news is in the lines).
 */
export function normalizeTitle(title: string): string {
  const s = normalizeLine(title).replace(ANY_TIME, " ").replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : "";
}

/** Whitespace collapsed: a line as the page has it, for telling two lines apart. */
const rawOf = (line: string) => String(line ?? "").replace(/\s+/g, " ").trim();

/** A page's lines in their steady form: empty ones dropped, each line once as the page has it, in page order. */
export function normalizeLines(lines: string[]): string[] {
  return pageLinesOf(lines).map((l) => l.line);
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

/**
 * A page's lines as a watch reads them: every one, in page order, each once as the page has it (two that
 * differ only by a stamp both stay, so an item isn't lost), empty ones dropped.
 */
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

/** What a watch keeps of a page between reads (about 13 characters a line): every line's digest, in order and each once, and the page's fingerprint. */
export function snapshotOf(lines: PageLine[]): { digests: string[]; hash: string } {
  const digests = [...new Set(lines.map((l) => l.digest))];
  return { digests, hash: pageHash(digests) };
}

/** The lines of a page whose digest isn't `known` (the page as kept, and lines on it lately), in page order and each once. */
export function newLines(known: Iterable<string>, now: PageLine[]): PageLine[] {
  const had = new Set(known);
  const out: PageLine[] = [];
  for (const l of now) {
    if (had.has(l.digest)) continue;
    had.add(l.digest);
    out.push(l);
  }
  return out;
}
