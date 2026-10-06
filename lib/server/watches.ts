import "server-only";
import { botChatId, DISPLAYS, live, MAIN_WORKSPACE, workspaceOf, type Watch } from "@/lib/types";
import { decide, chose, yes } from "./decide";
import { holdForLater, urgency } from "./attention";
import { currentPage, navigate, pageLines } from "./local";
import { appWindows, findWindow, listWindows, mainWindow, windowText } from "./mac-windows";
import { orgo } from "./orgo";
import { sameComputer, screenEndpoint, workComputer } from "./screens";
import { ensureScreenTools, startSession, stopSession } from "./sessions";
import { addMessage, bot, getState, id, ownerName, patchSession, session, update } from "./store";
import { recordTokens } from "./usage";
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
 */

/** How often each watched page is checked for changes (a cheap read over the tailnet, no model). */
const LOOK_MS = 15_000;
/** Jev reads a changed page at most this often per screen. */
const READ_MS = 30_000;
/** How sure Jev must be that something is waiting before Bops interrupts the user. */
const SURE = 0.7;

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
  const b = bot(botId);
  const endpoint = b && screenEndpoint(b, display);
  const page = endpoint ? await pageLines(endpoint).catch(() => null) : null;
  if (!page?.url) return siteOf("");
  const usual = siteOf(page.url, page.title);
  if (knownSite(page.url)) return usual;
  const hit = suggested.get(page.url);
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
    });
    // A suggestion in the app, counted with chat (the ledger has no kind of its own for it).
    recordTokens("chat", res.model, res.usage, botId);
    const s = JSON.parse(res.output_text) as Suggestion;
    const clean: Suggestion = { site: s.site.trim().slice(0, 40) || usual.site, lookFor: s.lookFor.trim().slice(0, 200) || usual.lookFor, picks: s.picks.map((p) => p.trim()).filter(Boolean).slice(0, 4) };
    if (!clean.picks.length) return usual;
    suggested.set(page.url, { at: Date.now(), s: clean });
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
  const existing = watches().find((w) => !w.mac && sameComputer(w.botId, botId) && w.display === display);
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
  void look(w.id);
  return w;
}

/**
 * Write the watched screens of the computer this bot works on (/root/.bops/watches.json) for its screen
 * tools to read: every bot's that works on it, since one file covers the whole computer.
 */
async function syncWatchFile(botId: string) {
  const b = bot(botId);
  const computerId = b && workComputer(b).computerId;
  if (getState().host !== "orgo" || !computerId) return;
  const map = Object.fromEntries(watches().filter((w) => sameComputer(w.botId, botId) && !w.mac).map((w) => [screenNo(w.display), { site: w.site, lookFor: w.lookFor }]));
  const body = Buffer.from(JSON.stringify(map)).toString("base64");
  await orgo.bash(computerId, `mkdir -p /root/.bops && echo ${body} | base64 -d > /root/.bops/watches.json`, 15).catch(() => {});
}

export async function stopWatch(watchId: string) {
  const w = watchById(watchId);
  if (!w) return;
  update((state) => (state.watches = state.watches?.filter((x) => x.id !== watchId)));
  const b = bot(w.botId);
  if (w.mac) return;
  const computerId = b && workComputer(b).computerId;
  if (getState().host === "orgo" && computerId) await orgo.bash(computerId, `bops-screens release watch:${w.id}`, 15).catch(() => {});
  void syncWatchFile(w.botId);
}

/** Change what a watched screen is watched for. */
export function editWatch(watchId: string, lookFor: string) {
  if (lookFor.trim()) patchWatch(watchId, { lookFor: lookFor.trim().slice(0, 300) });
  const w = watchById(watchId);
  if (w) void syncWatchFile(w.botId);
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
  const what = w.alert?.text ?? [w.told ?? []].flat().at(-1) ?? "the newest thing waiting for me";
  patchWatch(watchId, { alert: undefined });
  // A window on the Mac: the bot drafts it there, through Codex, and stops before sending.
  if (w.mac)
    return startSession({
      botId: w.botId,
      goal: `On my Mac in ${w.mac.app}, open the conversation "${w.mac.title}" and check that its name shows at the top before you type anything there. Find this: "${what}". Write a short, friendly reply in my voice in its message box, then stop. Don't send it: I'll read it and send it myself.`,
      title: `Reply in ${w.mac.title}`,
      where: "mac",
    });
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

/** Check one watched screen: if its page changed, have Jev read it. */
async function look(watchId: string) {
  const w = watchById(watchId);
  const b = w && bot(w.botId);
  if (!w || !b || looking.has(watchId) || (!w.mac && busy(w.botId, w.display))) return;
  const endpoint = w.mac ? null : screenEndpoint(b, w.display);
  if (!w.mac && !endpoint) return;
  looking.add(watchId);
  try {
    const page = w.mac ? await macPage(w).catch(() => null) : await pageLines(endpoint!).catch(() => null);
    if (!page?.url) return;
    const fingerprint = `${page.url}|${page.title}|${page.lines.join("\n")}`;
    if (fingerprint === lastSeen.get(watchId)) return;
    if (Date.now() - (lastRead.get(watchId) ?? 0) < READ_MS) return; // a later look picks it up
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
            `${owner} is watching \`watching\` and told their bot exactly what to tell them about: \`look_for\`. That is the only test. Does \`page\` now show something new since \`before\` that matches \`look_for\` as ${owner} worded it, about \`watching\`? Something new or unread that doesn't match \`look_for\` does not count, however new it is. Lines starting "Me:" are messages ${owner} sent (never news to ${owner}); "Them:" lines are from the other person.`,
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
    );
    if (!a) return;
    const now = watchById(watchId);
    if (!now) return;
    patchWatch(watchId, { readAt: Date.now() });
    // Showing something else right now: say so, and judge nothing until the watched thing is back.
    const onTarget = yes(a.on_target) ?? 1;
    if (onTarget < 0.5) {
      if (!now.away) patchWatch(watchId, { away: true });
      return;
    }
    // A watch tells the user what's new: the first look (after setting up, a restart, or coming back
    // from Paused) only takes in how things are now; changes from then on are what count.
    lastLines.set(watchId, lines);
    if (now.away || !before) {
      if (now.away) patchWatch(watchId, { away: false });
      return;
    }
    const waiting = yes(a.waiting) ?? 0;
    // Read or answered since: the badge goes away by itself.
    if (waiting < 0.3) {
      if (now.alert) patchWatch(watchId, { alert: undefined });
      return;
    }
    if (waiting < SURE) return;
    const pick = chose(a.item);
    const line = pick && pick.choice !== "none" && pick.confidence >= 0.3 ? lines[Number(pick.choice.slice(1))] : undefined;
    const text = (line ?? page.title).replace(/^(Me|Them): /, "").replace(/^[•·*\-\s]+/, "").slice(0, 120);
    // (Watches from before kept only the last one, as a string.)
    const told: string[] = Array.isArray(now.told) ? now.told : now.told ? [now.told] : [];
    if (told.includes(text)) return;
    const where = now.mac ? `in ${now.mac.title} on your Mac` : `on ${now.site}`;
    // How much of the user's attention it gets: interrupt now, just show it, or hold it for later.
    const level = await urgency({ kind: "watch", what: now.mac ? `"${now.mac.title}" in ${now.mac.app} on ${owner}'s Mac` : now.site, news: text, lookFor: now.lookFor });
    patchWatch(watchId, { alert: { text, at: Date.now(), level }, told: [...told, text].slice(-30) });
    if (level === "later") holdForLater({ botId: now.botId, text: `${now.mac?.title ?? now.site}: “${text}”`, watchId });
    else addMessage({ chatId: botChatId(now.botId), role: "bot", botId: now.botId, text: `Heads up, something new ${where}: “${text}”`, watch: { id: watchId } });
  } catch (e) {
    console.warn(`[watch] ${watchId}: ${(e as Error).message}`);
  } finally {
    looking.delete(watchId);
  }
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
  for (const w of getState().watches ?? []) void g.__bopsLook?.(w.id);
}, LOOK_MS);

/** Names compare loosely: case, emoji and punctuation aside ("jordan" finds "Jordan 🌵✨"). */
const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The user asked a bot in chat to watch something; set it up like the Watch button would. On their Mac:
 * the window of that app whose title matches (a Messages window shows one conversation, so it has to
 * be the one showing). On the bot's computer: a screen already on that site, else a free one opened
 * to it. When it can't tell or can't see it, `reply` says what the user needs to do (the bot passes it on).
 */
export async function watchFromChat(
  botId: string,
  a: { where: "mac" | "computer"; app?: string; window?: string; url?: string; look_for?: string },
): Promise<{ watch: Watch; already?: boolean } | { reply: string }> {
  if (a.where === "mac") {
    const owner = ownerName();
    const app = loose(a.app ?? "");
    if (!app) return { reply: "Which app on the Mac (Messages, Mail, Slack…)?" };
    // Already watched (maybe paused while the app shows something else): keep it, with what the user said now.
    const want0 = loose(a.window ?? "");
    const had = watches().find((w) => w.mac && loose(w.mac.app).includes(app) && (!want0 || loose(w.mac.title).includes(want0) || want0.includes(loose(w.mac.title))));
    if (had) {
      if (a.look_for?.trim() && a.look_for.trim() !== had.lookFor) editWatch(had.id, a.look_for);
      return { watch: watchById(had.id) ?? had, already: true };
    }
    const wins = (await listWindows()).filter((w) => loose(w.app).includes(app) || app.includes(loose(w.app)));
    if (!wins.length) return { reply: `${a.app} isn't open on ${owner}'s Mac. Ask ${owner} to open it (and the conversation or mailbox to watch), then try again.` };
    const want = loose(a.window ?? "");
    const hits = want ? wins.filter((w) => loose(w.title).includes(want) || want.includes(loose(w.title))) : wins;
    if (!hits.length) return { reply: `${wins[0].app} is showing ${wins.map((w) => `"${w.title}"`).join(", ")}, not ${a.window}. Ask ${owner} to open it there, then try again.` };
    if (hits.length > 1) return { reply: `More than one ${wins[0].app} window matches: ${hits.map((w) => `"${w.title}"`).join(", ")}. Ask ${owner} which one.` };
    return { watch: await startMacWatch(hits[0].app, hits[0].windowId, hits[0].title, a.look_for) };
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
  const watchedBy = (d: number, other = false) => watches().some((w) => !w.mac && sameComputer(w.botId, botId) && (!other || w.botId !== botId) && w.display === d);
  const taken = (d: number) => busy(botId, d) || watchedBy(d);
  // A screen already on that site, then a free one (an empty one first).
  const on = pages.find((p) => p.page && host(p.page.url) === host(url) && !busy(botId, p.d) && !watchedBy(p.d, true));
  if (on) return { watch: await startWatch(botId, on.d, a.look_for) };
  const free = pages.filter((p) => p.ep && !taken(p.d)).sort((x, y) => Number(!!y.page?.url.startsWith("chrome://")) - Number(!!x.page?.url.startsWith("chrome://")))[0];
  if (!free?.ep) return { reply: `All of ${b.name}'s screens are busy right now.` };
  await navigate(free.ep, url);
  // The page has to load before the watch can read what it's on.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 750));
    const p = await currentPage(free.ep).catch(() => null);
    if (p && host(p.url) === host(url) && p.title) break;
  }
  return { watch: await startWatch(botId, free.d, a.look_for) };
}

/** The watches a bot can see and change from chat (ids, what, for what), for its instructions. */
export function watchesNote(botIds: string[], withMac: boolean) {
  const mine = watches().filter((w) => (w.mac ? withMac : botIds.includes(w.botId)));
  if (!mine.length) return "";
  const owner = ownerName();
  return [
    `Watches (screens and Mac windows Bops keeps an eye on for ${owner}; stop_watch takes the id):`,
    ...mine.map((w) => `- ${w.id}: ${w.mac ? `"${w.mac.title}" in ${w.mac.app} on ${owner}'s Mac` : `${w.site} on ${bot(w.botId)?.name}'s screen ${screenNo(w.display)}`} · looking for ${w.lookFor}${w.away ? " · paused (not showing right now)" : ""}`),
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
          `${owner} told an AI agent that's working on a screen what's in \`owner_said\`. Are they asking it to keep watching the screen over time and tell them when something happens or changes (a price crossing a number, a new message, a status changing), rather than to do something now?`,
        criteria: { true: "Keep watching over time and tell them when it happens", false: "Do something now, or anything else" },
      },
    },
  );
  if ((yes(a?.ongoing) ?? 0) < 0.7) return null;
  // What to watch for, short and in their words ("Bitcoin goes above $86,000").
  const res = await client.responses
    .create({
      model: SUGGEST_MODEL,
      reasoning: { effort: "low" },
      instructions: `${owner} asked for a screen to be watched. Write what to watch for as one short phrase in their words, like "Bitcoin goes above $86,000" or "a reply from Dana". Just the phrase.`,
      input: `Screen: ${s.title}. ${owner}: ${text.slice(0, 1500)}`,
    })
    .catch(() => null);
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
