"use client";

import { changeRouteOf } from "@/cloud/change-routes";

/**
 * While a workspace shared with the user is open (AppState.shared, lib/shared.ts), nothing in the window
 * changes anything through the app's own routes: every call that would (anything but a GET) to the app's own
 * server is answered here with 403 and the read only line, without going out, wherever in the window it's made.
 * What a member with Write does there (chat, reply, answer, stop) goes only through /api/workspaces/shared, to
 * the owner's Bops by way of Bops Cloud (shared-act.ts), never a route that would act on the user's own bot of
 * that id. Only what leaves
 * or switches the workspace, signing in and out, notices, usage events, what's on screen and what's the
 * user's own (their vault, account and name) go through. Nor do the reads the server answers from the
 * user's own bots or workspaces by id (a shared bot's id is often one of theirs, "boppy"): their memory,
 * Knowledge's issues, files, screens. The buttons that would change something are hidden or say so too; this is what
 * holds whatever's missed. A screen's stream and its pictures (an EventSource, an image) never pass through fetch: what
 * opens them asks readAllowed first.
 */

/**
 * The calls that still go while it's open: the switcher (leaving, switching, its names, and an Admin's live screen of a
 * bot there, /api/workspaces/shared/screen, which takes the computer from the shared copy), signing in and out,
 * notices, usage events, what's on screen, the user's own vault, account and name, the shared bot's browser
 * (/api/browser: Bops Cloud decides who may watch it), and a file added for a shared bot (/api/bots/files: the same).
 */
const ALLOWED = [
  /^\/api\/workspaces(\/|\?|$)/,
  /^\/api\/auth\//,
  /^\/api\/notices(\/|\?|$)/,
  /^\/api\/analytics(\/|\?|$)/,
  /^\/api\/view(\?|$)/,
  /^\/api\/vault(\/|\?|$)/,
  /^\/api\/account(\/|\?|$)/,
  /^\/api\/owner(-email)?(\/|\?|$)/,
  // The bot's browser (bot-browser.tsx): asked of Bops Cloud for the shared workspace's bot (lib/server/browser-view.ts
  // names its project), never the user's own bot of that id; Bops Cloud lets through only an Admin, or Write with Use its computer.
  /^\/api\/browser(\?|$)/,
  // Keys (keys.tsx: Logins and a bot's key card in the chat): while a shared workspace is open, every keys route acts on
  // that workspace's own keys alone (lib/server/shared-keys.ts: orgo-web with the user's own Orgo key, which checks they
  // have Keys there; a bot's switch is an act through Bops Cloud), never the user's own vault or bots.
  /^\/api\/keys(\/|\?|$)/,
  // A file added in a chat or dropped on a bot's screen (attachments.tsx sendFile): while a shared workspace is open it goes
  // on the owner's computer Bops Cloud names for that bot (lib/server/shared.ts sharedFileTarget), for an Admin, with the
  // user's own Orgo key; never on the user's own bot of that id. (attachments.tsx sendFile asks sendRefused: XMLHttpRequest.)
  /^\/api\/bots\/files(\?|$)/,
  // Skills (skills.tsx, in Knowledge): while a shared workspace is open, every skills route acts on that workspace's skills
  // alone, in orgo-web with the user's own Orgo key, for an Admin there (lib/server/shared-skills.ts, which refuses anyone
  // else before Orgo is asked); never this Mac's folders or the user's own workspace of that id.
  /^\/api\/skills(\/|\?|$)/,
];

/** The reads that don't go while it's open: answered from the user's own bot or workspace of that id, never the shared one's. */
const OWN_READS = [
  /^\/api\/memory(\/|\?|$)/,
  /^\/api\/orbit(\/|\?|$)/,
  /^\/api\/routines\/suggestions(\/|\?|$)/,
  // A routine's runs, by id: the user's own routine of that id, never the owner's (its reports read the shared copy only).
  /^\/api\/routines\/[^/]+\/runs(\/|\?|$)/,
  /^\/api\/crm(\/|\?|$)/,
  /^\/api\/files(\/|\?|$)/,
  /^\/api\/vnc(\/|\?|$)/,
  /^\/api\/computer(\/|\?|$)/,
  /^\/api\/reader(\/|\?|$)/,
  // A screen's live mirror and its screenshots, by bot id: the user's own bot's Chrome of that id, never the owner's.
  /^\/api\/mirror(\/|\?|$)/,
  /^\/api\/screen(\/|\?|$)/,
  /^\/api\/screen-action(\/|\?|$)/,
  /^\/api\/mail\/handle(\/|\?|$)/,
  // The email or thread a drafted reply answers, read from the user's own account: never the owner's (the server refuses it too).
  /^\/api\/drafts\/source(\/|\?|$)/,
  /^\/api\/made-apps(\/|\?|$)/,
  /^\/api\/hosted-apps(\/|\?|$)/,
  // Settings → Domains, by workspace id: the user's own workspace's domains and who they registered them to, never the owner's.
  /^\/api\/domains(\/|\?|$)/,
  // A watch's suggestions read a bot's screen by its id: the user's own bot of that id, never the owner's.
  /^\/api\/watches(\/|\?|$)/,
  // The windows on this Mac and their pictures: the viewer's own Mac, never the owner's.
  /^\/api\/mac(\/|\?|$)/,
  // Images in chats, by id: what was sent from this Mac, never the owner's (attachments.tsx says they aren't shared).
  /^\/api\/uploads(\/|\?|$)/,
  // Settings → Your data: the user's own chats' numbers and Recently deleted, never the owner's (the server refuses it too).
  /^\/api\/privacy(\/|\?|$)/,
];

/** The app's own server's path a call goes to, or null for a call elsewhere. */
function ownPath(url: string): string | null {
  try {
    const u = new URL(url, "http://bops.local");
    if (u.origin !== "http://bops.local" && typeof window !== "undefined" && u.origin !== window.location.origin) return null;
    return u.pathname;
  } catch {
    return null;
  }
}

/**
 * Whether a call goes while a shared workspace is open: a read (but not one of OWN_READS), a call elsewhere, one of
 * ALLOWED, or a change the owner's own window makes (cloud/change-routes.ts): its route sends it to the owner's Mac for
 * someone allowed to make it, and refuses anything else there, never acting on the user's own bot of that id
 * (lib/server/change-relay.ts).
 */
export function callAllowed(method: string | undefined, url: string): boolean {
  const path = ownPath(url);
  if (path === null) return true;
  if (!method || ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return !OWN_READS.some((r) => r.test(path));
  return !path.startsWith("/api/") || ALLOWED.some((r) => r.test(path)) || !!changeRouteOf(method.toUpperCase(), path);
}

const g = globalThis as unknown as { bopsViewOnly?: { line: string | null; fetch?: typeof fetch } };

/**
 * Turn the guard on (with the line the refusal says) or off. Once on, the window's fetch is wrapped for good; off, it passes everything.
 * Called as the window renders, so it's set before any effect of what's drawn (a chat's mark read) makes a call.
 */
export function viewOnly(line: string | null) {
  const v = (g.bopsViewOnly ??= { line: null });
  v.line = line;
  if (!line || v.fetch || typeof window === "undefined") return;
  const real = (v.fetch = window.fetch.bind(window));
  window.fetch = (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!v.line || callAllowed(method, url)) return real(input, init);
    return Promise.resolve(Response.json({ error: v.line, code: "view_only" }, { status: 403 }));
  };
}

/** Whether a read that doesn't go through fetch (a screen's EventSource, an image's src) may go now: always, unless a shared workspace is open and it's one of OWN_READS. */
export const readAllowed = (url: string) => !g.bopsViewOnly?.line || callAllowed("GET", url);

/**
 * Why a write that doesn't go through fetch (a file's upload, which XMLHttpRequest sends for its progress:
 * attachments.tsx sendFile) can't go now, the same line a fetch would be refused with; null when it may.
 */
export function sendRefused(method: string, url: string): string | null {
  const line = g.bopsViewOnly?.line;
  return line && !callAllowed(method, url) ? line : null;
}
