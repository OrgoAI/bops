import "server-only";
import { isProbablyReaderable, Readability } from "@mozilla/readability";
import { DOMParser, parseHTML } from "linkedom";
import { checkUrl, safeFetch, type Fetched } from "./safe-fetch";
import { browserAvailable, needsBrowser, rememberSite, renderPage, siteNeedsBrowser, type Rendered } from "./web-render";

/**
 * A public web page as text, fetched through safeFetch (no private addresses, 10 s, 2 MB). Two
 * readings of the same page:
 *
 * - readPage, for a bot's web_fetch in chat: an article's own text when the page is an article
 *   (Readability, the engine behind Firefox's Reader View), else everything visible on the page;
 *   JSON pretty-printed, plain text as it is, a feed (XML) as its lines. At most 12,000 characters,
 *   with a web page's links (so the bot can follow one): at most 100, the ones to read first.
 * - pageLines, for page monitors: everything visible, one line per block (a paragraph, a list item,
 *   a table row, a heading), since what monitors watch (prices, stock, lists, tables) is exactly
 *   what Readability leaves out. Lines are 2 to 300 characters (a longer one is split, never lost),
 *   each one once, in page order, at most 1500 (a long thread's newest reply, at the bottom, counts).
 *
 * Neither runs the page's scripts: HTML is parsed with linkedom, which is light and never fetches
 * anything the page refers to. A page that draws itself with JavaScript, or one behind a "checking your
 * browser" wall, is read in a browser instead when the Mac app is there (lib/server/web-render.ts): its
 * visible text, title and links go through the same lines and links as a fetched page's, and the result
 * says so (`via: "browser"`). Never an address safeFetch refuses.
 */

/** The most text readPage gives a bot. */
export const READ_PAGE_MAX_CHARS = 12_000;
/**
 * Readability takes time that grows with the square of how deeply a page nests (a page of 10,000 nested
 * blocks, under 1 MB, held the whole server for 25 seconds), so a page nested deeper than this is read as
 * its visible text instead. A shallow page is quick however big (a long Wikipedia article, about 17,000
 * elements, in a quarter second; the 2 MB body cap bounds it), so the cap on elements is only far out.
 */
const READER_MAX_DEPTH = 300;
const READER_MAX_ELEMENTS = 60_000;
/** The most lines a monitor reads of a page (a watch keeps a fingerprint of each, about 13 characters). */
const MAX_LINES = 1500;
const MIN_LINE = 2;
const MAX_LINE = 300;
/** The most links readPage gives (chat.ts lists them under the page's text), the ones to read first. */
const LINKS_MAX = 100;
/** The most links read off a page before they're sorted (a long index page has many). */
const LINKS_READ_MAX = 2000;

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

/** A link on a page as readPage gives it: where it goes (as written in the page) and its words. */
export type PageLink = { url: string; text: string };
/** A link as read off a page, before it's sorted: `menu` when it's in the page's nav, header or footer. */
type FoundLink = PageLink & { menu?: boolean };
/** Where a page keeps its menus: links in these come after the page's own. */
const MENU = new Set(["nav", "header", "footer"]);

/**
 * The text of every block under `root`, in page order, whitespace collapsed, empty ones left out.
 * In `xml` mode every element is a block and nothing is dropped (a feed: titles, links, dates). Walks
 * with its own stack, so a page nested thousands deep can't overflow the call stack. With `links`, the
 * visible links (<a href>) go into it as well, in page order, up to LINKS_READ_MAX.
 */
function blocks(root: Node, xml = false, links?: FoundLink[]): string[] {
  const out: string[] = [];
  let line = "";
  let gap = false;
  let pre = 0;
  let menu = 0;
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
      const name = (node as Element).localName;
      if (name === "pre") pre--;
      if (MENU.has(name)) menu--;
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
      if (links && tag === "a" && links.length < LINKS_READ_MAX) {
        const href = el.getAttribute("href")?.trim();
        if (href) links.push({ url: href, text: squash(el.textContent ?? ""), ...(menu > 0 ? { menu: true } : {}) });
      }
    }
    if (xml || BLOCK.has(tag)) {
      flush();
      if (tag === "pre") pre++;
      if (!xml && MENU.has(tag)) menu++;
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

/** Monitor lines: collapsed, split to fit, 2 to 300 characters, each once in order, at most MAX_LINES. */
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
 * then tidied as monitors need (2 to 300 characters, each once, at most 1500). Pure: no fetching.
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

export type Kind = "html" | "json" | "xml" | "text";
const kindOf = (type: string): Kind =>
  /html/.test(type) ? "html" : /(^application\/json$|\+json$)/.test(type) ? "json" : /xml/.test(type) ? "xml" : "text";

/** What to call a page that has no title of its own: its host and path. */
const label = (url: string) => {
  const u = new URL(url);
  return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
};

/** A page that answered with an error is an error here, said plainly (with `status` on it). */
function answered<T extends Pick<Fetched, "status">>(got: T): T {
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

/** The article's own text (and links) when the page reads as one (and gives enough), else undefined. Never for a page Readability would take too long on (tooTangled). */
function article(document: Document): { title: string; text: string; links: FoundLink[] } | undefined {
  try {
    // linkedom builds no implied <body>: a page without one has nothing for Readability to read.
    if (!document.body?.textContent?.trim() || tooTangled(document) || !isProbablyReaderable(document)) return undefined;
    const got = new Readability(document, { maxElemsToParse: READER_MAX_ELEMENTS }).parse();
    if (!got?.content) return undefined;
    const links: FoundLink[] = [];
    const text = blocks(parse(got.content), false, links).join("\n");
    return text.length >= 300 ? { title: squash(got.title ?? ""), text, links } : undefined;
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

/** Link words that are a control, not something to read: vote, hide, reply, sign in and the like. */
const CONTROL = /^(?:vote|up ?vote|down ?vote|hide|un ?hide|reply|log ?in|log ?out|sign ?in|sign ?up|sign ?out|register)$/i;
/** An address that's a user's page: /user?id=pg, /u/dana, /users/dana, /profile/dana, /@dana. */
const USER_PAGE = /\/(?:user|users|u|profile|profiles|member|members)(?:\/|$)|\/@[^/]+\/?$/i;

/**
 * Whether a link is one to read: not a vote (by its words, or an address ending in /vote), hide, reply
 * or sign in link, not just a number (a page number, a count), and not just a user's name (one word, to
 * a user's page).
 */
function readable(text: string, url: URL) {
  if (CONTROL.test(text) || /\/vote\/?$/i.test(url.pathname)) return false;
  if (/^[\d,.\s]+$/.test(text)) return false;
  return !(text && !/\s/.test(text) && USER_PAGE.test(url.pathname));
}

/** Link words that read like a title: three words or more with letters in them ("5 hours ago" has two). */
const titled = (text: string) => text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length >= 3;

/**
 * A page's links as readPage gives them, the ones to read first: the article's own links (`own`), then
 * the page's links whose words read like a title and that aren't in its nav, header or footer, then the
 * rest, each in page order. Made absolute from `base` (the page's address, or its <base href>), http and
 * https only, without a "#" part, each once, not the page itself (`self`); no vote, hide, reply or sign
 * in links, none that are just a number or a user's name (readable); at most LINKS_MAX.
 */
function absoluteLinks(own: FoundLink[], page: FoundLink[], base: string, self: string): PageLink[] {
  const me = new URL(self);
  me.hash = "";
  const groups: PageLink[][] = [[], [], []];
  const add = (l: FoundLink, group: number) => {
    let u: URL;
    try {
      u = new URL(l.url, base);
    } catch {
      return;
    }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !readable(l.text, u)) return;
    u.hash = "";
    if (u.href !== me.href) groups[group].push({ url: u.href, text: l.text });
  };
  for (const l of own) add(l, 0);
  for (const l of page) add(l, l.menu || !titled(l.text) ? 2 : 1);
  const out = new Map<string, PageLink>();
  for (const l of groups.flat()) {
    if (!out.has(l.url)) out.set(l.url, l);
    if (out.size >= LINKS_MAX) break;
  }
  return [...out.values()];
}

/** What a page's relative links are read against: its <base href> when it has one (http or https), else its own address. */
function baseOf(document: Document, url: string) {
  const href = document.querySelector("base[href]")?.getAttribute("href")?.trim();
  if (!href) return url;
  try {
    const u = new URL(href, url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : url;
  } catch {
    return url;
  }
}

/**
 * A page as read: fetched (`got`), or rendered in the browser (`rendered`) when the fetch showed it needs
 * one (web-render.ts needsBrowser), or its site did lately (siteNeedsBrowser, straight to the browser).
 * An address checkUrl refuses throws before anything, so it never reaches the browser; a browser that
 * isn't there, is busy, fails or never gets past a wall leaves the fetched page as it was, and one that
 * isn't there says so (`noBrowser`: a computer's runner, whose routine the Mac then runs: chat.ts
 * web_fetch). A site is remembered only when a fetch showed it needed the browser and the browser read it
 * (with text, and not an error), so after 7 days without that, a fetch tries it again.
 */
async function fetchPage(url: string): Promise<{ got: Fetched; rendered?: undefined; noBrowser?: true } | { rendered: Rendered; got?: undefined; noBrowser?: undefined }> {
  const u = checkUrl(url);
  const host = u.hostname;
  const usable = (r: Rendered) => (!r.type || /html/.test(r.type)) && (r.status === 0 || (r.status >= 200 && r.status < 300)) && !!r.text.trim();
  let tried = false;
  if (browserAvailable() && siteNeedsBrowser(host)) {
    tried = true;
    const r = await renderPage(u.href).catch(() => null);
    if (r && usable(r)) return { rendered: r };
  }
  const got = await safeFetch(url);
  if (tried || !needsBrowser(got)) return { got };
  if (!browserAvailable()) return { got, noBrowser: true };
  const r = await renderPage(u.href).catch(() => null);
  if (!r || !usable(r)) return { got };
  rememberSite(host);
  return { rendered: r };
}

/** A rendered page's text as lines: table cells (tabs, in a browser's text) joined as htmlLines joins them, whitespace collapsed, empty lines gone. */
const renderedLines = (r: Rendered) =>
  r.text
    .split(/\r?\n/)
    .map((line) => squash(line.trim().replace(/\t+/g, CELL_GAP)))
    .filter(Boolean);

/**
 * A page for a bot to read (web_fetch): its title and text, at most 12,000 characters (`truncated`
 * when there was more, or the page was over 2 MB), and its links, at most 100, the ones to read first
 * (absoluteLinks: an article's own, then the page's own, then its menus and the rest; none for JSON,
 * plain text or a feed, whose addresses are in the text). A page read in the browser (fetchPage) gives
 * its visible text as lines and its links the same way, with `via: "browser"`. One that needs the browser
 * where there's none (a computer's runner) comes with no text and `noBrowser` when `sayNoBrowser` asks
 * (chat.ts web_fetch: the Mac runs the routine), else read plain as it is. Throws FetchRefused for an
 * address Bops won't open, and a plain Error when the page couldn't be read or answered with an error.
 */
export async function readPage(url: string, opts: { sayNoBrowser?: boolean } = {}): Promise<{ url: string; title: string; text: string; truncated: boolean; links: PageLink[]; via?: "browser"; noBrowser?: true }> {
  const read = await fetchPage(url);
  if (read.rendered) {
    const r = read.rendered;
    const out = cap(renderedLines(r).join("\n"), READ_PAGE_MAX_CHARS);
    return { url: r.url, title: squash(r.title).slice(0, MAX_LINE) || label(r.url), text: out.text, truncated: out.cut, links: absoluteLinks([], r.links, r.url, r.url), via: "browser" };
  }
  if (read.noBrowser && opts.sayNoBrowser) return { url: read.got.url, title: label(read.got.url), text: "", truncated: false, links: [], noBrowser: true };
  const got = answered(read.got);
  const kind = kindOf(got.contentType);
  let title = "";
  let text: string;
  let links: PageLink[] = [];
  if (kind === "html") {
    const document = parse(got.body);
    title = titleOf(document);
    // The visible text, links and <base href> first: Readability takes the document apart as it reads.
    const onPage: FoundLink[] = [];
    const visible = blocks(document, false, onPage).join("\n");
    const base = baseOf(document, got.url);
    const art = article(document);
    title = art?.title || title;
    text = art?.text ?? visible;
    links = absoluteLinks(art?.links ?? [], onPage, base, got.url);
  } else if (kind === "xml") {
    const x = xmlLines(got.body);
    title = x.title;
    text = x.lines.join("\n");
  } else text = (kind === "json" ? pretty(got.body) : got.body).replace(/\r\n?/g, "\n").trim();
  const out = cap(text, READ_PAGE_MAX_CHARS);
  return { url: got.url, title: title || label(got.url), text: out.text, truncated: out.cut || got.truncated, links };
}

/**
 * A page as lines for a monitor: what's visible, one line per block, 2 to 300 characters each, each
 * once, at most 1500 (htmlLines); JSON pretty-printed and plain text taken line by line, tidied the
 * same way; and what kind of page it was (a web page with no lines needs a browser, while JSON or text
 * with none is just empty). A page read in the browser (fetchPage) gives its visible text tidied the same
 * way, as "html", with `via: "browser"`. Throws like readPage, so a site that's down or failing is an
 * error, never a change.
 */
export async function pageLines(url: string): Promise<{ url: string; title: string; lines: string[]; kind: Kind; via?: "browser" }> {
  const read = await fetchPage(url);
  if (read.rendered) {
    const r = read.rendered;
    return { url: r.url, title: squash(r.title).slice(0, MAX_LINE) || label(r.url), lines: tidy(renderedLines(r)), kind: "html", via: "browser" };
  }
  const got = answered(read.got);
  const kind = kindOf(got.contentType);
  if (kind === "html") {
    const { title, lines } = htmlLines(got.body);
    return { url: got.url, title: title || label(got.url), lines, kind };
  }
  if (kind === "xml") {
    const { title, lines } = xmlLines(got.body);
    return { url: got.url, title: title || label(got.url), lines: tidy(lines), kind };
  }
  const text = kind === "json" ? pretty(got.body) : got.body;
  return { url: got.url, title: label(got.url), lines: tidy(text.split(/\r?\n/)), kind };
}
