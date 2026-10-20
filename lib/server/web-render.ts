import "server-only";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";
import { openGuard } from "./render-guard";
import type { Fetched } from "./safe-fetch";
import { dataRoot } from "./user-paths";

/**
 * Reading a page in a real browser, when a plain fetch can't (lib/server/web-page.ts asks): a page that
 * draws itself with JavaScript (an app's shell: almost no text, many scripts, or an empty #root), or one
 * behind a "checking your browser" wall (Cloudflare, "verify you are human", a 403, 429 or 503 with a
 * page). Never for an address safeFetch refused: that check comes first, always.
 *
 * The browser is the one Bops ships: the Mac app (desktop/render.cjs) opens the page in a hidden window
 * with a session of its own, in memory only, and hands back its visible text, title and links. This
 * server reaches it over a socket only this user can open (BOPS_RENDER_SOCKET, which the app sets),
 * with the window's token (BOPS_UI_TOKEN). Every request the page makes goes through a guard this server
 * opens for it (lib/server/render-guard.ts): public addresses only, checked and pinned like safeFetch.
 * One page at a time (the rest wait their turn, a few at most), 20 seconds each.
 *
 * A site that needed the browser is remembered for 7 days (in memory, and in .data/browser-sites.json,
 * just its name and when), so its next pages go to the browser at once. Without the app (a dev server
 * run on its own, a hosted server) there's no browser, and pages read as they always did.
 */

/** The most time one page gets in the browser. */
export const RENDER_LIMIT_MS = 20_000;
/** How long a site is remembered as needing the browser. */
const REMEMBER_MS = 7 * 24 * 60 * 60_000;
/** The most sites remembered (the oldest go first). */
const REMEMBER_MAX = 500;
/** Pages in line for the browser at most (the one being read, and four waiting); one more is refused at once. */
const MAX_QUEUED = 5;
/** Visible text shorter than this, on an HTML page, is "almost none". */
const SHELL_TEXT = 200;
/** A wall's page is short: a long page that mentions "verify you are human" is a page, not a wall. */
const WALL_TEXT = 2_000;

/** Why a page needs the browser: an app's shell, or a wall that checks for a human (or a refusal with a page). */
export type BrowserReason = "shell" | "challenge" | "blocked";

/**
 * Words a "checking your browser" page shows, in its title or text (Cloudflare, Akamai, Imperva, DataDome,
 * PerimeterX, Sucuri, AWS WAF, DDoS-Guard and the like). The browser waits while a page still shows them.
 */
export const CHALLENGE =
  /just a moment\.\.\.|attention required! \| cloudflare|checking your browser|checking if the site connection is secure|verify(?:ing)? (?:that )?you are (?:a )?human|are you a robot|please verify you are a human|enable javascript and cookies to continue|pardon our interruption|ddos protection by|request unsuccessful\. incapsula|access to this page has been denied|press (?:&|and) hold to confirm/i;
/** Marks in a page's HTML that only a wall's page has. */
const WALL_MARKS = /\/cdn-cgi\/challenge-platform\/|cf_chl_opt|cf-browser-verification|challenges\.cloudflare\.com|_incapsula_resource|captcha-delivery\.com|px-captcha|perimeterx|ak_bmsc|awswaf|sucuri_cloudproxy|ddos-guard/i;
/** Where an app draws itself: one of these with nothing in it is an app's shell. */
const APP_ROOTS = ["#root", "#app", "#__next", "#__nuxt", "#___gatsby", "#svelte", "app-root", "[data-reactroot]", "#main-app", "#application"];

/** An HTML page's visible text (what a plain fetch sees), its scripts and whether an app's root is empty. */
function looks(html: string): { text: string; scripts: number; emptyRoot: boolean; noscriptAsks: boolean } {
  // linkedom gives a piece of a page with no <html> no body to read: it gets one.
  const { document } = parseHTML(/<html[\s>]/i.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`);
  const scripts = document.querySelectorAll("script").length;
  const noscriptAsks = [...document.querySelectorAll("noscript")].some((n) => /enable javascript|javascript (?:is )?(?:required|disabled)|requires javascript|turn on javascript/i.test(n.textContent ?? ""));
  const emptyRoot = APP_ROOTS.some((sel) => {
    try {
      const el = document.querySelector(sel);
      return !!el && !(el.textContent ?? "").trim();
    } catch {
      return false;
    }
  });
  for (const el of document.querySelectorAll("script, style, noscript, template, svg")) el.remove();
  const text = (document.body?.textContent ?? document.documentElement?.textContent ?? "").replace(/\s+/g, " ").trim();
  return { text, scripts, emptyRoot, noscriptAsks };
}

/**
 * Whether a plain fetch's answer needs the browser, and why; null when it doesn't. Only a web page
 * (HTML) can: a 403, 429 or 503 that comes with one ("blocked"), a "checking your browser" page
 * ("challenge"), or a page with almost no visible text and many scripts, an empty app root, or a
 * noscript that asks for JavaScript ("shell"). Pure: no fetching.
 */
export function needsBrowser(got: Pick<Fetched, "status" | "contentType" | "body">): BrowserReason | null {
  if (!/html/.test(got.contentType) || !got.body.trim()) return null;
  const page = looks(got.body);
  const short = page.text.length < WALL_TEXT;
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(got.body)?.[1] ?? "";
  if (short && (CHALLENGE.test(`${title}\n${page.text}`) || WALL_MARKS.test(got.body))) return "challenge";
  if (got.status === 403 || got.status === 429 || got.status === 503) return "blocked";
  if (got.status < 200 || got.status >= 300) return null;
  if (page.text.length < SHELL_TEXT && (page.scripts >= 3 || page.emptyRoot || page.noscriptAsks)) return "shell";
  return null;
}

/* ---------------- Sites remembered as needing the browser ---------------- */

type Remembered = Map<string, number>;
const g = globalThis as typeof globalThis & { __bopsBrowserSites?: Remembered };

/** The file sites are kept in: .data/browser-sites.json, { "example.com": <when it last needed the browser> }. */
const sitesFile = () => join(dataRoot(), "browser-sites.json");

/** A site as remembered: its host, lowercase, without "www.". */
const siteKey = (host: string) => host.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.+$/, "").replace(/^www\./, "");

function sites(): Remembered {
  if (g.__bopsBrowserSites) return g.__bopsBrowserSites;
  const m: Remembered = new Map();
  try {
    const kept = JSON.parse(readFileSync(sitesFile(), "utf8")) as Record<string, unknown>;
    const now = Date.now();
    for (const [k, at] of Object.entries(kept ?? {})) if (typeof at === "number" && now - at < REMEMBER_MS && at <= now + 60_000) m.set(siteKey(k), at);
  } catch {
    // None kept yet, or unreadable: start empty.
  }
  return (g.__bopsBrowserSites = m);
}

function saveSites(m: Remembered) {
  try {
    const file = sitesFile();
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Kept in memory still; written again next time.
  }
}

/** Whether `host` needed the browser in the last 7 days. */
export function siteNeedsBrowser(host: string): boolean {
  const m = sites();
  const k = siteKey(host);
  const at = m.get(k);
  if (at === undefined) return false;
  if (Date.now() - at < REMEMBER_MS) return true;
  m.delete(k);
  saveSites(m);
  return false;
}

/** Remembers that `host` needs the browser (now), or forgets it (`needs` false: a plain fetch reads it again). */
export function rememberSite(host: string, needs = true) {
  const m = sites();
  const k = siteKey(host);
  if (!k) return;
  if (!needs) {
    if (m.delete(k)) saveSites(m);
    return;
  }
  m.delete(k);
  m.set(k, Date.now());
  const now = Date.now();
  for (const [key, at] of m) if (now - at >= REMEMBER_MS || m.size > REMEMBER_MAX) m.delete(key);
  saveSites(m);
}

/** Drops the sites kept in memory, so the file is read again at the next look (tests). */
export function forgetSites() {
  delete g.__bopsBrowserSites;
}

/* ---------------- The browser ---------------- */

/** A page as the browser showed it: where it ended up, its status (0 when unknown), title, visible text and links (absolute http and https). */
export type Rendered = {
  url: string;
  status: number;
  title: string;
  text: string;
  links: { url: string; text: string; menu?: boolean }[];
  /** The document's media type ("text/html"; a JSON or text file shows as itself). */
  type: string;
};

/** Whether there's a browser to read with: the Mac app running this server, which says where to ask. */
export const browserAvailable = () => !!process.env.BOPS_RENDER_SOCKET && !!process.env.BOPS_UI_TOKEN;

/** One request to the app's browser service, one answer, within `ms`. */
function ask(payload: Record<string, unknown>, ms: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(process.env.BOPS_RENDER_SOCKET!);
    let buf = "";
    let settled = false;
    const finish = (e: Error | null, v?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (e) reject(e);
      else resolve(v!);
    };
    const timer = setTimeout(() => finish(new Error("The browser took too long.")), ms);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify({ ...payload, token: process.env.BOPS_UI_TOKEN })}\n`));
    sock.on("data", (d) => {
      buf += d;
      if (buf.length > 8 * 1024 * 1024) return finish(new Error("The browser's answer was too big."));
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        finish(null, JSON.parse(buf.slice(0, nl)));
      } catch {
        finish(new Error("The browser's answer couldn't be read."));
      }
    });
    sock.on("error", () => finish(new Error("Bops' browser isn't available.")));
    sock.on("close", () => finish(new Error("Bops' browser closed the connection.")));
  });
}

/** How the app's browser service is doing (tests): windows open and pages waiting. */
export async function browserStatus(): Promise<{ open: number; waiting: number }> {
  const got = await ask({ op: "status" }, 5_000);
  return { open: Number(got.open ?? 0), waiting: Number(got.waiting ?? 0) };
}

/** Pages in line for the browser (the one being read too), and the turn the next one waits on. */
let queued = 0;
let turn: Promise<unknown> = Promise.resolve();
/** What the guard refused on the last page read (tests). */
let lastRefused: string[] = [];
export const lastGuardRefusals = () => [...lastRefused];

/**
 * Reads `url` in the browser, one page at a time (a few may wait their turn; more are refused at once).
 * Every request the page makes goes through a guard opened for it alone, closed after. `limitMs` (at most
 * 20 seconds, the default) is for tests. Rejects when the browser isn't there, the page didn't load in
 * time, or it never got past a "checking your browser" page.
 */
export async function renderPage(url: string, opts: { limitMs?: number } = {}): Promise<Rendered> {
  if (!browserAvailable()) throw new Error("Bops' browser isn't available.");
  if (queued >= MAX_QUEUED) throw new Error("Too many pages are waiting for the browser.");
  const limit = Math.min(Math.max(1_000, opts.limitMs ?? RENDER_LIMIT_MS), RENDER_LIMIT_MS);
  queued++;
  const mine = turn.then(async () => {
    const guard = await openGuard(new URL(url));
    try {
      const allow = (process.env.BOPS_FETCH_ALLOW ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // The app holds the page 20 seconds at most; this waits a little longer for its answer.
      const got = await ask({ url, proxyPort: guard.port, allow, challenge: true, wallText: WALL_TEXT, limitMs: limit }, limit + 5_000);
      lastRefused = [...guard.refused, ...(Array.isArray(got.refused) ? got.refused.map(String) : [])];
      if (!got.ok) throw new Error(String(got.error ?? "The page couldn't be read in a browser."));
      if (got.challenge) throw new Error("The site kept checking for a human, so it couldn't be read even in a browser.");
      const links = Array.isArray(got.links) ? (got.links as Rendered["links"]).filter((l) => l && typeof l.url === "string" && /^https?:/i.test(l.url)) : [];
      return {
        url: typeof got.url === "string" && /^https?:/i.test(got.url) ? got.url : url,
        status: Number(got.status) || 0,
        title: String(got.title ?? ""),
        text: String(got.text ?? ""),
        links: links.map((l) => ({ url: l.url, text: String(l.text ?? ""), ...(l.menu ? { menu: true } : {}) })),
        type: String(got.type ?? "").toLowerCase(),
      } satisfies Rendered;
    } finally {
      guard.close();
    }
  });
  void mine.then(
    () => queued--,
    () => queued--,
  );
  turn = mine.then(
    () => {},
    () => {},
  );
  return mine;
}
