import "server-only";
import { BOPS_DEVICE_HEADER } from "@/cloud/protocol";
import { handedBack, startRelay, type Relay } from "@/lib/browser-relay";
import { botChatId, DISPLAYS, live } from "@/lib/types";
import { appHeaders } from "./app-version";
import { cloudUrl } from "./cloud-url";
import { cloudKey } from "./orgo-auth";
import { loopHere, onRunner } from "./persist";
import { sameComputer } from "./screens";
import { addMessage, getState, stateDevice } from "./store";

/**
 * The bot's browser on a computer's runner (the "browser" loop: persist.ts RUNNER_LOOPS): the relay (lib/browser-relay.ts)
 * on this computer's Chrome, one per screen (DevTools on 127.0.0.1, 9200 + display, as vm/bin/bops-chrome starts it),
 * signed in to Bops Cloud as this computer, the same credential its other calls go on (cloudKey).
 *
 * Someone taking over a screen from the tab is the owner's takeover here (sessions.ts takeOver): the thread on that
 * screen pauses, nothing new starts there, the other Bops hear it's driven (AppState.driving), and handing it back
 * (returnControl) carries the paused thread on, or the one that ended there waiting on someone to sign in, and the
 * bot's chat says who handed back. What a bot is doing with a screen's browser (a live thread on it: browsing) is said
 * as it changes (relay.activity), so a Watch chip shows before anyone watches. The Mac never runs this: a Mac's bots'
 * browsers are on that Mac.
 */

const g = globalThis as unknown as { bopsBrowserRelay?: Relay };

/** The screen of this computer `botId`'s task holds now (bots that share a computer share its screens), else the one it used last, else null. */
export function screenFor(botId: string): number | null {
  const mine = getState().sessions.filter((s) => sameComputer(s.botId, botId) && s.runsOn !== "mac");
  const now = mine.find((s) => live(s) && s.display !== undefined)?.display;
  if (now !== undefined) return now;
  const last = mine.filter((s) => s.lastDisplay !== undefined).sort((a, b) => (b.endedAt ?? b.startedAt ?? b.createdAt) - (a.endedAt ?? a.startedAt ?? a.createdAt))[0];
  return last?.lastDisplay ?? null;
}

export function startBrowserRelay() {
  if (!onRunner() || !loopHere("browser") || g.bopsBrowserRelay) return;
  g.bopsBrowserRelay = startRelay({
    url: cloudUrl,
    headers: () => {
      const key = cloudKey();
      const device = stateDevice();
      return key && device ? { Authorization: `Bearer ${key}`, [BOPS_DEVICE_HEADER]: device, ...appHeaders() } : null;
    },
    screens: () => DISPLAYS.map((display) => ({ display, port: 9200 + display })),
    screenFor,
    // The threads' module, only when someone takes over (a runner starts it with its first thread, not here).
    onControl: (botId, display, who, was) =>
      void import("./sessions")
        .then(({ takeOver, returnControl }) => {
          const t = getState().takeover;
          if (who) return takeOver(botId, display, undefined, who.name);
          // Handed back: only the takeover of that screen, never another.
          if (t && t.display === display && sameComputer(t.botId, botId)) returnControl();
          if (was) addMessage({ chatId: botChatId(botId), role: "system", text: handedBack(was.name, getState().bots.find((b) => b.id === botId)?.name ?? "The bot") });
        })
        .catch((e: Error) => console.warn(`[browser] ${who ? "take over" : "hand back"}: ${e.message}`)),
    log: (m) => console.log(`[browser] ${m}`),
  });
  // Each screen's browser: browsing while a thread of this computer's runs on it, else idle (for the bot that used it
  // last), and waiting while someone's take over holds a thread of it.
  const last = new Map<number, string>();
  setInterval(() => {
    const relay = g.bopsBrowserRelay;
    if (!relay) return;
    const { sessions, takeover } = getState();
    for (const d of DISPLAYS) {
      const on = sessions.find((s) => s.display === d && live(s) && s.runsOn !== "mac");
      const bot = on?.botId ?? last.get(d);
      if (!bot) continue;
      last.set(d, bot);
      // Someone took this screen over with a thread of it paused (or waiting) there: Hand back carries it on.
      const waiting = takeover?.display === d && !!takeover.sessionId && sameComputer(takeover.botId, bot);
      relay.activity(d, bot, { step: on ? "browsing" : "idle", waiting });
    }
  }, 1_000).unref?.();
}

/** The relay here, for the bot's own steps to wait on (whenFree). */
export const browserRelay = () => g.bopsBrowserRelay ?? null;
