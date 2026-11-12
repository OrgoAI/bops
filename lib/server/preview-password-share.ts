import "server-only";
import { BOPS_USER_HEADER, PREVIEW_PASSWORD_PATH, type PreviewPasswordPost } from "@/cloud/protocol";
import { cloudFetch, cloudOn } from "./cloud";
import { stateUser } from "./store";

/*
 * Whoever sets a site's Preview password shares it (cloud/preview-passwords.ts). Each time Bops sets one on Orgo
 * (hosted-apps.ts passwordNow and changePreviewPassword, on the owner's Mac or on the app's own computer's runner), it
 * tells Bops Cloud the very password it sent there, or null once the owner turned it off, and Bops Cloud keeps it for
 * the people with Your Apps at Write (Workspace.previewPasswords). A runner signs in as its computer, which may set a
 * Preview's password on Orgo but never read one back: this is how what it set reaches anyone, the owner's Mac on or not.
 *
 * Bops Cloud shows its copy over the owner's Mac's, so a share that never gets there would leave an old password shown.
 * So each site keeps its newest post until Bops Cloud takes it, sent again while Bops Cloud doesn't answer (or answers
 * 5xx, or 403: an app this Bops just gave a first home, or a Preview it just made, may not be in the state Bops Cloud has
 * yet, as its next save takes a few seconds), after RETRY_MS, for about 20 minutes in all; a 401 once more (a runner's
 * identity token turned down: cloud.ts cloudFetch has it take its next credential). Posts for one site go one at a time,
 * and a newer one takes the place of an older one not sent yet, so an older one never lands after a newer one from here.
 * Any other refusal (a body it can't take, another account's state: 409) isn't sent again. As the owner's Mac's own
 * check (apps-for-members.ts) tells Bops Cloud what Orgo has where a share was missed anyway, its post (`seen`) never
 * takes the place of a share still going here, which is at least as new.
 *
 * Each post is for the account whose state it was set in (stateUser when it's shared, sent as BOPS_USER_HEADER, so Bops
 * Cloud refuses it on another account's sign in), and is dropped once another account's state is here. Nothing is sent
 * without a Bops Cloud sign in (a self hosted Bops, a hosted server). The password is never logged, nor the body: a
 * failure is said by app, site and status alone.
 */

/** The waits between tries of a post Bops Cloud doesn't take yet: 10 tries over about 20 minutes. */
const RETRY_MS = [2_000, 8_000, 30_000, 60_000, 120_000, 240_000, 240_000, 240_000, 240_000];

/** A post waiting to go, for the account whose state it was set in, and what it settles. */
type Post = { body: PreviewPasswordPost; user: string | null; tries: number; denied: number; done: (took: boolean) => void };
/** One site's posts: the newest not taken yet, the one out to Bops Cloud now, whether they're being sent, and what wakes the wait between tries. */
type Site = { next?: Post; sending?: Post; going: boolean; wake?: () => void };

type Box = {
  /** Each site's posts, by "<user>\n<ws>/<app>/<site>". */
  sites: Map<string, Site>;
  /** Tests: what sends one (its answer's status, 0 when Bops Cloud didn't answer, null when there's nothing to send to), the waits between tries, and whose state is here. */
  send?: (body: PreviewPasswordPost, user: string | null) => Promise<number | null>;
  retryMs?: number[];
  user?: () => string | null;
};
const g = globalThis as unknown as { __bopsPreviewShare?: Box };
const box: Box = (g.__bopsPreviewShare ??= { sites: new Map() });

const userNow = () => (box.user ? box.user() : stateUser());

/** One post to Bops Cloud, signed in as this Mac's user or this runner's computer (cloud.ts cloudKey), for its account. */
async function sendOne(p: Post): Promise<number | null> {
  if (box.send) return box.send(p.body, p.user);
  if (!cloudOn() || !p.user) return null;
  try {
    const res = await cloudFetch(PREVIEW_PASSWORD_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", [BOPS_USER_HEADER]: p.user },
      body: JSON.stringify(p.body),
    });
    void res.body?.cancel().catch(() => {});
    return res.status;
  } catch {
    return 0;
  }
}

/** How Bops Cloud's answer goes: taken, sent again later, or not sent again. */
function outcome(status: number | null, p: Post): "took" | "again" | "never" {
  if (status === null) return "never";
  if (status >= 200 && status < 300) return "took";
  if (status === 0 || status >= 500 || status === 403 || status === 429) return "again";
  if (status === 401 && p.denied++ === 0) return "again";
  console.warn(`[preview-password] Bops Cloud didn't take ${p.body.app}/${p.body.site}'s Preview password (${status})`);
  return "never";
}

/** Wait `ms`, or less when a newer post for the site comes meanwhile. */
const pause = (site: Site, ms: number) =>
  new Promise<void>((done) => {
    const t = setTimeout(() => {
      site.wake = undefined;
      done();
    }, ms);
    t.unref?.();
    site.wake = () => {
      clearTimeout(t);
      site.wake = undefined;
      done();
    };
  });

/** Send a site's posts, the newest each time, until none is left. */
async function drain(key: string, site: Site) {
  site.going = true;
  try {
    while (site.next) {
      const p = site.next;
      // Another account's state is here now: not its to tell.
      if (userNow() !== p.user) {
        if (site.next === p) site.next = undefined;
        p.done(false);
        continue;
      }
      site.sending = p;
      const status = await sendOne(p).catch(() => 0);
      site.sending = undefined;
      const how = outcome(status, p);
      const replaced = site.next !== p;
      if (how !== "again" || replaced) {
        if (!replaced) site.next = undefined;
        p.done(how === "took");
        continue;
      }
      const waits = box.retryMs ?? RETRY_MS;
      if (p.tries >= waits.length) {
        console.warn(`[preview-password] couldn't tell Bops Cloud ${p.body.app}/${p.body.site}'s Preview password: ${p.tries + 1} tries, none taken`);
        site.next = undefined;
        p.done(false);
        continue;
      }
      await pause(site, waits[p.tries++]);
    }
  } finally {
    site.going = false;
    if (box.sites.get(key) === site && !site.next) box.sites.delete(key);
  }
}

/**
 * Tell Bops Cloud a site's Preview password just set (`password`: exactly what went to Orgo; null: none now), after any
 * post for the same site still going, in place of one still waiting. `seen`: the owner's Mac's check of Bops Cloud's
 * copy (apps-for-members.ts), dropped while one of this site's is going. Best effort, never throws: whether Bops Cloud
 * took it (false too for one a newer one took the place of).
 */
export function sharePreviewPassword(o: PreviewPasswordPost): Promise<boolean> {
  const body: PreviewPasswordPost = { ws: o.ws, app: o.app, site: o.site, url: o.url, password: o.password, ...(typeof o.seen === "number" ? { seen: o.seen } : {}) };
  const user = userNow();
  const key = `${user ?? ""}\n${o.ws}/${o.app}/${o.site}`;
  const had = box.sites.get(key);
  if (body.seen !== undefined && had && (had.going || had.next)) return Promise.resolve(false);
  const site: Site = had ?? { going: false };
  if (!had) box.sites.set(key, site);
  return new Promise<boolean>((done) => {
    const was = site.next;
    site.next = { body, user, tries: 0, denied: 0, done };
    // (One out to Bops Cloud now is settled by its answer.)
    if (was && was !== site.sending) was.done(false);
    site.wake?.();
    if (!site.going) void drain(key, site);
  });
}

/** Tests: what sends a post, the waits between tries, whose state is here, and every post under way, settled. */
export const previewShareForTests = {
  send: (fn?: Box["send"]) => void (box.send = fn),
  retryMs: (ms?: number[]) => void (box.retryMs = ms),
  user: (fn?: () => string | null) => void (box.user = fn),
  waits: () => [...RETRY_MS],
  settled: async () => {
    // (Held open meanwhile: the waits between tries don't keep a process up on their own.)
    const hold = setInterval(() => {}, 1_000);
    try {
      while (box.sites.size) await new Promise((r) => setTimeout(r, 2));
    } finally {
      clearInterval(hold);
    }
  },
};
