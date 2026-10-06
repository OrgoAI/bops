import "server-only";
import { workBot, type Bot } from "@/lib/types";
import { cdpPort } from "./local";
import { bot, getState } from "./store";

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
