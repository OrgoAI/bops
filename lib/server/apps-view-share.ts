import "server-only";
import { APPS_VIEW_PATH, BOPS_USER_HEADER, type AppsViewPost } from "@/cloud/protocol";
import type { AppView, HostedApp } from "@/lib/hosted-apps";
import { appViewOf, DEPLOYING_MS } from "./apps-for-members";
import { cloudFetch, cloudOn } from "./cloud";
import { onRunner } from "./persist";
import { stateUser } from "./store";

/*
 * What members see of an app, told by the app's own computer (cloud/apps-view.ts, POST APPS_VIEW_PATH), so Your Apps stays
 * fresh with the owner's Mac shut. Only on a computer's runner, and only of the apps whose home is its computer
 * (hosted-apps.ts appsViewHere; Bops Cloud holds a post to the same rule, computer-scope.ts appHomeHere): each as
 * apps-for-members.ts appViewOf reads it for members, never with a Preview password (a computer can't read one back,
 * and Bops Cloud keeps the ones it set) nor members' acts (Bops Cloud keeps those), with the workspace's domains this
 * computer may point at its apps (`owned`). Bops Cloud keeps it beside the owner's state (bops.app_views), so a share
 * never changes the state here or there.
 *
 * Shared after each job a member asked of this computer (runner-chat.ts), after a bot's own deploy here (hosted-apps.ts
 * deployForBot), and when Bops Cloud asks for it (the runner stream's "apps-view": a member is looking, and what it has
 * is old). One at a time per workspace: what's asked meanwhile goes in the next. A post Bops Cloud doesn't answer (or
 * answers 5xx, 429, or a 401 once) is sent again, TRIES in all. While a site's newest deploy is queued or running it's
 * shared again every DEPLOYING_MS, for DEPLOYING_FOR_MS at most, so members see it land. Never throws, never logs a view.
 */

/** How many times one share is sent, and the waits between. */
const TRIES = 3;
const RETRY_MS = [2_000, 8_000];
/** How long a deploy on its way keeps its app's view shared again (from when it was first seen on its way). */
export const DEPLOYING_FOR_MS = 15 * 60_000;

type Read = (wsId: string, names?: readonly string[]) => Promise<{ apps: HostedApp[]; owned: { id: string; domain: string }[] | null }>;
type Box = {
  /** What's asked of each workspace that isn't being read yet ("all": every app here), and the share going now. */
  pending: Map<string, Set<string> | "all">;
  running: Map<string, Promise<void>>;
  /** A share again while a deploy is on its way: its timer, and since when. */
  again: Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>;
  /** Tests: what reads this computer's apps (hosted-apps.ts appsViewHere), sends a post (its status, 0: no answer, null: nowhere to send), and the waits. */
  read?: Read;
  send?: (body: AppsViewPost, user: string | null) => Promise<number | null>;
  retryMs?: number[];
  deployingMs?: number;
  user?: () => string | null;
  runner?: () => boolean;
};
const g = globalThis as unknown as { __bopsAppsViewShare?: Box };
const box: Box = (g.__bopsAppsViewShare ??= { pending: new Map(), running: new Map(), again: new Map() });

const realRead: Read = async (wsId, names) => (await import("./hosted-apps")).appsViewHere(wsId, names);

/** The readers appViewOf takes, as the Apps page's own (hosted-apps.ts): never a password's (a runner's view has none). */
async function readers() {
  const h = await import("./hosted-apps");
  return {
    commits: (ws: string, name: string) => h.appCommits(ws, name, null),
    settings: (ws: string, name: string, site?: string, env?: "preview") => h.appSettings(ws, name, site, env),
    password: () => Promise.reject(new Error("A computer's view has no Preview password.")),
  };
}

/** One view as Bops Cloud takes it (lib/hosted-apps.ts AppView): no Preview password, whatever was read. */
const viewOf = (v: Awaited<ReturnType<typeof appViewOf>>, owned: AppView["owned"] | null): AppView => {
  const { acts: _acts, sites, ...rest } = v;
  void _acts;
  return { ...rest, sites: sites.map(({ previewPassword: _p, ...s }) => (void _p, s)), ...(owned ? { owned } : {}) };
};

/** Whether a site's newest deploy (Published's or its Preview's) is on its way. */
const going = (v: AppView) => v.sites.some((s) => [s.live?.state, s.previewLive?.state].some((x) => x === "queued" || x === "running"));

async function sendOne(body: AppsViewPost, user: string | null): Promise<number | null> {
  if (box.send) return box.send(body, user);
  if (!cloudOn() || !user) return null;
  try {
    const res = await cloudFetch(APPS_VIEW_PATH, { method: "POST", headers: { "content-type": "application/json", [BOPS_USER_HEADER]: user }, body: JSON.stringify(body) });
    void res.body?.cancel().catch(() => {});
    return res.status;
  } catch {
    return 0;
  }
}

/** A post sent until Bops Cloud takes it or turns it down, TRIES at most: whether it took it. */
async function post(body: AppsViewPost): Promise<boolean> {
  const user = box.user ? box.user() : stateUser();
  let denied = 0;
  for (let i = 0; i < TRIES; i++) {
    const status = await sendOne(body, user).catch(() => 0);
    if (status === null) return false;
    if (status >= 200 && status < 300) return true;
    const again = status === 0 || status >= 500 || status === 429 || (status === 401 && denied++ === 0);
    if (!again) {
      console.warn(`[apps-view] Bops Cloud didn't take the view of ${Object.keys(body.apps).length} apps of ${body.ws} (${status})`);
      return false;
    }
    if (i < TRIES - 1) await new Promise((r) => setTimeout(r, (box.retryMs ?? RETRY_MS)[i] ?? 8_000));
  }
  return false;
}

/** One share of what's asked of `wsId` (`names`, or every app here), and another later while a deploy is on its way. */
async function shareNow(wsId: string, names: Set<string> | "all") {
  const read = await (box.read ?? realRead)(wsId, names === "all" ? undefined : [...names]).catch(() => null);
  if (!read?.apps.length) return;
  const r = await readers();
  const readAt = Date.now();
  const apps: Record<string, AppView> = {};
  for (const a of read.apps) {
    const v = await appViewOf(wsId, a, r, { passwords: false, readAt }).catch(() => null);
    if (v) apps[a.name] = viewOf(v, read.owned);
  }
  if (!Object.keys(apps).length) return;
  await post({ ws: wsId, apps });
  const on = Object.entries(apps).filter(([, v]) => going(v)).map(([n]) => n);
  const was = box.again.get(wsId);
  if (was) clearTimeout(was.timer);
  if (!on.length) return void box.again.delete(wsId);
  const since = was?.since ?? Date.now();
  if (Date.now() - since >= DEPLOYING_FOR_MS) return void box.again.delete(wsId);
  const timer = setTimeout(() => void shareAppsView(wsId, on), box.deployingMs ?? DEPLOYING_MS);
  timer.unref?.();
  box.again.set(wsId, { timer, since });
}

/**
 * Tell Bops Cloud what members see of these apps of `wsId` (none: every app whose home is this computer), after any
 * share of the workspace still going. Only on a computer's runner. Best effort, never throws.
 */
export function shareAppsView(wsId: string, names?: readonly string[]): Promise<void> {
  if (!(box.runner ? box.runner() : onRunner()) || typeof wsId !== "string" || !wsId) return Promise.resolve();
  const was = box.pending.get(wsId);
  const all = !names || was === "all";
  box.pending.set(wsId, all ? "all" : new Set([...(was ?? []), ...names.filter((n) => typeof n === "string")]));
  const running = box.running.get(wsId);
  if (running) return running;
  const p = (async () => {
    try {
      for (let next = box.pending.get(wsId); next; next = box.pending.get(wsId)) {
        box.pending.delete(wsId);
        await shareNow(wsId, next).catch((e: Error) => console.warn(`[apps-view] ${wsId}: ${e?.message ?? e}`));
      }
    } finally {
      box.running.delete(wsId);
    }
  })();
  box.running.set(wsId, p);
  return p;
}

/** For tests: what reads, what sends, the waits and whose state is here (unset: the real ones); every share forgotten. */
export function appsViewShareForTests(o: { read?: Read; send?: Box["send"]; retryMs?: number[]; deployingMs?: number; user?: () => string | null; runner?: () => boolean } = {}) {
  box.read = o.read;
  box.send = o.send;
  box.retryMs = o.retryMs;
  box.deployingMs = o.deployingMs;
  box.user = o.user;
  box.runner = o.runner;
  for (const a of box.again.values()) clearTimeout(a.timer);
  box.again.clear();
  box.pending.clear();
}
