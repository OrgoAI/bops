/**
 * The apps the bots make (lib/server/made-apps.ts) run in Bops' window in a <webview> on a session of
 * their own (components/app/made-apps.tsx, AppFrame), not in a frame of the window's: a model wrote
 * their code, and the page's CSP can't hold it alone. A frame may load another page in itself (data
 * in its address), and WebRTC isn't covered by connect-src. So, in that session and in each app's page:
 *
 * - Only the app's own page loads: every request but a `/api/made-apps/<id>/view` on Bops' server
 *   (and data: and blob:) is cancelled, and the page can't go to another address, not even another
 *   app's. No windows, no downloads, no permissions, no devices.
 * - WebRTC reaches nothing: UDP only through a proxy, and the session's proxy goes nowhere (Chromium
 *   reaches this Mac's own addresses without one, so the app's page still loads).
 * - The page talks to the window only through desktop/app-frame-preload.cjs (sendToHost), and the
 *   window answers only the first page its webview loaded.
 *
 * The window's own session is untouched: it needs WebRTC for the bots' screens and calls.
 * Plain CommonJS; Electron's objects come in as arguments, so scripts/test-app-frames.mjs runs it in
 * plain node and in Electron.
 */

const PARTITION = "bops-apps";
/** A proxy nothing listens on: WebRTC's TCP must go through it, so it goes nowhere. */
const NOWHERE = "http://127.0.0.1:9";

/** The app a `/api/made-apps/<id>/view` address on Bops' server is for, or null for any other address. */
function appOfView(url, server) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== new URL(server).origin || u.username || u.password) return null;
  const m = /^\/api\/made-apps\/(app_[A-Za-z0-9]+)\/view$/.exec(u.pathname);
  return m ? m[1] : null;
}

/** Whether a request from an app's page may go out: its own page (and inline data) only. */
function allowedRequest(url, server) {
  return /^(data|blob):/i.test(url) || !!appOfView(url, server);
}

/** The apps' session: nothing but their pages loads, nothing is allowed, and WebRTC has no way out. */
async function fenceAppSession(s, server) {
  s.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedRequest(details.url, server) }));
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.setDevicePermissionHandler(() => false);
  s.on("will-download", (e) => e.preventDefault());
  await s.setProxy({ mode: "fixed_servers", proxyRules: NOWHERE });
}

/**
 * A <webview> about to be attached: one on the apps' partition gets the apps' preload and nothing more
 * (no Node, sandboxed, isolated), and only for an app's page. Returns false when it must not attach,
 * true when it's an app's, and null when it's another webview (a web tab), left as it is.
 */
function prepareAppWebview(webPreferences, params, { server, preload }) {
  if (params.partition !== PARTITION) return null;
  if (!appOfView(params.src, server)) return false;
  Object.assign(webPreferences,{ preload, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true, webviewTag: false, javascript: true });
  delete params.allowpopups;
  delete params.preload;
  return true;
}

/**
 * An app's page (its webview's contents): it may load its own app's page again, never anything else,
 * opens no windows, and its WebRTC sends no UDP but through the proxy that goes nowhere.
 */
function guardAppContents(contents, server) {
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  // The app its page is (the first page it loads); before that, any app's page.
  const mayGo = (url) => {
    const to = appOfView(url, server);
    const now = appOfView(contents.getURL(), server);
    return !!to && (!now || now === to);
  };
  const stop = (e, url) => {
    if (!mayGo(e?.url ?? url)) e.preventDefault();
  };
  contents.on("will-navigate", stop);
  contents.on("will-frame-navigate", stop);
  contents.on("will-redirect", stop);
}

/**
 * All of the above, once the app is ready and before any window opens: the apps' session fenced, every
 * <webview> about to attach checked (an app's gets the apps' preload, only for an app's page), and every
 * app's page guarded. `isApps` tells main.cjs which webviews are apps', so it leaves them be.
 */
function installAppFrames({ app, session, server, preload, log = () => {} }) {
  const apps = session.fromPartition(PARTITION);
  fenceAppSession(apps, server).catch((e) => log(`the apps' session wasn't fenced: ${e?.message ?? e}`));
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (e, webPreferences, params) => {
      if (prepareAppWebview(webPreferences, params, { server, preload }) === false) e.preventDefault();
    });
    if (contents.getType() === "webview" && contents.session === apps) guardAppContents(contents, server);
  });
  return { isApps: (s) => s === apps };
}

module.exports = { PARTITION, appOfView, allowedRequest, fenceAppSession, prepareAppWebview, guardAppContents, installAppFrames };
