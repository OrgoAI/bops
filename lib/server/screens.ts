import "server-only";
import { DISPLAYS, workBot, type Bot } from "@/lib/types";
import { cdpPort, currentPage, type Endpoint } from "./local";
import { orgo, screenId, type OrgoScreen } from "./orgo";
import { bot, getState } from "./store";

/**
 * Each computer's screens and their sizes, as Orgo lists them, kept a minute: a click shouldn't wait on
 * another call to Orgo first. `fresh`: read again now (a screen made since isn't in the kept list).
 */
const listed = new Map<string, { at: number; screens: Promise<OrgoScreen[]> }>();
/** The last list Orgo gave for each computer, whatever its age. */
const lastListed = new Map<string, OrgoScreen[]>();
export function screensOf(computerId: string, fresh = false) {
  const known = listed.get(computerId);
  if (known && !fresh && Date.now() - known.at < 60_000) return known.screens;
  const screens = orgo.screens(computerId);
  listed.set(computerId, { at: Date.now(), screens });
  screens.then(
    (s) => void lastListed.set(computerId, s),
    () => listed.get(computerId)?.screens === screens && listed.delete(computerId),
  );
  return screens;
}

/** Forget a computer's screens: it's gone (see healIfGone in sessions.ts). */
export function forgetScreens(computerId: string) {
  listed.delete(computerId);
  lastListed.delete(computerId);
}

/**
 * The id Orgo gave the screen on `display`, from the last list the app read (screensOf: /api/vnc reads
 * it before a stream, clicks before they're sent), else the one the computer names it by: screen-<display>.
 * Never asks Orgo.
 */
export const listedScreenId = (computerId: string, display: number) =>
  lastListed.get(computerId)?.find((s) => s.display === `:${display}`)?.id ?? screenId(display);

/**
 * The bot whose computer this bot works on (see workBot): itself, or its main bot when it shares.
 * On this Mac every bot has its own browsers, so nothing is shared there.
 */
export function workComputer(b: Bot): Bot {
  const state = getState();
  return state.host === "mac" ? b : workBot(b, state.bots);
}

/**
 * Whether two bots work on the same computer, so share its four screens: a screen either one is
 * using (a thread, a helper, a watch, the user driving it) is taken for both.
 */
export function sameComputer(a: string, b: string) {
  if (a === b) return true;
  const x = bot(a);
  const y = bot(b);
  return !!x && !!y && workComputer(x).id === workComputer(y).id;
}

/**
 * Where a bot screen's Chrome can be reached for the mirror, page reads and precise input:
 * this Mac's own screens on 127.0.0.1, or an Orgo computer's over the tailnet (its screens run
 * Chrome with DevTools on 9200 + display). Null when there's no direct path, e.g. an Orgo
 * computer that hasn't joined the tailnet; then the app falls back to Orgo's screenshots.
 */
export function screenEndpoint(b: Bot, display: number): string | null {
  const state = getState();
  if (state.host === "mac") return `127.0.0.1:${cdpPort(state.bots.findIndex((x) => x.id === b.id), display)}`;
  const c = workComputer(b);
  return c.tailnet ? `${c.tailnet.ip}:${9200 + display}` : null;
}

/** The page open in a Chrome, by address and title, or null when it doesn't answer within 1.5 s. */
export const pageAt = (ep: Endpoint) => Promise.race([currentPage(ep).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);

/** What's open on each of a bot's screens, read from its browser (quick; null where Bops can't reach it). */
export function screenPages(b: Bot, displays: readonly number[] = DISPLAYS) {
  return Promise.all(
    displays.map((d) => {
      const ep = screenEndpoint(b, d);
      return ep ? pageAt(ep) : null;
    }),
  );
}
