/**
 * An app's Local beside its bot's chat (components/app/preview-tab.tsx) loads in a <webview> on a session of its
 * own, per Bops user, workspace and app (persist:bops-preview-<user>-<ws>-<app>), never the window's: the window's
 * own cookie is on localhost too and would go to the app's port. Each such session is prepared once:
 *
 * - a plain Chrome's user agent (without Electron/… and Bops/…), so Google's sign in takes it as a browser;
 * - the tabs' permission rules (main.cjs fenceTabSession: no clipboard reads, USB, HID, serial or MIDI).
 *
 * Each such webview gets desktop/preview-frame-preload.cjs (sandboxed, isolated, no Node, never one the window
 * names), which says S, D and Esc pressed in its page to the webview, so Select and Draw hear them there too.
 *
 * Its pages may open Google's sign in (accounts.google.com) and their own localhost pages as child windows on
 * the same session (a popup sign in comes back to its opener); anything else goes to the system browser, as a
 * web tab's does. A Preview link that asks for a password opens there without asking: the page puts the cookie
 * orgo-web gives for it in that session first (signIn, through main.cjs), each part of the ask checked here.
 * Plain CommonJS; Electron's objects come in as arguments, so scripts/test-preview-frames.mjs runs it in plain node.
 */

const PREFIX = "persist:bops-preview-";

/** Whether a partition is an app preview's. */
const isPreviewPartition = (p) => typeof p === "string" && p.startsWith(PREFIX) && /^[A-Za-z0-9_-]+$/.test(p.slice(PREFIX.length));

/** A plain Chrome's user agent from Electron's (this is Chromium): what a sign in page reads. */
const plainAgent = (ua) => String(ua).replace(/\s(?:Electron|Bops|bops)\/\S+/g, "");

/** Whether a preview's page may open `url` as a child window on its session: Google's sign in, or a localhost page. */
function popupAllowed(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:" && u.hostname === "accounts.google.com") return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}

/** A <webview> about to attach on a preview partition: its keys' preload and nothing more (no Node, sandboxed, isolated). */
function preparePreviewWebview(webPreferences, params, preload) {
  Object.assign(webPreferences, { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false });
  delete params.preload;
}

/** The cookie orgo-web gives a browser that typed a Preview's password (lib/hosted-apps.ts PASS_COOKIE), kept 30 days there. */
const PASS_COOKIE = "__Host-orgo_pass";
const PASS_DAYS = 30;
/** A Preview link's host: its 12 character label on orgo.dev (staging.orgo.dev on Orgo's staging). */
const PREVIEW_HOST = /^[a-z0-9]{12}\.(?:staging\.)?orgo\.dev$/;
/** A cookie's value as a browser takes it (RFC 6265): no space, quote, comma, semicolon or backslash. */
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/;

/**
 * The cookie the page asked to put in a preview's session (`ask`: its partition, the Preview's address, the cookie's
 * name and value), as session.cookies.set takes it, or null when any of it is off: a partition that isn't a
 * preview's, an address that isn't https on a Preview link's host (with no port or user), a name that isn't
 * __Host-orgo_pass, a value a browser wouldn't take. For that host alone (no domain), Secure, HttpOnly, SameSite
 * Lax, path /, 30 days, as orgo-web sets it.
 */
function passCookie(ask, now = Date.now()) {
  if (!ask || typeof ask !== "object") return null;
  const { partition, url, name, value } = ask;
  if (!isPreviewPartition(partition) || name !== PASS_COOKIE || typeof value !== "string" || !COOKIE_VALUE.test(value) || typeof url !== "string") return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !PREVIEW_HOST.test(u.hostname)) return null;
  return {
    partition,
    cookie: { url: `https://${u.hostname}/`, name, value, secure: true, httpOnly: true, sameSite: "lax", path: "/", expirationDate: Math.floor(now / 1000) + PASS_DAYS * 86400 },
  };
}

/**
 * Preview webviews and their pages: each preview session prepared once (`fence`: main.cjs's tab rules), each preview
 * webview given `preload` (its keys), and each preview page's windows sorted (`external`: the system browser).
 * Returns `isPreview`, so main.cjs leaves those pages to it, and `signIn`, a Preview's password cookie put in its
 * session (passCookie: false when it's refused).
 */
function installPreviewFrames({ app, session, fence, external, preload, log = () => {} }) {
  const ready = new WeakSet();
  const prepare = (partition) => {
    const s = session.fromPartition(partition);
    if (ready.has(s)) return s;
    ready.add(s);
    try {
      s.setUserAgent(plainAgent(s.getUserAgent()));
      fence(s);
    } catch (e) {
      log(`an app preview's session wasn't prepared: ${e?.message ?? e}`);
    }
    return s;
  };
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (_e, webPreferences, params) => {
      if (!isPreviewPartition(params.partition)) return;
      prepare(params.partition);
      preparePreviewWebview(webPreferences, params, preload);
    });
    if (contents.getType() !== "webview" || !ready.has(contents.session)) return;
    contents.setWindowOpenHandler(({ url }) => {
      if (popupAllowed(url)) return { action: "allow", overrideBrowserWindowOptions: { width: 520, height: 680, webPreferences: { session: contents.session, nodeIntegration: false, contextIsolation: true, sandbox: true } } };
      void external(url);
      return { action: "deny" };
    });
  });
  const signIn = async (ask) => {
    const c = passCookie(ask);
    if (!c) return false;
    try {
      await prepare(c.partition).cookies.set(c.cookie);
      return true;
    } catch (e) {
      log(`a preview's password cookie wasn't set: ${e?.message ?? e}`);
      return false;
    }
  };
  return { isPreview: (s) => ready.has(s), signIn };
}

module.exports = { PREFIX, PASS_COOKIE, isPreviewPartition, plainAgent, popupAllowed, passCookie, preparePreviewWebview, installPreviewFrames };
