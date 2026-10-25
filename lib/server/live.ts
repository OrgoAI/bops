import "server-only";
import { BOPS_DEVICE_HEADER } from "@/cloud/protocol";
import { workspaceOf, type AppState } from "@/lib/types";
import { appHeaders } from "./app-version";
import { callBot, watchCalls } from "./attention";
import { cloudOn, cloudUrl } from "./cloud";
import { LivePublisher, LiveSubscriber, RemoteMoods, localMoods, localSessions, onLiveRoutine, type RemoteMood } from "./live-core";
import { orgoKey } from "./orgo-auth";
import { loopHere, onExit } from "./persist";
import { deviceIdFor } from "./persist-cloud";
import { bot, getState, pullState, stateReady, stateUser, touchState, watchChanges } from "./store";

/**
 * Live on this Mac (cloud/README.md "Live"; the parts without the server are live-core.ts). While the
 * app works through Bops Cloud and someone's signed in:
 *
 * - What this Mac's bots are doing (typing in a chat, a thread this Mac runs, the call the user is on)
 *   goes to POST /v1/live when it changes, and again every 5 seconds while it holds; so do the threads
 *   it runs, the routines it changes and runs, and its calls. All of it in the background, never waited on.
 * - One stream (GET /v1/live) for the workspace the user is in: another device's change to it reads the
 *   state now, instead of at the next 30 second look (persist-cloud.ts), and its bots' moods go to the
 *   window (forApp's liveMoods), so a bot at work on another Mac opens its eyes here too.
 *
 * A sign-out, another account's sign-in, or the app quitting closes the stream and says this Mac's bots
 * are idle. With the stream down, nothing else changes: the state is read every 30 seconds as before.
 * A computer's runner has none of it (persist.ts MAC_LOOPS; Bops Cloud refuses it /v1/live): what its
 * routines do reaches this Mac as the "state" event its state writes send.
 */

/** How often what this Mac's bots are doing is looked at again, besides after every change (a thread's run can end without one). */
const LOOK_MS = 2_000;

type Live = { user: string; key: string; device: string; publisher: LivePublisher; subscriber: LiveSubscriber; moods: RemoteMoods; look?: ReturnType<typeof setTimeout>; tick: ReturnType<typeof setInterval> };
const g = globalThis as unknown as { bopsLive?: Live | null; bopsLiveRuns?: () => ReadonlySet<string> };

const none: ReadonlySet<string> = new Set();
/** The threads this server runs (sessions.ts), loaded once it's needed: sessions.ts is large, and it isn't this module's to load first. */
async function runs(): Promise<ReadonlySet<string>> {
  if (!g.bopsLiveRuns) g.bopsLiveRuns = (await import("./sessions")).runsHere;
  return g.bopsLiveRuns?.() ?? none;
}

const workspaceNow = () => getState().workspace ?? getState().workspaces?.[0]?.id ?? "ws_main";

/** Look at what this Mac's bots are doing, shortly (changes close together are one look). */
function lookSoon() {
  const live = g.bopsLive;
  if (!live || live.look) return;
  live.look = setTimeout(() => {
    live.look = undefined;
    if (g.bopsLive !== live || !stateReady() || stateUser() !== live.user) return;
    void runs()
      .then((here) => {
        const state = getState();
        live.publisher.update(localMoods(state, { runs: here, callBot: callBot() }), localSessions(state, here));
      })
      .catch(() => {});
  }, 100);
  live.look.unref?.();
}

/** After every change to the state: the stream follows the workspace the user is in, and this Mac's bots are looked at. */
function changed() {
  const live = g.bopsLive;
  if (!live || stateUser() !== live.user) return;
  live.subscriber.start(workspaceNow());
  lookSoon();
}

/**
 * Live running whenever it should: the app on Bops Cloud and the signed-in user's state loaded. Cheap
 * when it already is (cloud-tunnel.ts calls it on every poll of the state); another user or key starts it over.
 */
export function ensureLive() {
  if (!cloudOn() || !stateReady() || !loopHere("live")) return;
  const user = stateUser();
  const key = orgoKey();
  if (!user || !key) return;
  const was = g.bopsLive;
  if (was && was.user === user && was.key === key) return;
  if (was) void stopLive();
  const device = deviceIdFor(user);
  const headers = () => ({ Authorization: `Bearer ${key}`, [BOPS_DEVICE_HEADER]: device, ...appHeaders() });
  const moods = new RemoteMoods(() => touchState());
  const publisher = new LivePublisher(async (ws, events) => {
    const res = await fetch(`${cloudUrl()}/v1/live`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ ws, events }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    void res?.body?.cancel().catch(() => {});
    return res?.status ?? 0;
  });
  const subscriber = new LiveSubscriber({
    fetch,
    url: (ws) => `${cloudUrl()}/v1/live?ws=${encodeURIComponent(ws)}`,
    // Signed out, or someone else signed in since: no more connecting on this key.
    headers: () => (stateUser() === user && orgoKey() === key ? headers() : null),
    self: () => device,
    pull: () => void pullState(),
    moods,
  });
  const tick = setInterval(lookSoon, LOOK_MS);
  tick.unref?.();
  const live: Live = { user, key, device, publisher, subscriber, moods, tick };
  g.bopsLive = live;
  watchChanges("live", changed);
  watchCalls((botId, on) => {
    if (g.bopsLive !== live) return;
    live.publisher.call(workspaceOf(bot(botId)), botId, on);
    lookSoon();
  });
  onLiveRoutine((ws, routineId, change) => g.bopsLive === live && live.publisher.routine(ws, routineId, change));
  subscriber.start(workspaceNow());
  lookSoon();
}

/** Stop Live (a sign-out, the app quitting): the stream closes, and this Mac's busy bots are said idle (2 seconds at most). */
export async function stopLive() {
  const live = g.bopsLive;
  if (!live) return;
  g.bopsLive = null;
  onLiveRoutine(null);
  clearInterval(live.tick);
  if (live.look) clearTimeout(live.look);
  live.subscriber.stop();
  touchState();
  await Promise.race([live.publisher.stop(), new Promise((r) => setTimeout(r, 2000).unref?.())]);
}

/** The tunnel just read the state for a change another device made: the stream's read for the same write isn't needed. */
export const livePulled = () => g.bopsLive?.subscriber.pulled();

/**
 * What the window gets of the user's bots' moods on their other devices (app/api/state forApp), by bot
 * id: only bots this state has. Undefined when there are none. Never saved or synced.
 */
export function liveMoodsForApp(state: AppState): Record<string, RemoteMood> | undefined {
  const all = g.bopsLive?.moods.forApp();
  if (!all) return undefined;
  const out = Object.fromEntries(Object.entries(all).filter(([id]) => state.bots.some((b) => b.id === id)));
  return Object.keys(out).length ? out : undefined;
}

// On the way out, the stream closes and this Mac's bots are said idle.
onExit("live", () => stopLive());
