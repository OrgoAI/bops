import "server-only";
import { trackServerEvent } from "./analytics";
import { botChatId, DISPLAYS, isScreenWatch, live, MAIN_WORKSPACE, PAGE_WATCH_DEFAULT_MIN, PAGE_WATCH_MIN_MIN, workspaceOf, type Watch } from "@/lib/types";
import { lineDigest, normalizeLine, normalizeTitle, newLines, pageLinesOf, screenLines, snapshotOf, type PageLine } from "@/cloud/page-diff";
import { decide, chose, yes } from "./decide";
import { holdForLater, urgency } from "./attention";
import { currentPage, navigate, pageLines } from "./local";
import { appWindows, findWindow, listWindows, mainWindow, windowText } from "./mac-windows";
import { orgo } from "./orgo";
import { sameComputer, screenEndpoint, workComputer } from "./screens";
import { ensureScreenTools, startSession, stopSession } from "./sessions";
import { addMessage, bot, getState, id, ownerName, patchSession, session, stateEpoch, stateReady, stateUser, touchState, update } from "./store";
import { recordTokens, usageTags } from "./usage";
import { openaiClient } from "./openai-client";
import { knownSite, siteOf } from "@/lib/watch-sites";

/**
 * Watched screens: a bot keeps a site open on one of its screens (an X inbox, LinkedIn messages)
 * and Jev keeps an eye on it. When the page changes, Jev reads it and answers one question: is
 * something there waiting for the user? If so, the screen gets a "needs you" badge, the panel cuts to
 * it, and the bot tells the user in its chat, offering to draft a reply. Only page changes are read,
 * at most every half minute per screen, so watching costs next to nothing while nothing happens.
 *
 * A window on the user's own Mac can be watched the same way (a Messages conversation, a mailbox): its
 * text is read through macOS accessibility, without a screenshot and without touching the window,
 * and the main bot of the workspace gives the heads-up.
 *
 * A public web page (a price, a status page, a listing) can be watched with no screen at all (Watch.page):
 * Bops fetches it every few minutes, keeps a fingerprint of every line with what's certainly noise taken
 * out (a "5m ago", an "Updated 3:45 PM", a cache buster: cloud/page-diff.ts), and a model reads only the
 * lines that were added, only when there are some, with the lines they replaced. Every kind of watch
 * compares pages that way; anything else that moved (a counter, an ad) is the model's to call. A screen
 * or a Mac window also leaves out counts that tick on a feed (views, likes, comments) when it tells
 * whether it moved on, since each move there costs a model read (cloud/page-diff.ts screenLines).
 */

/** How often each watched page is checked for changes (a cheap read over the tailnet, no model). */
const LOOK_MS = 15_000;
/** Jev reads a changed page at most this often per screen. */
const READ_MS = 30_000;
/** How sure Jev must be that something is waiting before Bops interrupts the user. */
const SURE = 0.7;
/** A web page that keeps failing is fetched less and less often: the gap doubles each time, up to this. */
const PAGE_BACKOFF_MAX_MS = 6 * 3600_000;
/**
 * What a page watch keeps of a page between fetches: every line's fingerprint (Watch.page.digests, about
 * 13 characters a line, up to the 1500 lines a page is read as), and the text of lines up to
 * PAGE_TEXT_CHARS (the ones that changed lately first), so the judge sees what a new line replaced.
 */
const PAGE_TEXT_CHARS = 30_000;
/**
 * A read's new lines are judged in one call: up to this many, in page order, with a count of the rest.
 * The rest aren't kept as seen, so they're new again at the next read and judged then.
 */
const PAGE_JUDGE_LINES = 200;
/** A page read and found the same is saved at most this often; the window still sees when it was checked (watchesForApp). */
const CHECKED_SAVE_MS = 60 * 60_000;
/** ...and is told the state moved on at most this often, so its "Checked" stays fresh without a save. */
const CHECKED_SHOW_MS = 5 * 60_000;
/** The longest gap between fetches of a page, in minutes: a day. */
const PAGE_WATCH_MAX_MIN = 1440;

const watches = () => getState().watches ?? [];
const watchById = (watchId: string) => watches().find((w) => w.id === watchId);
const patchWatch = (watchId: string, patch: Partial<Watch>) =>
  update((state) => {
    const w = state.watches?.find((x) => x.id === watchId);
    if (w) Object.assign(w, patch);
  });

/** A screen is busy when a thread, one of its helpers, or the user is using it (any bot's, on a shared computer). */
function busy(botId: string, display: number) {
  const state = getState();
  if (state.takeover && sameComputer(state.takeover.botId, botId) && state.takeover.display === display) return true;
  return state.sessions.some((s) => sameComputer(s.botId, botId) && live(s) && (s.display === display || s.helperScreens?.includes(display)));
}

const screenNo = (display: number) => DISPLAYS.indexOf(display) + 1;

const client = openaiClient();
const SUGGEST_MODEL = process.env.BOPS_CHAT_MODEL ?? process.env.BOPS_SAM_MODEL ?? "gpt-6.1-sol";
export type Suggestion = { site: string; lookFor: string; picks: string[] };
const suggested = new Map<string, { at: number; s: Suggestion }>();

/**
 * What's worth watching this page for, read from the page itself: its name ("Hacker News") and a
 * few quick picks that fit it ("New top story", "Replies to my comments"). Sites Bops knows answer
 * at once; others get one quick, low-effort model read, remembered per address for a while.
 */
export async function suggestWatch(botId: string, display: number): Promise<Suggestion> {
  const epoch = stateEpoch();
  const b = bot(botId);
  const endpoint = b && screenEndpoint(b, display);
  const page = endpoint ? await pageLines(endpoint).catch(() => null) : null;
  if (!page?.url) return siteOf("");
  const usual = siteOf(page.url, page.title);
  if (knownSite(page.url)) return usual;
  // Remembered per user too: it's in their words, with their name.
  const remembered = `${stateUser() ?? ""}\n${page.url}`;
  const hit = suggested.get(remembered);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.s;
  const owner = ownerName();
  try {
    const res = await client.responses.create({
      model: SUGGEST_MODEL,
      reasoning: { effort: "low" },
      instructions:
        `${owner} can ask their bot to keep a screen on a web page and give them a heads-up when something on it is worth their attention. Given the page, name the site the way ${owner} would say it, suggest 3 or 4 short things (2 to 5 words each) they would most plausibly want a heads-up about on THIS page, and one plain sentence describing the most useful default. Only suggest things that can actually appear or change on this page.`,
      input: JSON.stringify({ url: page.url, title: page.title, text: page.lines.slice(0, 50).join("\n").slice(0, 3500) }),
      text: {
        format: {
          type: "json_schema",
          name: "watch_suggestion",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["site", "picks", "lookFor"],
            properties: {
              site: { type: "string", description: "Short site name, e.g. Hacker News, Kitco, Zillow" },
              picks: { type: "array", items: { type: "string" }, description: "3 or 4 quick picks, 2 to 5 words each" },
              lookFor: { type: "string", description: `One plain sentence, in ${owner}'s voice, of the most useful default` },
            },
          },
        },
      },
    }, usageTags("chat", botId));
    // A suggestion in the app, counted with chat (the ledger has no kind of its own for it).
    recordTokens("chat", res.model, res.usage, botId, epoch);
    const s = JSON.parse(res.output_text) as Suggestion;
    const clean: Suggestion = { site: s.site.trim().slice(0, 40) || usual.site, lookFor: s.lookFor.trim().slice(0, 200) || usual.lookFor, picks: s.picks.map((p) => p.trim()).filter(Boolean).slice(0, 4) };
    if (!clean.picks.length) return usual;
    suggested.set(remembered, { at: Date.now(), s: clean });
    return clean;
  } catch (e) {
    console.warn(`[watch] suggest: ${(e as Error).message}`);
    return usual;
  }
}

/** Keep this screen on the site it's showing and watch it. Agents leave it alone from now on. */
export async function startWatch(botId: string, display: number, lookFor?: string, siteName?: string) {
  const b = bot(botId);
  if (!b) throw new Error("no such bot");
  const existing = watches().find((w) => isScreenWatch(w) && sameComputer(w.botId, botId) && w.display === display);
  if (existing?.botId === botId) return existing;
  if (existing) throw new Error(`${bot(existing.botId)?.name ?? "Another bot"} is already watching that screen`);
  if (busy(botId, display)) throw new Error(`That screen is in use right now`);
  const endpoint = screenEndpoint(b, display);
  if (!endpoint) throw new Error(`Bops can't see ${b.name}'s screens yet`);
  const page = await currentPage(endpoint).catch(() => null);
  if (!page || !/^https?:/.test(page.url)) throw new Error("open the site you want watched on that screen first");
  const { site, lookFor: usual } = siteOf(page.url, page.title);
  const w: Watch = { id: id("watch"), botId, display, site: siteName?.trim().slice(0, 40) || site, lookFor: usual, since: Date.now(), target: `${site}: ${page.title || page.url} (${page.url})` };
  if (lookFor?.trim()) w.lookFor = lookFor.trim();
  // The computer's screen ledger keeps threads and helpers off it.
  const computerId = workComputer(b).computerId;
  if (getState().host === "orgo" && computerId) {
    await ensureScreenTools(computerId, b.id);
    const claim = await orgo.bash(computerId, `bops-screens claim watch:${w.id} ${screenNo(display)}`, 15);
    if (claim.exit_code !== 0) throw new Error(`${b.name} is using that screen right now`);
  }
  update((state) => (state.watches ??= []).push(w));
  trackServerEvent("bops_watch_created", { kind: "site" });
  void syncWatchFile(botId);
  void look(w.id);
  return w;
}

/** What a watch is watching, as the user set it up (older watches: worked out from what they have). */
export function watchTarget(w: Watch) {
  return w.target ?? (w.mac ? `"${w.mac.title}" in ${w.mac.app}` : w.site);
}

/** What a Mac window is usually worth watching for, by app. */
function macLookFor(app: string, title: string) {
  if (/messages|whatsapp|telegram|signal|discord|slack/i.test(app)) return `new messages from ${title} that I haven't answered`;
  if (/mail|outlook|superhuman|spark/i.test(app)) return "new emails that need me";
  return "anything new there that needs me";
}

/** Watch a window on the user's Mac. The workspace's main bot keeps an eye on it and gives the heads-up. */
export async function startMacWatch(app: string, windowId: number, title: string, lookFor?: string) {
  const s = getState();
  const main = s.bots.find((b) => b.isMain && workspaceOf(b) === (s.workspace ?? MAIN_WORKSPACE)) ?? s.bots.find((b) => b.isMain);
  if (!main) throw new Error("there's no main bot to watch it");
  const existing = watches().find((w) => w.mac && w.mac.app === app && (w.mac.windowId === windowId || w.mac.title === title));
  if (existing) return existing;
  if (!(await findWindow(app, title, windowId))) throw new Error(`Bops can't find that ${app} window`);
  const w: Watch = {
    id: id("watch"),
    botId: main.id,
    display: 0,
    site: `${title} (${app})`,
    lookFor: lookFor?.trim() || macLookFor(app, title),
    since: Date.now(),
    mac: { app, title, windowId },
    target: `"${title}" in ${app}`,
  };
  update((state) => (state.watches ??= []).push(w));
  trackServerEvent("bops_watch_created", { kind: "mac_window" });
  void look(w.id);
  return w;
}

/* ---------------- Web pages, with no screen ---------------- */

/**
 * A web address as Bops fetches it: "example.com/prices" gets https:// in front, the part after # goes.
 * Null for anything that isn't an http or https page (mailto:, javascript:, file:, a bare word).
 */
function webUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  // "localhost:3000" is a host and a port; "javascript:" is a scheme Bops never fetches.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || (!u.hostname.includes(".") && u.hostname !== "localhost")) return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/** The same page, whatever way its address was written: "www.", http or https, a trailing slash aside. */
function pageKey(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.port ? `:${u.port}` : ""}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url;
  }
}

/** A page watch's gap between fetches, in minutes: PAGE_WATCH_MIN_MIN to a day, PAGE_WATCH_DEFAULT_MIN when unset. */
const everyOf = (n?: number | null) =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(PAGE_WATCH_MAX_MIN, Math.max(PAGE_WATCH_MIN_MIN, Math.round(n))) : PAGE_WATCH_DEFAULT_MIN;

/** "every 30 minutes", "every 2 hours", "every day". */
export function everyText(minutes: number) {
  if (minutes >= PAGE_WATCH_MAX_MIN) return "every day";
  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

/**
 * How long a page watch waits after its last fetch: its own gap, doubled for each fetch in a row that
 * failed, up to 6 hours (never less than its own gap).
 */
function pageGap(p: NonNullable<Watch["page"]>) {
  const every = p.everyMin * 60_000;
  return Math.max(every, Math.min(every * 2 ** (p.failures ?? 0), PAGE_BACKOFF_MAX_MS));
}

/**
 * When each page watch last read its page and found it the same: kept here, not saved on every read (an
 * idle Mac with ten watches would otherwise save its whole state, to the cloud too, thousands of times a
 * day). Saved with the next change, once an hour, or when the user checks it. After a restart, a watch
 * missing here reads once early.
 */
const g0 = globalThis as typeof globalThis & { __bopsPageChecked?: Map<string, number>; __bopsPageShown?: number };
const checkedSame = (g0.__bopsPageChecked ??= new Map<string, number>());
/** When a page watch last read its page, saved or not. */
const pageChecked = (w: Watch) => Math.max(w.page?.checkedAt ?? 0, checkedSame.get(w.id) ?? 0);

/** The watches as the window gets them: when each page was last read (saved or not), and none of what's kept to compare (only the server compares). */
export function watchesForApp(list: Watch[] | undefined): Watch[] | undefined {
  return list?.map((w) => (w.page ? { ...w, page: { ...w.page, checkedAt: pageChecked(w) || undefined, lines: undefined, hash: undefined, digests: undefined, seen: undefined } } : w));
}

/**
 * The text a page watch keeps of its lines, within PAGE_TEXT_CHARS, in page order: the lines just added
 * first (`first`, by digest; they're what changes next), then the lines kept before (`before`, by text),
 * then the rest from the top.
 */
function keptText(now: PageLine[], first: Set<string>, before: Set<string>): string[] {
  const pick = new Set<string>();
  let size = 0;
  const take = (l: PageLine) => {
    if (pick.has(l.digest) || size + l.line.length + 1 > PAGE_TEXT_CHARS) return;
    pick.add(l.digest);
    size += l.line.length + 1;
  };
  for (const l of now) if (first.has(l.digest)) take(l);
  for (const l of now) if (before.has(l.line)) take(l);
  for (const l of now) take(l);
  const out: string[] = [];
  for (const l of now) if (pick.delete(l.digest)) out.push(l.line);
  return out;
}

/**
 * A page as a watch keeps it from now on: every line's digest and the page's hash, and the text of its
 * lines (those in `first` first). Nothing is kept of lines that went: one that comes back is new again
 * (a status that returns, a restock after a sell out). `seen` (from older builds) is cleared.
 */
function keepPage(kept: NonNullable<Watch["page"]>, lines: PageLine[], first: Set<string>) {
  return { ...snapshotOf(lines), seen: undefined, lines: keptText(lines, first, new Set(kept.lines ?? [])) };
}

/** Numbers aside: "Bitcoin $#" for "Bitcoin $86,200". */
const shape = (line: string) => normalizeLine(line).replace(/\d[\d,.]*/g, "#");

/**
 * What a heads-up quotes: the line (bullets in front aside), and the line that went that it's a new
 * version of, when there is one (the same words with other numbers): "Bitcoin $86,200 (was Bitcoin $85,100)".
 */
function quoteOf(line: string, before: string[]) {
  const quote = (s: string, max: number) => s.replace(/^[•·*\-\s]+/, "").slice(0, max).trim();
  const s = shape(line);
  const old = s.includes("#") ? before.find((b) => shape(b) === s && normalizeLine(b) !== normalizeLine(line)) : undefined;
  return old ? `${quote(line, 120)} (was ${quote(old, 80)})` : quote(line, 120);
}

/** Why a fetch failed, in a line the user can read. */
const fetchError = (e: unknown) => ((e as Error)?.message || "it didn't answer").replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * A web page's lines of text, fetched with no screen (lib/server/web-page.ts: never a private address),
 * and what kind of page it was (html, json, xml or text).
 */
async function webPage(url: string) {
  const { pageLines: read } = await import("./web-page");
  return read(url);
}
type WebPage = Awaited<ReturnType<typeof webPage>>;

/**
 * A web page (HTML) with no text at all: it draws itself in a browser, or needs a sign in, so the read
 * failed. JSON, plain text or a feed with nothing in it is a page that's empty right now, and counts.
 */
const noText = (page: WebPage) => page.kind === "html" && !page.lines.length;

const patchPage = (watchId: string, patch: Partial<NonNullable<Watch["page"]>>) =>
  update((state) => {
    const w = state.watches?.find((x) => x.id === watchId);
    if (w?.page) Object.assign(w.page, patch);
  });

/** This bot's watch on this page, if it has one. */
const pageWatchOf = (botId: string, url: string) => watches().find((w) => w.botId === botId && w.page && pageKey(w.page.url) === pageKey(url));

/**
 * Watch a public web page with no screen: Bops fetches it every `everyMin` minutes (5 at least, a day at
 * most, 30 when unset) and the bot gives a heads-up when lines that match `lookFor` are added. The first
 * fetch happens now and is kept as how the page is. When it fails, or it's a web page (HTML) with no text
 * Bops can read without a browser, nothing is set up and the error says why in plain words, so the bot can
 * tell the user at once. JSON, text or a feed with nothing in it yet (an empty list of issues) is how the
 * page is, and can be watched. A bot watches a page once.
 */
export async function startPageWatch(botId: string, a: { url: string; lookFor?: string; everyMin?: number; site?: string }): Promise<Watch> {
  const b = bot(botId);
  if (!b) throw new Error("no such bot");
  const url = webUrl(a.url ?? "");
  if (!url) throw new Error("That isn't a web page address. It has to be a site like example.com or an http or https link.");
  if (pageWatchOf(botId, url)) throw new Error(`${b.name} is already watching that page.`);
  const epoch = stateEpoch();
  const host = new URL(url).hostname.replace(/^www\./, "");
  let page: WebPage;
  try {
    page = await webPage(url);
  } catch (e) {
    throw new Error(`Couldn't read ${host}: ${fetchError(e)}`);
  }
  if (noText(page)) throw new Error(`${host} shows no text Bops can read without a browser (it may need a sign in or JavaScript). Watch it on a computer instead.`);
  const lines = pageLinesOf(page.lines);
  // Signed out, or another account in, meanwhile: no watch is made in their state.
  if (epoch !== stateEpoch()) throw new Error("Bops was signed out meanwhile.");
  if (pageWatchOf(botId, url)) throw new Error(`${b.name} is already watching that page.`);
  const usual = siteOf(url, page.title);
  const site = a.site?.trim().slice(0, 40) || usual.site;
  const now = Date.now();
  const w: Watch = {
    id: id("watch"),
    botId,
    display: 0,
    site,
    // What the page shows new, by its address (a releases page, new releases); a site's usual (new DMs,
    // mentions) is for a signed-in screen, which a page read with no sign in never shows.
    lookFor: a.lookFor?.trim().slice(0, 300) || pageLookFor(url),
    since: now,
    target: `${site}: ${page.title || url} (${url})`,
    page: { url, everyMin: everyOf(a.everyMin), checkedAt: now, ...snapshotOf(lines), lines: keptText(lines, new Set(), new Set()) },
  };
  update((state) => (state.watches ??= []).push(w));
  trackServerEvent("bops_watch_created", { kind: "site" });
  return w;
}

/** What a page watch looks for when the user didn't say: what its address says it lists, else anything new. */
function pageLookFor(url: string) {
  const path = new URL(url).pathname.toLowerCase();
  if (/\/releases?(\/|$)/.test(path)) return "a new release";
  if (/\/pulls?(\/|$)/.test(path)) return "a new pull request";
  if (/\/issues(\/|$)/.test(path)) return "a new issue";
  if (/\/commits?(\/|$)/.test(path)) return "a new commit";
  if (/\/(changelog|changes|news|blog|posts?|updates)(\/|$)/.test(path)) return "a new post";
  return "anything new on the page";
}

/** What one look found: nothing new, a change with nothing to tell, a heads-up given, or it couldn't read the page. */
export type CheckResult = "same" | "changed" | "told" | "failed";

/**
 * Fetch a watched page when it's due (`now`: the user asked, so at once, due or not, paused or not). The
 * page is compared with what was kept of it, every line in its steady form (what's certainly noise aside:
 * cloud/page-diff.ts). Lines not on the kept page are new, a line that went and came back too. With
 * none, nothing is written (pageChecked), but for an hourly save that takes in what went or moved, or a
 * check the user asked for. With some, up to PAGE_JUDGE_LINES of them are judged in one call, with a
 * count of the rest and the lines they replaced; the page is kept as it is now, but for the lines past
 * those judged, which are new again at the next read. A failed fetch, or a web page that comes back with
 * no text, is kept on the watch (error, failures) with the page as it was, and the next waits longer;
 * one that works clears it.
 */
async function checkPage(watchId: string, now = false): Promise<CheckResult | undefined> {
  const w = watchById(watchId);
  if (!w?.page || looking.has(watchId)) return;
  if (!now && (w.paused || Date.now() - pageChecked(w) < pageGap(w.page))) return;
  const epoch = stateEpoch();
  looking.add(watchId);
  try {
    const failed = (error: string) => {
      const kept = watchById(watchId)?.page;
      if (epoch === stateEpoch() && kept) patchPage(watchId, { checkedAt: Date.now(), error, failures: (kept.failures ?? 0) + 1 });
      return "failed" as const;
    };
    let page: WebPage;
    try {
      page = await webPage(w.page.url);
    } catch (e) {
      return failed(fetchError(e));
    }
    const was = watchById(watchId);
    if (epoch !== stateEpoch() || !was?.page) return;
    const kept = was.page;
    if (noText(page)) return failed("The page came back empty.");
    const lines = pageLinesOf(page.lines);
    const at = Date.now();
    const ok = { checkedAt: at, error: undefined, failures: undefined, odd: undefined };
    // Kept before every line's fingerprint was: the page is taken in as it is.
    if (!kept.digests) {
      patchPage(watchId, { ...ok, changedAt: at, ...snapshotOf(lines), seen: undefined, lines: keptText(lines, new Set(), new Set()) });
      return "changed";
    }
    const added = snapshotOf(lines).hash === kept.hash ? [] : newLines(kept.digests, lines);
    if (!added.length) {
      checkedSame.set(watchId, at);
      // Nothing new (the same page, or lines that went, moved or came back). Written only with something
      // to clear, once an hour (taking in the page as it is), or when the user asked (so the window shows
      // it at once); else the window is told it moved on now and then.
      if (now || kept.error || kept.failures || kept.odd || at - (kept.checkedAt ?? 0) >= CHECKED_SAVE_MS) patchPage(watchId, { ...ok, ...keepPage(kept, lines, new Set()) });
      else if (at - (g0.__bopsPageShown ?? 0) >= CHECKED_SHOW_MS) {
        g0.__bopsPageShown = at;
        touchState();
      }
      return "same";
    }
    // What went from the page (its lines that are gone, those Bops kept the text of): what new lines may have replaced.
    const present = new Set(lines.map((l) => l.digest));
    const before = (kept.lines ?? []).filter((l) => !present.has(lineDigest(l))).slice(0, PAGE_JUDGE_LINES).map((l) => l.slice(0, 300));
    const judged = added.slice(0, PAGE_JUDGE_LINES);
    const shown = judged.map((l) => l.raw.slice(0, 300));
    const j = await judgePage(was, page, shown, added.length - shown.length, before, epoch);
    if (epoch !== stateEpoch() || !watchById(watchId)) return;
    // No model answered: the page stays as it was kept, so these lines are judged at the next fetch.
    if (!j) {
      patchPage(watchId, ok);
      return "changed";
    }
    // The new lines past those judged aren't kept, so they're new again at the next read and judged then.
    const later = new Set(added.slice(PAGE_JUDGE_LINES).map((l) => l.digest));
    const keep = later.size ? lines.filter((l) => !later.has(l.digest)) : lines;
    patchPage(watchId, { ...ok, changedAt: at, ...keepPage(kept, keep, new Set(judged.map((l) => l.digest))) });
    if (j.yes < SURE) return "changed";
    // The line the judge picked, quoted; with none picked, that the page changed and what it's watched for.
    return (await tell(watchId, j.line ? quoteOf(j.line, before) : null, epoch)) ? "told" : "changed";
  } catch (e) {
    console.warn(`[watch] ${watchId}: ${(e as Error).message}`);
    return "failed";
  } finally {
    looking.delete(watchId);
  }
}

/**
 * What changes on a page with nothing new, for a judge: the steady form takes out only what is certainly
 * noise (cloud/page-diff.ts), so the rest is the judge's to tell apart.
 */
const NOT_NEWS =
  "A stamp or a clock that moved on (when the page was updated, the time now), a count that ticked (views, likes, points, comments, watching), an ad or a banner, the same things in a new order, or a cookie, sign in or error page shown instead of the page (or the page back after one) are not news, unless `look_for` is about them.";

/**
 * Whether any line new on a watched page is what the user asked to hear about, and which is the newest
 * that is: one Jev call when Jev is there; else one quick, low-effort OpenAI call that answers the same
 * question. `before` is what went from the page (what the new lines may have replaced), so a price
 * crossing a line, or one that moved, can be judged, and a condition that was already true isn't news.
 * A line that comes back (a status that returns) is judged like any new line: it's news again. `more`:
 * how many new lines there were past `lines`. `yes` is how sure (0 to 1); null when neither answered.
 */
async function judgePage(w: Watch, page: { url: string; title: string }, lines: string[], more: number, before: string[], epoch: number): Promise<{ yes: number; line?: string } | null> {
  const owner = ownerName();
  const was = before.length ? before.join("\n") : "(nothing went from the page)";
  const rest = more > 0 ? { more_added: `${more} more new lines, not shown now (they come next read)` } : {};
  const rule = `\`added\` are the lines that are new on the page since it was last read (the first ones, when \`more_added\` says there are more); \`before\` are lines that were on it then and are gone now (what the new ones may have replaced). Something already true in \`before\` (the same item, or the same condition, such as a price already above the line) is not news. For a crossing or a move, compare the line in \`added\` with its old value in \`before\`. ${NOT_NEWS}`;
  const a = await decide(
    { look_for: w.lookFor, watching: watchTarget(w), page: { site: w.site, url: page.url, title: page.title }, added: lines.join("\n"), ...rest, before: was },
    {
      waiting: {
        type: "noul",
        instructions: `${owner} is watching the web page \`watching\` and told their bot exactly what to tell them about: \`look_for\`. That is the only test. ${rule} Does any line in \`added\` match \`look_for\` as ${owner} worded it, as news to them? A new line that doesn't match \`look_for\` does not count, however new it is.`,
        criteria: {
          true: `Yes: a line in \`added\` matches \`look_for\`, as ${owner} worded it, and it's news to them`,
          false: "No: nothing in `added` matches `look_for` (other new lines don't count), or it was already true in `before`",
        },
      },
      item: {
        type: "choice",
        instructions: "Which line of `added` is the newest thing that matches `look_for`?",
        criteria: Object.fromEntries([...lines.map((l, i) => [`l${i}`, l]), ["none", "None of these lines"]]),
      },
    },
    { botId: w.botId },
  );
  if (a) {
    const pick = chose(a.item);
    return { yes: yes(a.waiting) ?? 0, line: pick && pick.choice !== "none" && pick.confidence >= 0.3 ? lines[Number(pick.choice.slice(1))] : undefined };
  }
  // No Jev (not set up, or not answering): the same question, once, to OpenAI.
  try {
    const res = await client.responses.create(
      {
        model: SUGGEST_MODEL,
        reasoning: { effort: "low" },
        instructions: `${owner} is watching a web page (\`watching\`) and told their bot exactly what to tell them about: \`look_for\`. ${rule} \`added\` is numbered from 0. Does any line in \`added\` match \`look_for\` as ${owner} worded it, as news to them? A new line that doesn't match does not count, however new it is. Answer matches (true or false) and line: the number of the newest line that matches, or null.`,
        input: JSON.stringify({ look_for: w.lookFor, watching: watchTarget(w), page: { url: page.url, title: page.title }, added: lines.map((l, i) => `${i}: ${l}`), ...rest, before }),
        text: {
          format: {
            type: "json_schema",
            name: "watch_judgment",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["matches", "line"],
              properties: { matches: { type: "boolean" }, line: { type: ["integer", "null"], description: "The number of the newest matching line in `added`, or null" } },
            },
          },
        },
      },
      usageTags("decide", w.botId),
    );
    // It does Jev's job, so it's counted as a quick check.
    recordTokens("decide", res.model, res.usage, w.botId, epoch);
    const out = JSON.parse(res.output_text) as { matches?: boolean; line?: number | null };
    return { yes: out.matches ? 1 : 0, line: typeof out.line === "number" ? lines[out.line] : undefined };
  } catch (e) {
    console.warn(`[watch] ${w.id}: couldn't judge the page: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Write the watched screens of the computer this bot works on (/root/.bops/watches.json) for its screen
 * tools to read: every bot's that works on it, since one file covers the whole computer.
 */
async function syncWatchFile(botId: string) {
  const b = bot(botId);
  const computerId = b && workComputer(b).computerId;
  if (getState().host !== "orgo" || !computerId) return;
  const map = Object.fromEntries(watches().filter((w) => sameComputer(w.botId, botId) && isScreenWatch(w)).map((w) => [screenNo(w.display), { site: w.site, lookFor: w.lookFor }]));
  const body = Buffer.from(JSON.stringify(map)).toString("base64");
  await orgo.bash(computerId, `mkdir -p /root/.bops && echo ${body} | base64 -d > /root/.bops/watches.json`, 15).catch(() => {});
}

export async function stopWatch(watchId: string) {
  const w = watchById(watchId);
  if (!w) return;
  update((state) => (state.watches = state.watches?.filter((x) => x.id !== watchId)));
  const b = bot(w.botId);
  // A Mac window or a web page holds no screen.
  if (!isScreenWatch(w)) return;
  const computerId = b && workComputer(b).computerId;
  if (getState().host === "orgo" && computerId) await orgo.bash(computerId, `bops-screens release watch:${w.id}`, 15).catch(() => {});
  void syncWatchFile(w.botId);
}

/** Change what a watch is watched for, and for a web page how often it's fetched (`everyMin`, in minutes). */
export function editWatch(watchId: string, lookFor: string, everyMin?: number | null) {
  if (lookFor.trim()) patchWatch(watchId, { lookFor: lookFor.trim().slice(0, 300) });
  const w = watchById(watchId);
  if (w?.page && typeof everyMin === "number") patchPage(watchId, { everyMin: everyOf(everyMin) });
  if (w && isScreenWatch(w)) void syncWatchFile(w.botId);
}

/**
 * Pause a watch, or resume it. Paused, it isn't looked at (a screen stays kept for it). Resumed, it
 * looks at once, and what changed while it was paused is judged like any change.
 */
export function setWatchPaused(watchId: string, paused: boolean) {
  const w = watchById(watchId);
  if (!w) throw new Error("That isn't being watched anymore.");
  if (!!w.paused === paused) return w;
  patchWatch(watchId, { paused: paused || undefined });
  if (!paused) void look(watchId, true);
  return watchById(watchId) ?? w;
}

/**
 * Look at a watch now, as the user asked (Check now): a web page is fetched at once, due or not, paused
 * or not, and when it was checked is saved, so the window shows it at once; a screen or a Mac window is
 * read at once. The watch as it is after (as the window gets it), and what the look found.
 */
export async function checkNow(watchId: string): Promise<{ watch: Watch; result: CheckResult }> {
  const w = watchById(watchId);
  if (!w) throw new Error("That isn't being watched anymore.");
  if (isScreenWatch(w) && busy(w.botId, w.display)) throw new Error("That screen is in use right now.");
  // A look already under way (the loop's): let it end, then look again.
  for (let i = 0; i < 80 && looking.has(watchId); i++) await new Promise((r) => setTimeout(r, 250));
  const result = (await look(watchId, true)) ?? "failed";
  // As the window gets it (watchesForApp): what's kept to compare stays on the server.
  return { watch: watchesForApp([watchById(watchId) ?? w])![0], result };
}

/** The user looked at what the screen flagged; clear the badge. */
export function seenWatch(watchId: string) {
  if (watchById(watchId)?.alert) patchWatch(watchId, { alert: undefined });
}

/** Start a thread on the watched screen itself (it's signed in there) to draft a reply. Never sends. */
export function draftReply(watchId: string) {
  const w = watchById(watchId);
  if (!w) throw new Error("that screen isn't being watched anymore");
  // One draft at a time per screen: a second tap shows the one already being written.
  const drafting = getState().sessions.find((s) => s.onWatch === watchId && live(s));
  if (drafting) return drafting;
  // A window on the Mac: bots can't write in the Mac's apps for now (lib/server/mac.ts).
  if (w.mac) throw new Error(`Bots can't write in ${w.mac.app} on your Mac for now.`);
  if (w.page) throw new Error(`${w.site} is a web page Bops reads on its own: there's no screen to reply on.`);
  const what = w.alert?.text ?? [w.told ?? []].flat().at(-1) ?? "the newest thing waiting for me";
  patchWatch(watchId, { alert: undefined });
  return startSession({
    botId: w.botId,
    goal: `On your screen with ${w.site} open, find this: "${what}". Open it and write a short, friendly reply in my voice in the reply box, then stop. Don't send it: I'll read it and send it myself.`,
    title: `Reply on ${w.site}`,
    onWatch: w.id,
  });
}

// What each watched page looked like at its last check, and when Jev last read it.
const lastSeen = new Map<string, string>();
const lastLines = new Map<string, string[]>();
const lastRead = new Map<string, number>();
const looking = new Set<string>();

/**
 * Check one watch: a web page when it's due (checkPage); a screen or a Mac window, if its page changed,
 * has Jev read it. Paused watches are skipped. `now`: the user asked (Check now, Resume), so it looks
 * at once, paused or not, without waiting out READ_MS.
 */
async function look(watchId: string, now = false): Promise<CheckResult | undefined> {
  const w = watchById(watchId);
  if (w?.page) return checkPage(watchId, now);
  const b = w && bot(w.botId);
  if (!w || !b || looking.has(watchId) || (w.paused && !now) || (isScreenWatch(w) && busy(w.botId, w.display))) return;
  const endpoint = isScreenWatch(w) ? screenEndpoint(b, w.display) : null;
  if (isScreenWatch(w) && !endpoint) return;
  const epoch = stateEpoch();
  looking.add(watchId);
  try {
    const page = w.mac ? await macPage(w).catch(() => null) : await pageLines(endpoint!).catch(() => null);
    if (!page?.url) return "failed";
    // In its steady form, counts aside: a clock, a "5m ago", an "Updated 3:45 PM" or a feed's "1.2K views"
    // moving on is not a change, and costs no read (cloud/page-diff.ts screenLines).
    const fingerprint = `${page.url}|${normalizeTitle(page.title)}|${screenLines(page.lines).join("\n")}`;
    if (fingerprint === lastSeen.get(watchId)) return "same";
    if (!now && Date.now() - (lastRead.get(watchId) ?? 0) < READ_MS) return; // a later look picks it up
    lastSeen.set(watchId, fingerprint);
    lastRead.set(watchId, Date.now());

    // A Mac conversation lists its newest messages last: keep the top (the list, "Unread") and the end.
    const lines = w.mac && page.lines.length > 60 ? [...page.lines.slice(0, 20), ...page.lines.slice(-40)] : page.lines.slice(0, 60);
    // Jev sees the page as it was at the last read too, so "big price moves" or "a new item" can be judged.
    const before = lastLines.get(watchId);
    const owner = ownerName();
    const a = await decide(
      {
        look_for: w.lookFor,
        watching: watchTarget(w),
        // What the screen showed when the user set the watch up, and what it shows now: the plainest sign of whether it moved.
        set_up_on: w.mac ? { window_title: w.mac.title, app: w.mac.app } : { site: w.site, page: w.target ?? w.site },
        showing_now: w.mac ? { window_title: page.title, app: w.mac.app } : { site: w.site, url: page.url, title: page.title },
        page: { site: w.site, url: page.url, title: page.title, text: lines.join("\n") },
        before: before ? before.join("\n") : "(first look at this page)",
      },
      {
        on_target: {
          type: "noul",
          instructions:
            `${owner} set up a watch on \`watching\`; \`set_up_on\` is what the screen showed then and \`showing_now\` is what it shows now (a window's title names the conversation or document it shows; a page's address and title say where it is). Is it still showing that same thing, so \`look_for\` can be judged on it? The same conversation, inbox, feed or view counts even when its content or unread count changed; a different conversation, document, page, account or view does not.`,
          criteria: {
            true: `Yes: it's the same thing ${owner} is watching, maybe with new content`,
            false: "No: the screen now shows something else",
          },
        },
        waiting: {
          type: "noul",
          instructions:
            `${owner} is watching \`watching\` and told their bot exactly what to tell them about: \`look_for\`. That is the only test. Does \`page\` now show something new since \`before\` that matches \`look_for\` as ${owner} worded it, about \`watching\`? Something new or unread that doesn't match \`look_for\` does not count, however new it is. ${NOT_NEWS} Lines starting "Me:" are messages ${owner} sent (never news to ${owner}); "Them:" lines are from the other person.`,
          criteria: {
            true: `Yes: something on the page matches \`look_for\`, as ${owner} worded it, and it's news to them`,
            false: "No: nothing matches `look_for` (other new or unread things don't count), or it was already like this before",
          },
        },
        ...(lines.length
          ? {
              item: {
                type: "choice" as const,
                instructions: "Which line of `page` is the newest thing that matches `look_for` (who it's from and what it says)?",
                criteria: Object.fromEntries([...lines.map((l, i) => [`l${i}`, l]), ["none", "None of these lines"]]),
              },
            }
          : {}),
      },
      { botId: w.botId },
    );
    if (!a) return "changed";
    const cur = watchById(watchId);
    if (!cur) return;
    patchWatch(watchId, { readAt: Date.now() });
    // Showing something else right now: say so, and judge nothing until the watched thing is back.
    const onTarget = yes(a.on_target) ?? 1;
    if (onTarget < 0.5) {
      if (!cur.away) patchWatch(watchId, { away: true });
      return "changed";
    }
    // A watch tells the user what's new: the first look (after setting up, a restart, or coming back
    // from Paused) only takes in how things are now; changes from then on are what count.
    lastLines.set(watchId, lines);
    if (cur.away || !before) {
      if (cur.away) patchWatch(watchId, { away: false });
      return "changed";
    }
    const waiting = yes(a.waiting) ?? 0;
    // Read or answered since: the badge goes away by itself.
    if (waiting < 0.3) {
      if (cur.alert) patchWatch(watchId, { alert: undefined });
      return "changed";
    }
    if (waiting < SURE) return "changed";
    const pick = chose(a.item);
    const line = pick && pick.choice !== "none" && pick.confidence >= 0.3 ? lines[Number(pick.choice.slice(1))] : undefined;
    const text = (line ?? page.title).replace(/^(Me|Them): /, "").replace(/^[•·*\-\s]+/, "").slice(0, 120);
    return (await tell(watchId, text, epoch)) ? "told" : "changed";
  } catch (e) {
    console.warn(`[watch] ${watchId}: ${(e as Error).message}`);
    return "failed";
  } finally {
    looking.delete(watchId);
  }
}

/**
 * What a watch looks for in a few words, for a heads-up with no line to quote: "an outage", "Bitcoin above
 * $86,000"; at most 8 words and 80 characters, with "…" when it was cut.
 */
function fewWords(s: string) {
  const words = s.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").split(" ");
  const few = words.slice(0, 8).join(" ");
  return few.length > 80 ? `${few.slice(0, 80).trimEnd()}…` : words.length > 8 ? `${few}…` : few;
}

/**
 * Tell the user what a watch found: interrupt, just show it, or hold it for later, as urgency() says.
 * `found` is the line, quoted in the heads-up; null for a web page the judge said matches with no line
 * picked: then the heads-up says the page changed, and what it's watched for, in a few words. Not twice:
 * a screen or a Mac window never tells the same words (times aside) twice (`told`, the last 30); a web
 * page skips only the words its alert still shows (the user hasn't looked yet), so a status that comes
 * back, or a restock after a sell out, is told again. False when it wasn't told.
 */
async function tell(watchId: string, found: string | null, epoch: number) {
  const w = watchById(watchId);
  if (!w) return false;
  const few = fewWords(w.lookFor);
  const text = found ?? `Changed: ${few}`;
  // (Watches from before kept only the last one, as a string.)
  const told: string[] = Array.isArray(w.told) ? w.told : w.told ? [w.told] : [];
  const same = (t: string) => (normalizeLine(t) || t) === (normalizeLine(text) || text);
  if (w.page ? w.alert && same(w.alert.text) : told.some(same)) return false;
  const owner = ownerName();
  const where = w.mac ? `in ${w.mac.title} on your Mac` : `on ${w.site}`;
  const what = w.mac ? `"${w.mac.title}" in ${w.mac.app} on ${owner}'s Mac` : w.page ? `the web page ${w.site} (${w.page.url})` : w.site;
  // How much of the user's attention it gets: interrupt now, just show it, or hold it for later.
  const level = await urgency({ kind: "watch", what, news: text, lookFor: w.lookFor });
  // Signed out, or another account in, meanwhile: what this watch saw was the last account's. Stopped meanwhile: nothing to tell.
  if (epoch !== stateEpoch() || !watchById(watchId)) return false;
  patchWatch(watchId, { alert: { text, at: Date.now(), level }, told: [...told, text].slice(-30) });
  const name = w.mac?.title ?? w.site;
  if (level === "later") holdForLater({ botId: w.botId, text: found === null ? `${name} changed: ${few}` : `${name}: “${text}”`, watchId });
  else
    addMessage({
      chatId: botChatId(w.botId),
      role: "bot",
      botId: w.botId,
      text: found === null ? `Heads up, ${w.site} changed. It looks like what you're watching for: ${few}${few.endsWith("…") ? "" : "."}` : `Heads up, something new ${where}: “${text}”`,
      watch: { id: watchId },
    });
  return true;
}

/** A watched Mac window read as a page: its text through accessibility. Following it if its id changed. */
async function macPage(w: Watch) {
  const m = w.mac!;
  const win = await findWindow(m.app, m.title, m.windowId);
  if (!win) return null;
  if ((win.title ?? "") === m.title && win.window_id !== m.windowId) patchWatch(w.id, { mac: { ...m, windowId: win.window_id } });
  // Read as it is; Jev decides whether it still shows what's being watched.
  return { url: `mac:${m.app}`, title: win.title || m.app, lines: await windowText(win.pid, win.window_id) };
}

// One loop for every watched screen; importing this module (the state route does) starts it. The
// loop calls whatever version of `look` was loaded last, so edits apply without a restart.
const g = globalThis as typeof globalThis & { __bopsWatches?: ReturnType<typeof setInterval>; __bopsLook?: typeof look };
g.__bopsLook = look;
g.__bopsWatches ??= setInterval(() => {
  if (!stateReady()) return;
  for (const w of getState().watches ?? []) void g.__bopsLook?.(w.id);
}, LOOK_MS);

/** Names compare loosely: case, emoji and punctuation aside ("jordan" finds "Jordan 🌵✨"). */
const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** What the bot tells the user about a watch it set up from chat (or already had), in plain words. */
function watchSaid(w: Watch, already?: boolean) {
  const owner = ownerName();
  const what = w.page ? `${w.site} ${everyText(w.page.everyMin)}` : w.site;
  const state = w.away
    ? " It's paused right now: the app is showing something else, and it picks up when that's back on screen."
    : w.paused
      ? ` It's paused: ${owner} can resume it under Monitors.`
      : "";
  return `${already ? "Already watching" : "Watching"} ${what} for: ${w.lookFor}. ${owner} gets a heads-up here when it shows up.${state}`;
}

/**
 * The user asked a bot in chat to watch something; set it up like the Watch button would. On their Mac:
 * the window of that app whose title matches (a Messages window shows one conversation, so it has to
 * be the one showing). On the web: a public page fetched with no screen, every `every_minutes` (30 when
 * unset; 5 at least, a day at most); a page it already watches is kept, with what the user said now, and
 * resumed if paused. On the bot's computer: a screen already on that site, else a free one opened to it.
 * `said` is what to tell the user. When it can't tell or can't see it, `reply` says what the user needs
 * to do, or why it can't (the bot passes it on).
 */
export async function watchFromChat(
  botId: string,
  a: {
    where: "mac" | "computer" | "web";
    app?: string | null;
    window?: string | null;
    url?: string | null;
    look_for?: string | null;
    every_minutes?: number | null;
  },
): Promise<{ watch: Watch; already?: boolean; said: string } | { reply: string }> {
  if (a.where === "web") {
    if (!bot(botId)) return { reply: "No such bot." };
    if (!a.url?.trim()) return { reply: "Which page should be watched? Give its address." };
    const url = webUrl(a.url);
    if (!url) return { reply: `${a.url.trim()} isn't a web page address. It has to be a site like example.com or an http or https link.` };
    const had = pageWatchOf(botId, url);
    if (had) {
      editWatch(had.id, a.look_for ?? "", a.every_minutes);
      if (had.paused) setWatchPaused(had.id, false);
      const w = watchById(had.id) ?? had;
      return { watch: w, already: true, said: watchSaid(w, true) };
    }
    try {
      const w = await startPageWatch(botId, { url, lookFor: a.look_for ?? undefined, everyMin: a.every_minutes ?? undefined });
      return { watch: w, said: watchSaid(w) };
    } catch (e) {
      return { reply: (e as Error).message };
    }
  }
  if (a.where === "mac") {
    const owner = ownerName();
    const app = loose(a.app ?? "");
    if (!app) return { reply: "Which app on the Mac (Messages, Mail, Slack…)?" };
    // Already watched (maybe paused while the app shows something else): keep it, with what the user said now.
    const want0 = loose(a.window ?? "");
    const had = watches().find((w) => w.mac && loose(w.mac.app).includes(app) && (!want0 || loose(w.mac.title).includes(want0) || want0.includes(loose(w.mac.title))));
    if (had) {
      if (a.look_for?.trim() && a.look_for.trim() !== had.lookFor) editWatch(had.id, a.look_for);
      const w = watchById(had.id) ?? had;
      return { watch: w, already: true, said: watchSaid(w, true) };
    }
    const wins = (await listWindows()).filter((w) => loose(w.app).includes(app) || app.includes(loose(w.app)));
    if (!wins.length) return { reply: `${a.app} isn't open on ${owner}'s Mac. Ask ${owner} to open it (and the conversation or mailbox to watch), then try again.` };
    const want = loose(a.window ?? "");
    const hits = want ? wins.filter((w) => loose(w.title).includes(want) || want.includes(loose(w.title))) : wins;
    if (!hits.length) return { reply: `${wins[0].app} is showing ${wins.map((w) => `"${w.title}"`).join(", ")}, not ${a.window}. Ask ${owner} to open it there, then try again.` };
    if (hits.length > 1) return { reply: `More than one ${wins[0].app} window matches: ${hits.map((w) => `"${w.title}"`).join(", ")}. Ask ${owner} which one.` };
    const w = await startMacWatch(hits[0].app, hits[0].windowId, hits[0].title, a.look_for ?? undefined);
    return { watch: w, said: watchSaid(w) };
  }
  const b = bot(botId);
  if (!b) return { reply: "No such bot." };
  if (!a.url?.trim()) return { reply: "Which site should be watched?" };
  const url = /^[a-z]+:\/\//i.test(a.url) ? a.url.trim() : `https://${a.url.trim()}`;
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const pages = await Promise.all(
    DISPLAYS.map(async (d) => {
      const ep = screenEndpoint(b, d);
      return { d, page: ep ? await currentPage(ep).catch(() => null) : null, ep };
    }),
  );
  if (!pages.some((p) => p.ep)) return { reply: `${b.name}'s computer isn't ready yet.` };
  // Watched by any bot on this computer (bots that share one share its screens), or just by another one.
  const watchedBy = (d: number, other = false) => watches().some((w) => isScreenWatch(w) && sameComputer(w.botId, botId) && (!other || w.botId !== botId) && w.display === d);
  const taken = (d: number) => busy(botId, d) || watchedBy(d);
  // A screen already on that site, then a free one (an empty one first).
  const on = pages.find((p) => p.page && host(p.page.url) === host(url) && !busy(botId, p.d) && !watchedBy(p.d, true));
  if (on) {
    const w = await startWatch(botId, on.d, a.look_for ?? undefined);
    return { watch: w, said: watchSaid(w) };
  }
  const free = pages.filter((p) => p.ep && !taken(p.d)).sort((x, y) => Number(!!y.page?.url.startsWith("chrome://")) - Number(!!x.page?.url.startsWith("chrome://")))[0];
  if (!free?.ep) return { reply: `All of ${b.name}'s screens are busy right now.` };
  await navigate(free.ep, url);
  // The page has to load before the watch can read what it's on.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 750));
    const p = await currentPage(free.ep).catch(() => null);
    if (p && host(p.url) === host(url) && p.title) break;
  }
  const w = await startWatch(botId, free.d, a.look_for ?? undefined);
  return { watch: w, said: watchSaid(w) };
}

/** The watches a bot can see and change from chat (ids, what, for what), for its instructions. */
export function watchesNote(botIds: string[], withMac: boolean) {
  const mine = watches().filter((w) => (w.mac ? withMac : botIds.includes(w.botId)));
  if (!mine.length) return "";
  const owner = ownerName();
  const what = (w: Watch) =>
    w.mac
      ? `"${w.mac.title}" in ${w.mac.app} on ${owner}'s Mac`
      : w.page
        ? `the web page ${w.site} (${w.page.url}), read ${everyText(w.page.everyMin)}`
        : `${w.site} on ${bot(w.botId)?.name}'s screen ${screenNo(w.display)}`;
  const state = (w: Watch) =>
    `${w.paused ? ` · paused by ${owner}` : ""}${w.away ? " · paused (not showing right now)" : ""}${w.page?.error ? ` · the last ${w.page.failures && w.page.failures > 1 ? `${w.page.failures} reads` : "read"} failed: ${w.page.error}` : ""}`;
  return [
    `Watches (screens, Mac windows and web pages Bops keeps an eye on for ${owner}; stop_watch takes the id):`,
    ...mine.map((w) => `- ${w.id}: ${what(w)} · looking for ${w.lookFor}${state(w)}`),
  ].join("\n");
}

/**
 * The user asks a thread to keep an eye on its screen ("watch this chart and tell me if it goes above
 * 86,000"). A thread would do that by checking again and again itself, spending model time without
 * end and never showing as a watch; a watch reads the page whenever it changes, for nothing in
 * between. So the thread stops and its screen (or, on their Mac, the window it worked in) becomes a
 * watch for what they asked. Returns null when the message isn't that (then it goes to the thread as usual).
 */
export async function watchInstead(sessionId: string, text: string): Promise<Watch | null> {
  const epoch = stateEpoch();
  const s = session(sessionId);
  const display = s?.display ?? s?.lastDisplay;
  if (!s) return null;
  const owner = ownerName();
  // On the user's Mac: the window the thread last worked in (its tools record it), else its app's main one.
  const macApp = s.runsOn === "mac" ? s.macApps?.at(-1) : undefined;
  if (s.runsOn === "mac" ? !macApp : display === undefined) return null;
  const a = await decide(
    { task: s.title, owner_said: text.slice(0, 1500) },
    {
      ongoing: {
        type: "noul",
        instructions:
          `${owner} told an AI agent that's working on a screen what's in \`owner_said\`. Are they asking it to keep watching the screen over time and tell them when something happens or changes (a price crossing a number, a new message, a status changing), rather than to do something now? Finding out when something already happened ("find when the credits ran out", "when did it last change?") is doing something now: looking it up, not waiting for it.`,
        criteria: { true: "Keep watching over time and tell them when it happens in the future", false: "Do something now (including looking up when something already happened), or anything else" },
      },
    },
    { botId: s.botId },
  );
  if ((yes(a?.ongoing) ?? 0) < 0.7) return null;
  // What to watch for, short and in their words ("Bitcoin goes above $86,000").
  const res = await client.responses
    .create({
      model: SUGGEST_MODEL,
      reasoning: { effort: "low" },
      instructions: `${owner} asked for a screen to be watched. Write what to watch for as one short phrase in their words, like "Bitcoin goes above $86,000" or "a reply from Dana". Just the phrase.`,
      input: `Screen: ${s.title}. ${owner}: ${text.slice(0, 1500)}`,
    }, usageTags("chat", s.botId))
    .catch(() => null);
  if (res) recordTokens("chat", res.model, res.usage, s.botId, epoch);
  // Signed out, or another account in, meanwhile: no watch is made for this thread in their state.
  if (epoch !== stateEpoch()) return null;
  const lookFor = res?.output_text?.trim().replace(/^["“]|["”.]$/g, "").slice(0, 200) || text.slice(0, 200);
  if (live(s)) {
    stopSession(s.id, "Handed to a watch");
    for (let i = 0; i < 60 && live(session(s.id)!); i++) await new Promise((r) => setTimeout(r, 250));
  }
  let w: Watch;
  try {
    if (macApp) {
      // Its exact window when it recorded one; else the window whose title the thread talks about (a
      // Messages window shows one conversation at a time, so "Jordan" has to be the one showing);
      // else the app's main window.
      const wins = await appWindows(macApp);
      const told = loose(`${s.title} ${s.goal} ${s.answer ?? ""} ${text}`);
      const win =
        (s.macWindow && wins.find((x) => x.window_id === s.macWindow!.windowId)) ||
        wins.find((x) => x.title && loose(x.title).split(" ").some((word) => word.length > 2 && told.includes(word))) ||
        (await mainWindow(macApp));
      if (!win) throw new Error(`${macApp} isn't open on your Mac anymore`);
      w = await startMacWatch(win.app_name, win.window_id, win.title || macApp, lookFor);
      // The same window may have been watched already, for something else: now it's for this.
      if (w.lookFor !== lookFor) editWatch(w.id, lookFor);
      w = watchById(w.id) ?? w;
    } else w = await startWatch(s.botId, display!, lookFor);
  } catch (e) {
    addMessage({ chatId: s.chatId, role: "system", text: `Couldn't watch that screen: ${(e as Error).message}` });
    return null;
  }
  const said = `Watching ${macApp ? `${w.mac?.title ?? macApp} on your Mac` : "this screen"} for ${lookFor}. You'll get a heads-up when it happens.`;
  patchSession(s.id, (x) => {
    x.replies.push({ id: id("rep"), role: "user", text, at: Date.now(), delivered: true });
    x.replies.push({ id: id("rep"), role: "bot", text: said, at: Date.now(), delivered: true });
    // Handing it to a watch is the thread's result, not a failure.
    x.status = "done";
    x.error = undefined;
    x.answer = said;
    x.endedAt = Date.now();
  });
  addMessage({ chatId: s.chatId, role: "system", text: `Watching ${w.site} · ${w.lookFor}` });
  return w;
}
