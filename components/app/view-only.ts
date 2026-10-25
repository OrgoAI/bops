"use client";

/**
 * While a workspace shared with the user is open (AppState.shared, lib/shared.ts), nothing in the window
 * changes anything: every call that would (anything but a GET) to the app's own server is answered here
 * with 403 and the read only line, without going out, wherever in the window it's made. Only what leaves
 * or switches the workspace, signing in and out, notices, usage events, what's on screen and what's the
 * user's own (their vault, account and name) go through. Nor do the reads the server answers from the
 * user's own bots or workspaces by id (a shared bot's id is often one of theirs, "boppy"): their memory,
 * Knowledge's issues, skills, files, screens. The buttons that would change something are hidden or say so too; this is what
 * holds whatever's missed. A screen's stream and its pictures (an EventSource, an image) never pass through fetch: what
 * opens them asks readAllowed first.
 */

/** The calls that still go while it's open: the switcher (leaving, switching, its names), signing in and out, notices, usage events, what's on screen, the user's own vault, account and name. */
const ALLOWED = [
  /^\/api\/workspaces(\/|\?|$)/,
  /^\/api\/auth\//,
  /^\/api\/notices(\/|\?|$)/,
  /^\/api\/analytics(\/|\?|$)/,
  /^\/api\/view(\?|$)/,
  /^\/api\/vault(\/|\?|$)/,
  /^\/api\/account(\/|\?|$)/,
  /^\/api\/owner(-email)?(\/|\?|$)/,
];

/** The reads that don't go while it's open: answered from the user's own bot or workspace of that id, never the shared one's. */
const OWN_READS = [
  /^\/api\/memory(\/|\?|$)/,
  /^\/api\/orbit(\/|\?|$)/,
  /^\/api\/skills(\/|\?|$)/,
  /^\/api\/routines\/suggestions(\/|\?|$)/,
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
  /^\/api\/made-apps(\/|\?|$)/,
  /^\/api\/hosted-apps(\/|\?|$)/,
  // A watch's suggestions read a bot's screen by its id: the user's own bot of that id, never the owner's.
  /^\/api\/watches(\/|\?|$)/,
  // The windows on this Mac and their pictures: the viewer's own Mac, never the owner's.
  /^\/api\/mac(\/|\?|$)/,
  // Images in chats, by id: what was sent from this Mac, never the owner's (attachments.tsx says they aren't shared).
  /^\/api\/uploads(\/|\?|$)/,
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

/** Whether a call goes while a shared workspace is open: a read (but not one of OWN_READS), a call elsewhere, or one of ALLOWED. */
export function callAllowed(method: string | undefined, url: string): boolean {
  const path = ownPath(url);
  if (path === null) return true;
  if (!method || ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return !OWN_READS.some((r) => r.test(path));
  return !path.startsWith("/api/") || ALLOWED.some((r) => r.test(path));
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
