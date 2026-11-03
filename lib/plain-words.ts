/**
 * What a bot's words and steps say to someone who isn't a developer: no citation markers, no shell lines, no
 * click coordinates. The raw detail stays one tap away (a thread's open steps); these are the labels.
 */

/**
 * A model's citation markers ("citeturn0search3": private-use characters around what it cites) and
 * the space before each: they're for the model, never for people.
 */
export const dropCitations = (text: string) => text.replace(/\s?[^]*/g, "");

/**
 * A Markdown table as the chat reads one (components/app/chat-view.tsx Prose) and plainText says it: a row between
 * pipes, the |---| rule under its header row, and a row's cells.
 */
export const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
export const isTableRule = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
export const tableCells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/**
 * Each table in `text` (isTableRow, isTableRule) as one line of words: its first row, each cell after its column's name
 * ("Client: Acme · Status: Done"), an empty one left out; a table without rows, its column names.
 */
function tableWords(text: string) {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isTableRow(lines[i]) || i + 1 >= lines.length || !isTableRule(lines[i + 1])) {
      out.push(lines[i]);
      continue;
    }
    const head = tableCells(lines[i]);
    i += 2;
    const row = i < lines.length && isTableRow(lines[i]) ? tableCells(lines[i]) : [];
    const pairs = row.flatMap((c, j) => (c ? [head[j] ? `${head[j]}: ${c}` : c] : []));
    out.push((pairs.length ? pairs : head.filter(Boolean)).join(" · "));
    while (i < lines.length && isTableRow(lines[i])) i++;
    i--;
  }
  return out.join("\n");
}

/** The marks Inline (components/app/chat-view.tsx) reads in a bot's text, by its own pattern: **bold**, [a link](its address), `code`. */
const INLINE_MARKS = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|`[^`\n]+`)/g;

/**
 * A bot's message as plain text, the words the chat shows without their look (components/app/chat-view.tsx Rich, by
 * its own patterns): a code block's lines as they are, without the ``` around them; outside one, a table's words (its
 * first row after its columns' names: tableWords), no # before a heading or bullet before a list item, a link's words and not
 * its address, bold without its ** and code without its backticks (what's inside code as it is); no citation markers.
 * For a one-line preview.
 */
export const plainText = (text: string) =>
  dropCitations(text)
    .split(/```[a-z0-9-]*\n?([\s\S]*?)```/g)
    .map((part, i) =>
      i % 2
        ? part
        : tableWords(part)
            .replace(/^[ \t]*(?:#{1,4}|[-*+•])[ \t]+/gm, "")
            .split(INLINE_MARKS)
            .map((s, j) => (j % 2 === 0 ? s : s[0] === "[" ? s.slice(1, s.indexOf("](")) : s[0] === "`" ? s.slice(1, -1) : s.slice(2, -2)))
            .join(""),
    )
    .join("");

/** A link to a page on the computer it runs on (localhost, 127.0.0.1): it opens there and nowhere else. */
export const isLocalLink = (href: string) => /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#]|$)/i.test(href);

/** What a bot's localhost link says in a workspace shared with the user, in place of opening: where it opens. */
export const localOnlyLine = (botName?: string) => `opens only on ${botName ? `${botName}'s` : "the bot's"} computer`;

/**
 * The run target an app's copy has on the bot's computer, as a bot titles work on it: Bops calls that copy its Local
 * (app-envs.tsx ENV_NAMES; "Run it as its Local" in the bot's instructions, lib/server/hosted-apps.ts appWork), so a
 * bot writes "Run Trail Guides Local" or "Start the site locally". Only a title that runs, starts or opens something
 * there: any other title ending in "local" ("Shop local") is the word.
 */
const RUN_LOCAL = /^((?:run|start|restart|stop|open|show|preview|launch)\s+\S.*?)\s+(?:local|locally)$/i;

/**
 * A thread's title as the window shows it (the stored title stays as the bot wrote it): an app's copy running on
 * the bot's computer (RUN_LOCAL) and a localhost address said as where they are, its computer.
 */
export function plainTitle(title: string): string {
  return title
    .replace(RUN_LOCAL, "$1 on its computer")
    .replace(/(?:https?:\/\/)?\b(?:localhost|127\.0\.0\.1)(?::\d+)?(?![\w:-]|\.[\w-])(?:[/?#](?:[^\s]*[^\s.,;:!?])?)?/gi, "its computer");
}

/** A step's detail, as a person would say it. */
export function plainStep(detail: string): string {
  const d = detail.trim();
  if (/^clicked\s*\(\d+,\s*\d+\)/i.test(d)) return "Clicked on the screen";
  if (/^(typed|type)\b/i.test(d)) return "Typed on the screen";
  if (/^scrolled\b/i.test(d)) return "Scrolled the page";
  const read = /^(read|opened|visited)\s+(https?:\/\/\S+)/i.exec(d);
  if (read) {
    try {
      return `Read ${new URL(read[2]).hostname.replace(/^www\./, "")}`;
    } catch {}
  }
  if (/^ran\b/i.test(d)) {
    if (/urllib|requests|curl|wget|fetch\(/.test(d)) return "Looked things up online";
    if (/pdftoppm|pdfinfo|poppler|\.pdf\b/i.test(d)) return "Checked the PDF";
    if (/\b(?:npm|pnpm|yarn) (?:ci|install|i|add)\b|\bplaywright install\b|\b(?:apt-get|apt|brew|pip3?) install\b/.test(d)) return "Set up the app";
    if (/\bgit (?:log|show|diff|blame)\b/.test(d)) return "Looked at the code history";
    if (/pathlib|open\(|json|\bcat\b|\bls\b|\bcp\b|\bmv\b/.test(d)) return "Worked on the files";
    return "Ran a command";
  }
  return d;
}
