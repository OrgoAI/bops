import "server-only";
import { isProbablyReaderable, Readability } from "@mozilla/readability";
import { DOMParser, parseHTML } from "linkedom";
import { safeFetch, type Fetched } from "./safe-fetch";

/**
 * A public web page as text, fetched through safeFetch (no private addresses, 10 s, 2 MB). Two
 * readings of the same page:
 *
 * - readPage, for a bot's web_fetch in chat: an article's own text when the page is an article
 *   (Readability, the engine behind Firefox's Reader View), else everything visible on the page;
 *   JSON pretty-printed, plain text as it is, a feed (XML) as its lines. At most 12,000 characters.
 * - pageLines, for page monitors: everything visible, one line per block (a paragraph, a list item,
 *   a table row, a heading), since what monitors watch (prices, stock, lists, tables) is exactly
 *   what Readability leaves out. Lines are 2 to 300 characters (a longer one is split, never lost),
 *   each one once, in page order, at most 400.
 *
 * Neither runs the page's scripts, so a page that draws itself in the browser shows little here.
 * HTML is parsed with linkedom, which is light and never fetches anything the page refers to.
 */

/** The most text readPage gives a bot. */
export const READ_PAGE_MAX_CHARS = 12_000;
/**
 * Readability takes time that grows with the square of how deeply a page nests (a page of 10,000 nested
 * blocks, under 1 MB, held the whole server for 25 seconds), so a page nested deeper than this, or with
 * more elements, is read as its visible text instead.
 */
const READER_MAX_DEPTH = 300;
const READER_MAX_ELEMENTS = 15_000;
const MAX_LINES = 400;
const MIN_LINE = 2;
const MAX_LINE = 300;

/** Elements whose text is never shown on the page (or isn't the page's to show). */
const DROP = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "template",
  "title",
  "meta",
  "link",
  "base",
  "iframe",
  "frame",
  "object",
  "embed",
  "canvas",
  "video",
  "audio",
  "map",
  "select",
  "datalist",
  "textarea",
]);

/** Elements that start a new line (as the browser lays them out). */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "button",
  "caption",
  "center",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "html",
  "legend",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "option",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);

/** Table cells: kept on their row's line, with a separator between them. */
const CELL = new Set(["td", "th"]);
const CELL_GAP = " · ";

/** Whitespace collapsed and invisible characters (zero width, soft hyphen, byte order mark) gone. */
const squash = (s: string) =>
  s
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const hidden = (el: Element) => el.hasAttribute("hidden") || /(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(el.getAttribute("style") ?? "");

/**
 * The text of every block under `root`, in page order, whitespace collapsed, empty ones left out.
 * In `xml` mode every element is a block and nothing is dropped (a feed: titles, links, dates). Walks
 * with its own stack, so a page nested thousands deep can't overflow the call stack.
 */
function blocks(root: Node, xml = false): string[] {
  const out: string[] = [];
  let line = "";
  let gap = false;
  let pre = 0;
  const flush = () => {
    const t = squash(line);
    if (t) out.push(t);
    line = "";
    gap = false;
  };
  const add = (text: string) => {
    if (gap && /\S/.test(text)) {
      if (/\S/.test(line)) line += CELL_GAP;
      gap = false;
    }
    line += text;
  };
  const stack: [Node, boolean][] = [];
  const children = (n: Node) => {
    const kids = n.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], false]);
  };
  children(root);
  while (stack.length) {
    const [node, leaving] = stack.pop()!;
    if (leaving) {
      if ((node as Element).localName === "pre") pre--;
      flush();
      continue;
    }
    // Text, and CDATA (a feed's HTML descriptions).
    if (node.nodeType === 3 || node.nodeType === 4) {
      const text = node.nodeValue ?? "";
      if (pre > 0 && text.includes("\n"))
        text.split(/\r?\n/).forEach((part, i) => {
          if (i) flush();
          add(part);
        });
      else add(text);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    if (!xml) {
      if (DROP.has(tag) || hidden(el)) continue;
      if (tag === "br") {
        flush();
        continue;
      }
      if (CELL.has(tag)) gap = true;
    }
    if (xml || BLOCK.has(tag)) {
      flush();
      if (tag === "pre") pre++;
      stack.push([el, true]);
    }
    children(el);
  }
  flush();
  return out;
}

/** A line cut into pieces of at most MAX_LINE characters, at a sentence end or a space when there is one. */
function fit(line: string): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > MAX_LINE) {
    const head = rest.slice(0, MAX_LINE + 1);
    let cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? ")) + 1;
    if (cut < MAX_LINE / 2) cut = head.lastIndexOf(" ");
    if (cut < MAX_LINE / 2) cut = MAX_LINE;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Monitor lines: collapsed, split to fit, 2 to 300 characters, each once in order, at most 400. */
function tidy(raw: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw)
    for (const line of fit(squash(r))) {
      if (line.length < MIN_LINE || seen.has(line)) continue;
      seen.add(line);
      out.push(line);
      if (out.length >= MAX_LINES) return out;
    }
  return out;
}

/** A parsed HTML document. linkedom leaves a bare piece of text with no root element, so that gets one. */
function parse(html: string): Document {
  const { document } = parseHTML(html);
  if (document.documentElement) return document;
  return parseHTML(`<!doctype html><html><head></head><body>${html.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</body></html>`).document;
}

/** The page's title: <title>, else its og:title, else its first heading. */
function titleOf(document: Document): string {
  const og = document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? "";
  return squash(document.querySelector("title")?.textContent || og || document.querySelector("h1")?.textContent || "").slice(0, MAX_LINE);
}

/**
 * The visible text of an HTML page as lines: script, style, noscript, svg, template (and other
 * things never shown) dropped; one line per block element, table cells joined on their row's line;
 * then tidied as monitors need (2 to 300 characters, each once, at most 400). Pure: no fetching.
 */
export function htmlLines(html: string): { title: string; lines: string[] } {
  const document = parse(html);
  return { title: titleOf(document), lines: tidy(blocks(document)) };
}

/** A feed or other XML as lines: each element's own text, with HTML inside (a feed's descriptions) read as HTML. */
function xmlLines(xml: string): { title: string; lines: string[] } {
  const document = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  const raw = blocks(document, true).flatMap((line) => (/<[a-z][^>]*>/i.test(line) ? blocks(parse(line)) : [line]));
  return { title: squash(document.querySelector("title")?.textContent ?? "").slice(0, MAX_LINE), lines: raw };
}

/** JSON pretty-printed (2 spaces); text that doesn't parse (or was cut short) as it came. */
function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

type Kind = "html" | "json" | "xml" | "text";
const kindOf = (type: string): Kind =>
  /html/.test(type) ? "html" : /(^application\/json$|\+json$)/.test(type) ? "json" : /xml/.test(type) ? "xml" : "text";

/** What to call a page that has no title of its own: its host and path. */
const label = (url: string) => {
  const u = new URL(url);
  return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
};

/** A page that answered with an error is an error here, said plainly (with `status` on it). */
function answered(got: Fetched): Fetched {
  const s = got.status;
  if (s >= 200 && s < 300) return got;
  const why =
    s === 401 || s === 403
      ? " (it needs a sign in, or doesn't let bots read it)"
      : s === 404 || s === 410
        ? " (not found)"
        : s === 429
          ? " (too many requests; try again later)"
          : s >= 500
            ? " (the site is having trouble)"
            : "";
  throw Object.assign(new Error(`That page answered ${s}${why}.`), { status: s });
}

/** Whether a page nests deeper than READER_MAX_DEPTH or has more than READER_MAX_ELEMENTS elements (a walk with its own stack, that stops as soon as it knows). */
function tooTangled(root: Node): boolean {
  const stack: [Node, number][] = [[root, 0]];
  let elements = 0;
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (node.nodeType === 1 && (++elements > READER_MAX_ELEMENTS || depth > READER_MAX_DEPTH)) return true;
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) stack.push([kids[i], depth + 1]);
  }
  return false;
}

/** The article's own text when the page reads as one (and gives enough), else undefined. Never for a page Readability would take too long on (tooTangled). */
function article(document: Document): { title: string; text: string } | undefined {
  try {
    // linkedom builds no implied <body>: a page without one has nothing for Readability to read.
    if (!document.body?.textContent?.trim() || tooTangled(document) || !isProbablyReaderable(document)) return undefined;
    const got = new Readability(document, { maxElemsToParse: READER_MAX_ELEMENTS }).parse();
    if (!got?.content) return undefined;
    const text = blocks(parse(got.content)).join("\n");
    return text.length >= 300 ? { title: squash(got.title ?? ""), text } : undefined;
  } catch {
    return undefined;
  }
}

/** Text cut to `max` characters, at a line end when one is near. */
function cap(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const head = text.slice(0, max);
  const end = head.lastIndexOf("\n");
  return { text: (end > max * 0.8 ? head.slice(0, end) : head).trimEnd(), cut: true };
}

/**
 * A page for a bot to read (web_fetch): its title and text, at most 12,000 characters (`truncated`
 * when there was more, or the page was over 2 MB). Throws FetchRefused for an address Bops won't
 * open, and a plain Error when the page couldn't be read or answered with an error.
 */
export async function readPage(url: string): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
  const got = answered(await safeFetch(url));
  const kind = kindOf(got.contentType);
  let title = "";
  let text: string;
  if (kind === "html") {
    const document = parse(got.body);
    title = titleOf(document);
    // The visible text first: Readability takes the document apart as it reads.
    const visible = blocks(document).join("\n");
    const art = article(document);
    title = art?.title || title;
    text = art?.text ?? visible;
  } else if (kind === "xml") {
    const x = xmlLines(got.body);
    title = x.title;
    text = x.lines.join("\n");
  } else text = (kind === "json" ? pretty(got.body) : got.body).replace(/\r\n?/g, "\n").trim();
  const out = cap(text, READ_PAGE_MAX_CHARS);
  return { url: got.url, title: title || label(got.url), text: out.text, truncated: out.cut || got.truncated };
}

/**
 * A page as lines for a monitor: what's visible, one line per block, 2 to 300 characters each, each
 * once, at most 400 (htmlLines); JSON pretty-printed and plain text taken line by line, tidied the
 * same way. Throws like readPage, so a site that's down or failing is an error, never a change.
 */
export async function pageLines(url: string): Promise<{ url: string; title: string; lines: string[] }> {
  const got = answered(await safeFetch(url));
  const kind = kindOf(got.contentType);
  if (kind === "html") {
    const { title, lines } = htmlLines(got.body);
    return { url: got.url, title: title || label(got.url), lines };
  }
  if (kind === "xml") {
    const { title, lines } = xmlLines(got.body);
    return { url: got.url, title: title || label(got.url), lines: tidy(lines) };
  }
  const text = kind === "json" ? pretty(got.body) : got.body;
  return { url: got.url, title: label(got.url), lines: tidy(text.split(/\r?\n/)) };
}
