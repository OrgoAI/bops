/**
 * Reading a page in a browser, for the Bops server (lib/server/web-render.ts): a page that draws itself
 * with JavaScript, or one behind a "checking your browser" wall, shows no text to a plain fetch. The
 * server asks here, over a socket only this user can open (in Bops' Application Support folder, with the
 * window's token), and this opens the page in a hidden window and hands back its visible text, title
 * and links.
 *
 * Kept apart from everything the user has: the window has a session of its own, in memory only (no
 * cookies, no sign ins, nothing kept; it's cleared after every page), never shown. Every request it
 * makes goes through the guard the server opens for that page (lib/server/render-guard.ts: public
 * addresses only, checked and pinned like a plain fetch), this Mac's own addresses included, and before
 * that this refuses any address that isn't http(s) or ws(s) (file: and the like), and Bops' own ports.
 * No downloads, no new windows, no permissions (camera, microphone, notifications, location, devices),
 * no plugins, no Node, the page sandboxed and isolated, sound off, no client certificate, no sign in
 * prompts. One page at a time, 20 seconds at most each, and the window is always destroyed.
 */
const { BrowserWindow, session: sessions } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");

/** The most time a page gets, from asking to its text. */
const LIMIT_MS = 20_000;
/** Quiet for this long (no request under way) counts as settled; never longer than SETTLE_MAX_MS. */
const QUIET_MS = 500;
const SETTLE_MAX_MS = 2_500;
/** The most text and links taken from a page. */
const MAX_TEXT = 2_000_000;
const MAX_LINKS = 2_000;
/** Pages waiting their turn at most; more are refused (the server queues its own too). */
const MAX_WAITING = 8;
/** The session the hidden windows use: no "persist:" prefix, so it lives in memory only. */
const PARTITION = "bops-render";
/** Ports no rendered page may reach, whatever the server allows for tests: Bops itself, the relay, DevTools. */
// Bops itself, on 3210 or a partner build's own port (desktop/brand.cjs).
const neverPort = (port) => port === 3210 || port === require("./brand.cjs").port || port === 8897 || (port >= 9200 && port <= 9399);
/** Addresses a page may ask for at all (the guard checks where they lead). data: and blob: never leave the page. */
const SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "data:", "blob:", "about:"]);

/** What a page's text, title and links are read with, in a world of its own (the page's scripts can't change what it sees). */
const EXTRACT = `(() => {
  const root = document.body || document.documentElement;
  const text = root ? String(root.innerText || root.textContent || "") : "";
  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    if (links.length >= ${MAX_LINKS}) break;
    const href = typeof a.href === "string" ? a.href : "";
    if (!/^https?:/i.test(href) || !a.getClientRects().length) continue;
    const words = String(a.innerText || a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 300);
    links.push(a.closest("nav, header, footer") ? { url: href, text: words, menu: true } : { url: href, text: words });
  }
  return { url: location.href, title: String(document.title || ""), text: text.slice(0, ${MAX_TEXT}), links, type: String(document.contentType || "") };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whether an address is this Mac or a private network written out as a number (the guard checks names too; this is a first fence). */
function privateLiteral(host) {
  const h = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const kind = net.isIP(h);
  if (kind === 4) return /^(0|10|127)\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);
  if (kind === 6) return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
  return false;
}

/** The session, set up once: every request checked, nothing allowed, nothing downloaded. */
let ready;
/** Requests under way for the page being read, by id (websockets aside: they stay open). */
const pending = new Set();
/** host:port pairs the server lets through for its tests (BOPS_FETCH_ALLOW), for the page being read. */
let allowed = new Set();
/** What this fence refused for the page being read. */
let fenced = [];
/** Told when the page being read turns out to be a file to download (a PDF, say): no page will load. */
let downloading = () => {};

function renderSession() {
  if (ready) return ready;
  const s = sessions.fromPartition(PARTITION, { cache: false });
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.setDevicePermissionHandler(() => false);
  if (s.setDisplayMediaRequestHandler) s.setDisplayMediaRequestHandler((_req, callback) => callback({}));
  s.on("will-download", (event, item) => {
    event.preventDefault();
    item.cancel();
    downloading();
  });
  s.setSpellCheckerEnabled(false);
  // A plain Chrome's user agent (this is Chromium): "Electron" and the app's name in it are what bot walls look for.
  s.setUserAgent(s.getUserAgent().replace(/\s(?:Electron|Bops|bops)\/\S+/g, ""));
  s.webRequest.onBeforeRequest((details, callback) => {
    let u;
    try {
      u = new URL(details.url);
    } catch {
      return callback({ cancel: true });
    }
    const port = u.port ? Number(u.port) : u.protocol === "https:" || u.protocol === "wss:" ? 443 : 80;
    const network = u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:";
    const refuse =
      !SCHEMES.has(u.protocol) ||
      (network && (u.username || u.password || neverPort(port) || (privateLiteral(u.hostname) && !allowed.has(`${u.hostname}:${port}`.toLowerCase()))));
    if (refuse) {
      if (fenced.length < 50) fenced.push(details.url.slice(0, 200));
      return callback({ cancel: true });
    }
    if (network && details.resourceType !== "webSocket") pending.add(details.id);
    callback({});
  });
  const done = (details) => pending.delete(details.id);
  s.webRequest.onCompleted(done);
  s.webRequest.onErrorOccurred(done);
  ready = s;
  return s;
}

/** The address a page may be opened at: http or https, no user name or password. */
function pageUrl(raw) {
  try {
    const u = new URL(String(raw));
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
}

/**
 * Reads one page: opens it in a hidden window whose every request goes through the guard at
 * 127.0.0.1:`proxyPort`, waits for it to load and settle (no request under way for half a second, at most
 * 2.5 seconds), and when `challenge` is set, while it still shows WALL_WORDS (a "checking your browser"
 * page: its title, or text shorter than `wallText`) waits for it to move on, until `limitMs` is up. Resolves with what it shows, `challenge: true` when it never moved past
 * that; rejects when it couldn't load. The window is destroyed whatever happens.
 */
/**
 * Words a "checking your browser" page shows: the same as CHALLENGE in lib/server/web-render.ts
 * (scripts/test-render.mjs checks they match). Kept here, not sent by the app, so no pattern from a
 * request ever becomes a regular expression.
 */
const WALL_WORDS =
  /just a moment\.\.\.|attention required! \| cloudflare|checking your browser|checking if the site connection is secure|verify(?:ing)? (?:that )?you are (?:a )?human|are you a robot|please verify you are a human|enable javascript and cookies to continue|pardon our interruption|ddos protection by|request unsuccessful\. incapsula|access to this page has been denied|press (?:&|and) hold to confirm/i;

async function renderOnce({ url, proxyPort, allow, challenge, wallText, limitMs }) {
  const u = pageUrl(url);
  if (!u) throw new Error("Only http and https pages can be read in a browser.");
  if (!Number.isInteger(proxyPort) || proxyPort <= 0 || proxyPort > 65535) throw new Error("No guard to read through.");
  const limit = Math.min(Math.max(1000, Number(limitMs) || LIMIT_MS), LIMIT_MS);
  const deadline = Date.now() + limit;
  const s = renderSession();
  allowed = new Set((Array.isArray(allow) ? allow : []).map((a) => String(a).trim().toLowerCase()).filter(Boolean));
  fenced = [];
  pending.clear();
  // Everything through the guard, this Mac's own addresses too ("<-loopback>" takes away the usual exception).
  await s.setProxy({ mode: "fixed_servers", proxyRules: `127.0.0.1:${proxyPort}`, proxyBypassRules: "<-loopback>" });
  await s.closeAllConnections();
  const waitFor = /** @type {RegExp | null} */ (challenge ? WALL_WORDS : null);
  const wallMax = Number(wallText) || 2000;
  // A wall's page is short: a long page that mentions "verify you are human" somewhere is a page.
  const walled = (got) => !!waitFor && (waitFor.test(got.title) || (got.text.length < wallMax && waitFor.test(got.text)));

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      session: s,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      plugins: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableWebSQL: false,
      spellcheck: false,
      images: false,
      autoplayPolicy: "document-user-activation-required",
      backgroundThrottling: false,
      navigateOnDragDrop: false,
      disableDialogs: true,
      safeDialogs: true,
    },
  });
  const wc = win.webContents;
  let status = 0;
  let timer;
  try {
    wc.setAudioMuted(true);
    wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    const onlyWeb = (event, to) => {
      if (!pageUrl(to)) event.preventDefault();
    };
    wc.on("will-navigate", onlyWeb);
    wc.on("will-redirect", onlyWeb);
    wc.on("will-attach-webview", (event) => event.preventDefault());
    wc.on("login", (event, _details, _auth, callback) => {
      event.preventDefault();
      callback();
    });
    wc.on("select-client-certificate", (event, _url, _list, callback) => {
      event.preventDefault();
      callback();
    });
    wc.on("select-bluetooth-device", (event, _devices, callback) => {
      event.preventDefault();
      callback("");
    });
    let navigated = 0;
    wc.on("did-navigate", (_event, _url, code) => {
      status = code || status;
      navigated++;
    });

    const overtime = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("The page took too long to load in a browser.")), Math.max(0, deadline - Date.now()));
    });
    const left = () => deadline - Date.now();

    // Loaded: the page and what it asked for (its scripts, at least) are in, or it failed.
    const loaded = new Promise((resolve, reject) => {
      wc.once("did-finish-load", () => resolve());
      wc.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) reject(new Error(`The page didn't load in a browser (${description || code}).`));
      });
      downloading = () => reject(new Error("That address is a file to download, not a page."));
    });
    loaded.catch(() => {});
    overtime.catch(() => {});
    wc.loadURL(u.href).catch(() => {});
    await Promise.race([loaded, overtime]);

    const settle = async () => {
      const until = Math.min(deadline, Date.now() + SETTLE_MAX_MS);
      let quietSince = pending.size ? 0 : Date.now();
      while (Date.now() < until) {
        await sleep(100);
        if (pending.size) quietSince = 0;
        else if (!quietSince) quietSince = Date.now();
        else if (Date.now() - quietSince >= QUIET_MS) return;
      }
    };
    const read = () => Promise.race([wc.executeJavaScriptInIsolatedWorld(1001, [{ code: EXTRACT }]), overtime]);

    await Promise.race([settle(), overtime]);
    let got = await read();
    // A "checking your browser" page moves on by itself once it's done (a new page, or new text): wait for that.
    while (walled(got)) {
      if (left() < 1500) return { ...got, status, challenge: true, refused: fenced };
      const before = navigated;
      const waitUntil = Date.now() + Math.min(3000, left() - 1000);
      while (navigated === before && Date.now() < waitUntil) await sleep(150);
      if (navigated !== before) await Promise.race([new Promise((r) => (wc.isLoading() ? wc.once("did-stop-loading", r) : r())), overtime]);
      await Promise.race([settle(), overtime]);
      got = await read();
    }
    return { ...got, status, refused: fenced };
  } finally {
    clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
    pending.clear();
    allowed = new Set();
    downloading = () => {};
    // Nothing kept from one page to the next: cookies, storage, cache, sign ins, open connections.
    await Promise.allSettled([s.clearStorageData(), s.clearCache(), s.clearAuthCache(), s.clearHostResolverCache(), s.closeAllConnections()]);
  }
}

/**
 * Starts the service on a Unix socket at `socketPath` (made readable by this user only), for requests
 * that carry `token`. One line of JSON in, one out:
 * { token, url, proxyPort, allow?, challenge?, wallText?, limitMs? } answers { ok: true, url, status, title, text,
 * links, type, challenge? } or { ok: false, error }; { token, op: "status" } answers how many windows are
 * open and how many pages wait (for tests). Returns { listening, close }: `listening` settles once it
 * listens, or fails to.
 */
function startRenderService({ socketPath, token, log = () => {} }) {
  let open = 0;
  let waiting = 0;
  let chain = Promise.resolve();
  const want = Buffer.from(String(token));
  const authorized = (got) => {
    const b = Buffer.from(String(got ?? ""));
    return b.length === want.length && crypto.timingSafeEqual(b, want);
  };
  const handle = async (req) => {
    if (!req || typeof req !== "object" || !authorized(req.token)) return { ok: false, error: "Not allowed." };
    if (req.op === "status") return { ok: true, open, waiting };
    if (waiting >= MAX_WAITING) return { ok: false, error: "Too many pages are waiting to be read in a browser." };
    waiting++;
    const turn = chain.then(async () => {
      waiting--;
      open++;
      try {
        return { ok: true, ...(await renderOnce(req)) };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      } finally {
        open--;
      }
    });
    chain = turn.then(
      () => {},
      () => {},
    );
    return turn;
  };

  try {
    fs.rmSync(socketPath, { force: true });
  } catch {}
  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    let buf = "";
    let answered = false;
    const reply = (obj) => {
      if (answered || conn.destroyed) return;
      answered = true;
      conn.end(`${JSON.stringify(obj)}\n`);
    };
    conn.on("error", () => conn.destroy());
    conn.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 64 * 1024) return reply({ ok: false, error: "Too long." });
      const nl = buf.indexOf("\n");
      if (nl < 0 || answered) return;
      let req;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        return reply({ ok: false, error: "Not JSON." });
      }
      handle(req).then(reply, (e) => reply({ ok: false, error: String(e?.message ?? e) }));
    });
  });
  let listened;
  const listening = new Promise((resolve, reject) => {
    listened = resolve;
    server.once("error", reject);
  });
  listening.catch(() => {});
  server.on("error", (e) => log(`render service: ${e.message}`));
  // Created readable by this user only (umask), not changed afterwards: no moment when anyone else could connect.
  const mask = process.umask(0o177);
  try {
    server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {}
      log("render service listening");
      listened();
    });
  } finally {
    process.umask(mask);
  }
  return {
    listening,
    close() {
      server.close();
      try {
        fs.rmSync(socketPath, { force: true });
      } catch {}
    },
  };
}

module.exports = { startRenderService, LIMIT_MS };
