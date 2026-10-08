/**
 * Bops for Mac. A native window around the Bops app: it starts the app's local server if one
 * isn't already running, opens the window with the Mac title bar from the design, and on quit
 * stops what it started, including the bots' background browsers.
 */
const { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, Notification, screen, session, shell, systemPreferences } = require("electron");
const { execFile, execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const PORT = 3210;
const URL = `http://localhost:${PORT}`;
const IS_WINDOWS = process.platform === "win32";

/**
 * The Bops window's token (lib/server/ui-token.ts): what only the window may do (turn on Full access,
 * change a bot's settings) needs it, so a page that reached the server some other way (a bot's Chrome
 * on this Mac) can't. Kept in Application Support, readable by this user only, so the window and a
 * server already running from an earlier start have the same one.
 */
let token;
function windowToken() {
  if (token) return token;
  const file = path.join(app.getPath("userData"), "window-token");
  try {
    const kept = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(kept)) return (token = kept);
  } catch {
    // None yet.
  }
  token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}
/** The window's session carries it to the server on every request, as a cookie no page script can read. */
const giveWindowToken = () => session.defaultSession.cookies.set({ url: URL, name: "bops_window", value: windowToken(), httpOnly: true, sameSite: "strict" });
const REPO = (() => {
  try {
    return require("./repo.json").path;
  } catch {
    return path.resolve(__dirname, "..");
  }
})();
const ICON = path.join(__dirname, "icon.png");

let server;
let mainWin;
let pipWin;

/** Apps opened from Finder get a bare PATH; borrow the login shell's so node and codex resolve. */
function loginPath() {
  if (IS_WINDOWS) return process.env.PATH || "";
  try {
    return execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf %s "$PATH"'], { timeout: 5000 }).toString();
  } catch {
    return process.env.PATH;
  }
}

/** Bops' server is answering. /api/health imports nothing, so a missing key can't hold up the start. */
async function serverUp() {
  try {
    return (await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** Something already listens on the port (a server from an earlier start that's still loading, say). */
function portTaken() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => (s.destroy(), resolve(false)));
  });
}

/*
 * Where the server runs from. A release build carries a prebuilt server (Next's standalone output,
 * copied to Resources/server by electron-builder) and runs it with the app's own Node. A build made
 * with `npm run app:build` (desktop/repo.json) or `npm run app` runs `next dev` in the source folder.
 */
function packagedServer() {
  if (!app.isPackaged || fs.existsSync(path.join(__dirname, "repo.json"))) return null;
  const dir = path.join(process.resourcesPath, "server");
  if (!fs.existsSync(path.join(dir, "server.js"))) return null;
  // The app bundle is read-only (and sealed by its signature), but the server keeps its state in
  // .data/ under its working folder and reads vm/ and node_modules/ from there. So it runs in
  // ~/Library/Application Support/Bops/server, where everything but .data links into the bundle.
  const home = path.join(app.getPath("userData"), "server");
  fs.mkdirSync(path.join(home, ".data"), { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name === ".data" || name.startsWith(".env")) continue;
    const link = path.join(home, name);
    const st = fs.lstatSync(link, { throwIfNoEntry: false });
    if (st && !st.isSymbolicLink()) continue;
    if (st && fs.readlinkSync(link) === path.join(dir, name)) continue;
    if (st) fs.unlinkSync(link);
    if (IS_WINDOWS) {
      const source = path.join(dir, name);
      const isDir = fs.statSync(source).isDirectory();
      try { fs.symlinkSync(source, link, isDir ? "junction" : "file"); }
      catch {
        if (isDir) fs.cpSync(source, link, { recursive: true, force: true });
        else fs.copyFileSync(source, link);
      }
    } else fs.symlinkSync(path.join(dir, name), link);
  }
  // Settings for this Mac (self-hosting, testing) go in ~/Library/Application Support/Bops/.env.local;
  // the app itself ships with no keys.
  let env = {};
  try {
    env = require("node:util").parseEnv(fs.readFileSync(path.join(app.getPath("userData"), ".env.local"), "utf8"));
  } catch {}
  const relay = path.join(process.resourcesPath, "bin", IS_WINDOWS ? "orgo-relay.exe" : "orgo-relay");
  // What the server prints, for support: ~/Library/Logs/Bops/server.log. Each start adds to it (an
  // earlier start's error is often the one that matters); it starts over once it passes 5 MB.
  fs.mkdirSync(app.getPath("logs"), { recursive: true });
  const logFile = path.join(app.getPath("logs"), "server.log");
  const big = (fs.statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > 5 * 1024 * 1024;
  const log = fs.openSync(logFile, big ? "w" : "a");
  fs.writeSync(log, `\n--- Bops ${app.getVersion()} starting, ${new Date().toISOString()}\n`);
  // WebRTC stays off in the shipped app until every Orgo host's WebRTC gateway streams a 1280x960 screen
  // at its real size (ORGO_RTC_HEIGHT=960; otherwise it shrinks the bot's screen, lib/server/orgo.ts
  // webrtcWanted). Then this default goes. A Mac's .env.local can still say BOPS_WEBRTC=1.
  const shipped = { BOPS_WEBRTC: "0" };
  return { dir, home, log, env: { ...shipped, ...env, ...(fs.existsSync(relay) ? { BOPS_RELAY_BIN: relay } : {}) } };
}

/** The Helper app's binary (Frameworks/<App> Helper.app), which runs in the background with no Dock icon; else the app's own. */
function nodeBinary() {
  const name = `${app.getName()} Helper`;
  const helper = path.join(path.dirname(process.execPath), "..", "Frameworks", `${name}.app`, "Contents", "MacOS", name);
  return fs.existsSync(helper) ? helper : process.execPath;
}

async function startServer() {
  if (await serverUp()) return;
  // A second server on a taken port only fails (EADDRINUSE): wait for the one that's there instead.
  if (await portTaken()) {
    for (let i = 0; i < 240 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 500));
    return;
  }
  const packaged = packagedServer();
  server = packaged
    ? // Run as Node by the app's Helper binary (LSUIElement), not the app's own: run by the app's
      // binary, macOS listed the server in the Dock as a second app ("exec"). server.js changes into
      // its folder on start; keeping the working folder in Application Support is what lets the
      // server write its state.
      spawn(nodeBinary(), ["-e", "process.chdir = () => {}; require(process.env.BOPS_SERVER_JS)"], {
        cwd: packaged.home,
        env: {
          ...process.env,
          ...packaged.env,
          PATH: loginPath(),
          ELECTRON_RUN_AS_NODE: "1",
          BOPS_SERVER_JS: path.join(packaged.dir, "server.js"),
          NODE_ENV: "production",
          // The server exits on SIGTERM itself, after its last work (the state saved to Bops Cloud, or self-hosted to its file).
          NEXT_MANUAL_SIG_HANDLE: "true",
          PORT: String(PORT),
          BOPS_UI_TOKEN: windowToken(),
          // Only this Mac can reach the bundled server, unless its settings say BOPS_LISTEN_ALL=1:
          // bot computers' app calls and phone webhooks reach Bops over the tailnet, so they need
          // it (proxy.ts then lets other addresses reach only those paths).
          HOSTNAME: packaged.env.BOPS_LISTEN_ALL === "1" ? "0.0.0.0" : "127.0.0.1",
        },
        stdio: ["ignore", packaged.log, packaged.log],
        detached: !IS_WINDOWS,
        windowsHide: true,
      })
    : spawn(IS_WINDOWS ? "npx.cmd" : "npx", ["next", "dev", "--port", String(PORT)], {
        cwd: REPO,
        env: { ...process.env, PATH: loginPath(), BOPS_UI_TOKEN: windowToken() },
        stdio: "ignore",
        detached: !IS_WINDOWS,
        ...(IS_WINDOWS ? { shell: true, windowsHide: true } : {}),
      });
  for (let i = 0; i < 240 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 500));
}

const splash = `data:text/html,${encodeURIComponent(`<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:13px -apple-system,system-ui;color:#6B6B6B;-webkit-app-region:drag">Starting Bops…</body>`)}`;

async function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1180,
    minHeight: 640,
    title: "Bops",
    ...(IS_WINDOWS ? {} : { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 14 } }),
    backgroundColor: "#FFFFFF",
    icon: ICON,
    // Web pages open as tabs inside Bops (see components/app/panel-tabs.tsx). The preload lets the
    // Your Mac tab show this Mac's screens and windows live (see components/app/mac-screens.tsx).
    webPreferences: { webviewTag: true, preload: path.join(__dirname, "preload.cjs") },
  });
  mainWin = win;
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  await win.loadURL(splash);
  await startServer();
  await giveWindowToken();
  await win.loadURL(URL);
}

// A page in a tab that opens a new window opens it in your browser instead.
app.on("web-contents-created", (_, contents) => {
  if (contents.getType() !== "webview") return;
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
});

/*
 * Screen Recording. macOS only answers "granted" or "denied" here, never "not asked yet", and it
 * only lists an app under Screen Recording (and shows its prompt) once the app has tried to capture.
 * So Bops remembers in its data folder that it has asked, and until then reports "not-determined"
 * so the page offers Allow; asking is trying to list the screens.
 */
const screenAskedFile = () => path.join(app.getPath("userData"), "screen-asked.json");
function screenAsked() {
  try {
    return fs.existsSync(screenAskedFile());
  } catch {
    return false;
  }
}
function screenStatus() {
  if (process.platform !== "darwin") return "granted";
  const access = systemPreferences.getMediaAccessStatus("screen");
  return access !== "granted" && !screenAsked() ? "not-determined" : access;
}
async function askScreen() {
  if (process.platform !== "darwin" || systemPreferences.getMediaAccessStatus("screen") === "granted") return;
  try {
    fs.writeFileSync(screenAskedFile(), JSON.stringify({ at: Date.now() }));
  } catch {}
  await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
}

/*
 * Your Mac, live. The page asks for the displays and windows it can show, then streams one with
 * getUserMedia (chromeMediaSource "desktop"). macOS asks the user once to allow Screen Recording.
 */
ipcMain.handle("mac-screens", async () => {
  // The first time, ask: that lists Bops under Screen Recording and shows macOS's prompt.
  if (screenStatus() === "not-determined") await askScreen();
  const access = screenStatus();
  const displays = screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: d.label || (d.internal ? "Built-in display" : `Display ${i + 1}`),
    width: d.size.width,
    height: d.size.height,
    primary: d.id === screen.getPrimaryDisplay().id,
  }));
  // The display Bops is on: showing it shows Bops inside Bops, so the tab prefers another.
  const win = BrowserWindow.getAllWindows()[0];
  const bopsOn = win ? String(screen.getDisplayMatching(win.getBounds()).id) : undefined;
  if (access !== "granted") return { access, displays, sources: [], bopsOn };
  const list = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
  return { access, displays, bopsOn, sources: list.map((s) => ({ id: s.id, name: s.name, displayId: s.display_id || undefined })) };
});
ipcMain.handle("mac-screen-settings", () => shell.openExternal(IS_WINDOWS ? "ms-settings:privacy-screenshots" : "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"));

/*
 * What Bops asks macOS for, all in one place (components/app/setup.tsx, and Settings → This Mac):
 * Screen Recording (to show your Mac live), the Microphone (calls with bots) and Notifications.
 * Bops itself never drives other apps' windows (bots on your Mac only browse, in a Chrome of their
 * own), so Accessibility is only read here, never prompted for from setup. With Full access on
 * (Settings → This Mac), bots script apps and read files as Bops. Full Disk Access can only be read
 * here (its pane opens); Automation is asked for up front, app by app (askAutomation), so no prompt
 * comes up in the middle of a task.
 */
const PANES = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  notifications: "x-apple.systempreferences:com.apple.preference.notifications",
  fullDisk: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
};
const PERM_IDS = Object.keys(PANES);
const mac = process.platform === "darwin";
// macOS keeps the Screen Recording answer a process saw at launch: a grant made later only takes
// effect after a restart. The status at launch tells the page when to offer one.
const screenAtLaunch = mac ? systemPreferences.getMediaAccessStatus("screen") : "granted";

/*
 * Notifications: Electron can't read macOS's answer, only learn it by showing one (it asks the first
 * time; "failed" means not allowed). The last answer is kept in the app's data folder. It goes stale
 * if the user changes it in System Settings later, so the page treats it as a hint.
 */
const notifyFile = () => path.join(app.getPath("userData"), "notifications.json");
function notifyKnown() {
  try {
    return JSON.parse(fs.readFileSync(notifyFile(), "utf8")).status;
  } catch {
    return undefined;
  }
}
function notifyStatus() {
  if (!Notification.isSupported()) return "restricted";
  return notifyKnown() ?? "not-determined";
}
function askNotify() {
  if (!Notification.isSupported()) return Promise.resolve("restricted");
  return new Promise((resolve) => {
    const done = (status) => {
      clearTimeout(timer);
      // No answer yet (the prompt is still up): don't remember a guess.
      if (status !== "not-determined") {
        try {
          fs.writeFileSync(notifyFile(), JSON.stringify({ status, at: Date.now() }));
        } catch {}
      }
      resolve(status);
    };
    const n = new Notification({ title: "Bops", body: "Your bots can tell you when something needs you.", silent: true });
    n.once("show", () => done("granted"));
    n.once("failed", () => done("denied"));
    const timer = setTimeout(() => done(notifyKnown() ?? "not-determined"), 30_000);
    n.show();
  });
}

/*
 * Full access: the apps bots script on this Mac (their instructions name these), by bundle id. Each
 * needs its own Automation grant, which macOS only asks for when Bops first sends the app an Apple
 * event.
 */
const SCRIPTED_APPS = [
  ["com.apple.MobileSMS", "Messages"],
  ["com.apple.Notes", "Notes"],
  ["com.apple.mail", "Mail"],
  ["com.apple.iCal", "Calendar"],
  ["com.apple.reminders", "Reminders"],
  ["com.apple.AddressBook", "Contacts"],
  ["com.apple.finder", "Finder"],
];
/**
 * Places only Full Disk Access opens, so opening one is the test for it. Without it macOS answers "not
 * permitted". The privacy database came first, but macOS 27 hides its folder even from apps with Full
 * Disk Access (it reads as missing), so a place that's missing says nothing and the next one is tried.
 */
const FULL_DISK_PLACES = ["Library/Application Support/com.apple.TCC/TCC.db", "Library/Safari", "Library/Mail", "Library/Messages/chat.db"];
function fullDiskStatus() {
  for (const place of FULL_DISK_PLACES) {
    const p = path.join(app.getPath("home"), place);
    try {
      if (fs.statSync(p).isDirectory()) fs.readdirSync(p);
      else fs.closeSync(fs.openSync(p, "r"));
      return "granted";
    } catch (e) {
      if (e.code !== "ENOENT") return "denied";
    }
  }
  return "denied";
}
const run = (file, args, timeout) => new Promise((resolve) => execFile(file, args, { timeout }, (error, stdout, stderr) => resolve({ error, out: `${stdout}${stderr}` })));

/*
 * Bops' Automation answer for each app, read without asking (AEDeterminePermissionToAutomateTarget, in
 * osascript, which macOS counts as Bops). The privacy database it was read from is hidden on macOS 27
 * (fullDiskStatus). macOS only answers for an app that's running, so each app's last answer is kept in
 * the app's data folder, and one never answered reads as not asked yet ("Allow apps" asks again, and
 * an app already allowed shows no prompt).
 */
const automationFile = () => path.join(app.getPath("userData"), "automation.json");
function automationKnown() {
  try {
    return JSON.parse(fs.readFileSync(automationFile(), "utf8"));
  } catch {
    return {};
  }
}
function rememberAutomation(answers) {
  if (!Object.keys(answers).length) return;
  try {
    fs.writeFileSync(automationFile(), JSON.stringify({ ...automationKnown(), ...answers }));
  } catch {
    // Read again next time.
  }
}
// noErr, errAEEventNotPermitted, errAEEventWouldRequireUserConsent; anything else (procNotFound: not running) says nothing.
const AUTOMATION_ANSWERS = { 0: "granted", "-1743": "denied", "-1744": "not-determined" };
const AUTOMATION_CHECK = `ObjC.import('Foundation'); ObjC.import('CoreServices');
ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]);
const ids = ${JSON.stringify(SCRIPTED_APPS.map(([id]) => id))}, out = {};
for (const id of ids) out[id] = $.AEDeterminePermissionToAutomateTarget($.NSAppleEventDescriptor.descriptorWithBundleIdentifier(id).aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, false);
JSON.stringify(out);`;
async function automationApps() {
  const { error, out } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", AUTOMATION_CHECK], 5000);
  let codes = {};
  try {
    if (!error) codes = JSON.parse(out.trim());
  } catch {
    // Only what was kept, then.
  }
  const now = Object.fromEntries(Object.entries(codes).flatMap(([id, code]) => (AUTOMATION_ANSWERS[code] ? [[id, AUTOMATION_ANSWERS[code]]] : [])));
  rememberAutomation(now);
  const known = { ...automationKnown(), ...now };
  return SCRIPTED_APPS.map(([id, name]) => ({ id, name, status: known[id] ?? "not-determined" }));
}
function summary(apps) {
  if (!apps) return "unknown";
  if (apps.every((a) => a.status === "granted")) return "granted";
  return apps.some((a) => a.status === "denied") ? "denied" : "not-determined";
}
/**
 * Ask for Automation on every app bots script, one prompt at a time, out of the user's way: an app
 * that isn't running opens hidden (never in front), gets one harmless Apple event (counting its
 * windows), which is what makes macOS ask, and is quit again after. One that was running is left be.
 */
let askingAutomation;
function askAutomation() {
  askingAutomation ??= (async () => {
    for (const [id] of SCRIPTED_APPS) {
      const running = (await run("/usr/bin/osascript", ["-e", `application id "${id}" is running`], 5000)).out.trim() === "true";
      if (!running) {
        await run("/usr/bin/open", ["-g", "-j", "-b", id], 10_000);
        for (let i = 0; i < 20 && (await run("/usr/bin/osascript", ["-e", `application id "${id}" is running`], 5000)).out.trim() !== "true"; i++) await new Promise((r) => setTimeout(r, 250));
      }
      // Waits for the user's answer to macOS's prompt (Apple events time out after two minutes).
      const ask = () => run("/usr/bin/osascript", ["-e", `tell application id "${id}" to count windows`], 130_000);
      let asked = await ask();
      // Contacts says it's running before it takes Apple events ("isn't running", -600): once more, a moment later.
      if (asked.out.includes("-600")) asked = await new Promise((r) => setTimeout(r, 1500)).then(ask);
      // Kept, since automationApps can't read it once the app is closed again.
      if (!asked.error) rememberAutomation({ [id]: "granted" });
      else if (asked.out.includes("-1743")) rememberAutomation({ [id]: "denied" });
      if (!running) await run("/usr/bin/osascript", ["-e", `tell application id "${id}" to quit`], 10_000);
    }
  })().finally(() => (askingAutomation = undefined));
  return askingAutomation;
}

async function permStatus(id) {
  if (!mac) return id === "notifications" ? notifyStatus() : "granted";
  if (id === "screen") return screenStatus();
  if (id === "microphone") return systemPreferences.getMediaAccessStatus(id);
  if (id === "accessibility") return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "not-determined";
  if (id === "notifications") return notifyStatus();
  if (id === "fullDisk") return fullDiskStatus();
  if (id === "automation") return summary(await automationApps());
  return "unknown";
}

ipcMain.handle("perm-status", async () => Object.fromEntries(await Promise.all(PERM_IDS.map(async (id) => [id, await permStatus(id)]))));
// Full access's apps, each with its Automation answer (null without Full Disk Access to read them).
ipcMain.handle("perm-automation-apps", () => (mac ? automationApps() : null));
ipcMain.handle("perm-request", async (_, id) => {
  if (!PERM_IDS.includes(id)) return "unknown";
  if (!mac) return id === "notifications" ? askNotify() : "granted";
  if (id === "microphone") {
    await systemPreferences.askForMediaAccess("microphone").catch(() => false);
  } else if (id === "screen") {
    // Asking for the screens is what makes macOS list Bops under Screen Recording and show its prompt.
    await askScreen();
  } else if (id === "accessibility") {
    systemPreferences.isTrustedAccessibilityClient(true);
  } else if (id === "notifications") {
    return askNotify();
  } else if (id === "automation") {
    await askAutomation();
  }
  return permStatus(id);
});
ipcMain.handle("perm-settings", (_, id) => {
  if (IS_WINDOWS) {
    const paths = { screen: "ms-settings:privacy-screenshots", microphone: "ms-settings:privacy-microphone", accessibility: "ms-settings:easeofaccess", notifications: "ms-settings:notifications", fullDisk: "ms-settings:privacy", automation: "ms-settings:privacy" };
    return paths[id] ? shell.openExternal(paths[id]) : undefined;
  }
  return PANES[id] ? shell.openExternal(PANES[id]) : undefined;
});
// Screen Recording was turned on after Bops started: it works once Bops restarts.
ipcMain.handle("perm-screen-restart", () => mac && screenAtLaunch !== "granted" && systemPreferences.getMediaAccessStatus("screen") === "granted");

/*
 * Restart Bops (components/app/restart.tsx, and the Screen Recording card's Restart). A clean one:
 * the server lets go first (POST /api/restart: the signed-in user's state saved to Bops Cloud, the cached
 * Bops Cloud session and Orgo plan dropped), then it's stopped, and Bops
 * opens again and starts a new one. Who's signed in stays (the key is in the Keychain), and so does
 * everything they have: the server saves once more on its way out, before its port closes.
 *
 * A server that doesn't answer is stopped all the same. One this app didn't start (left running by
 * an earlier Bops that quit badly) is stopped by its process id in a release build, once it's surely
 * Bops' own; a development server someone started themselves is left running.
 */
let restarting;
function restart() {
  restarting ??= (async () => {
    let pid;
    try {
      const res = await fetch(`${URL}/api/restart`, { method: "POST", headers: { "x-bops-window": windowToken() }, signal: AbortSignal.timeout(20_000) });
      pid = (await res.json()).pid;
    } catch {}
    // Wait for the port to close, so the new Bops starts its own server instead of finding the old
    // one still answering and then losing it.
    if (stopServer() || stopOtherServer(pid))
      for (let i = 0; i < 60 && ((await serverUp()) || (await portTaken())); i++) await new Promise((r) => setTimeout(r, 250));
    app.relaunch();
    app.exit(0);
  })();
  return restarting;
}
ipcMain.handle("relaunch", () => restart());

/** Stops a release build's server this app didn't start, by the process id it gave. Says whether it did. */
function stopOtherServer(pid) {
  if (!app.isPackaged || fs.existsSync(path.join(__dirname, "repo.json")) || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    if (IS_WINDOWS) {
      const cmdline = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { windowsHide: true }).toString();
      if (!cmdline.includes("BOPS_SERVER_JS")) return false;
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      if (!execFileSync("ps", ["-p", String(pid), "-o", "command="]).toString().includes("BOPS_SERVER_JS")) return false;
      process.kill(pid, "SIGTERM");
      execFileSync("pkill", ["-f", ".bops/chrome/"]);
    }
  } catch {
    return false;
  }
  return true;
}

/*
 * The Mac previews, popped out: a small window that floats over every app and every Space. Drag it
 * by its bar, resize it; closing it puts the previews back in the corner of Bops.
 */
ipcMain.handle("mac-pip-open", () => {
  if (pipWin && !pipWin.isDestroyed()) return pipWin.focus();
  const area = screen.getDisplayMatching(mainWin?.getBounds() ?? { x: 0, y: 0, width: 1, height: 1 }).workArea;
  pipWin = new BrowserWindow({
    width: 300,
    height: 420,
    minWidth: 220,
    minHeight: 180,
    x: area.x + area.width - 320,
    y: area.y + 60,
    frame: false,
    resizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: "#F2F2F0",
    title: IS_WINDOWS ? "Your PC" : "Your Mac",
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  pipWin.setAlwaysOnTop(true, "floating");
  if (!IS_WINDOWS) pipWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void pipWin.loadURL(`${URL}/pip`);
  pipWin.on("closed", () => (pipWin = undefined));
});
ipcMain.handle("mac-pip-close", () => pipWin?.close());
ipcMain.handle("mac-show-main", () => {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
});

/*
 * New versions. Bops doesn't update itself: it asks bops.bot for the newest release
 * (download/latest.json, written by scripts/download-publish.sh) at launch and every hour, and while
 * there's a newer one than this app the page shows a notice (components/app/update-notice.tsx) that
 * sends the user to bops.bot, with what's new in it when the file says (its "notes", a few short
 * lines; an older file has none). Only release builds ask. Nothing here throws or shows an error: what
 * goes wrong is only logged, in ~/Library/Logs/Bops/updates.log (each change once, not every hour).
 */
const LATEST_URL = "https://bops.bot/download/latest.json";
const SITE_URL = "https://bops.bot";
const dismissedFile = () => path.join(app.getPath("userData"), "update-dismissed.json");
// The newer release bops.bot offers ({ version: "0.0.11", notes: ["…"] }), if any.
let newer;
let lastNote = "";

function updateNote(text) {
  if (text === lastNote) return;
  lastNote = text;
  console.log(`[update] ${text}`);
  try {
    fs.mkdirSync(app.getPath("logs"), { recursive: true });
    fs.appendFileSync(path.join(app.getPath("logs"), "updates.log"), `${new Date().toISOString()} ${text}\n`);
  } catch {}
}

/** "1.2.3" (a leading v and anything after the third number aside) as numbers, or null. */
function versionParts(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? "").trim());
  return m ? m.slice(1).map(Number) : null;
}
function isNewer(theirs, ours) {
  const a = versionParts(theirs);
  const b = versionParts(ours);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function dismissedVersion() {
  try {
    return JSON.parse(fs.readFileSync(dismissedFile(), "utf8")).version;
  } catch {
    return undefined;
  }
}
/** latest.json's notes as the notice shows them: up to five non-empty lines, none when it has no list. */
function releaseNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes
    .filter((n) => typeof n === "string")
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 5);
}

/** What the page shows: the newer version and what's new in it, unless the user put its notice away. */
const updateInfo = () => (newer && newer.version !== dismissedVersion() ? newer : null);

async function checkForUpdate() {
  try {
    const res = await fetch(LATEST_URL, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return updateNote(`couldn't check: ${LATEST_URL} answered ${res.status}`);
    // Caddy sends it as an attachment, which fetch doesn't mind; parsed from the text whatever its type.
    const latest = JSON.parse(await res.text());
    const version = String(latest?.version ?? "");
    if (!versionParts(version)) return updateNote(`couldn't check: no version in ${LATEST_URL}`);
    const found = isNewer(version, app.getVersion()) ? { version, notes: releaseNotes(latest.notes) } : undefined;
    updateNote(found ? `Bops ${version} is out (this is ${app.getVersion()})` : `up to date (${app.getVersion()}, bops.bot has ${version})`);
    // The page hears again only when the version or what's said about it changes.
    if (JSON.stringify(found) === JSON.stringify(newer)) return;
    newer = found;
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("update", updateInfo());
  } catch (e) {
    updateNote(`couldn't check: ${e?.message ?? e}`);
  }
}

ipcMain.handle("update-info", () => updateInfo());
ipcMain.handle("update-dismiss", (_, version) => {
  if (typeof version !== "string" || !versionParts(version)) return;
  try {
    fs.writeFileSync(dismissedFile(), JSON.stringify({ version, at: Date.now() }));
  } catch {}
});
ipcMain.handle("update-download", () => shell.openExternal(SITE_URL));

app.setName("Bops");
app.whenReady().then(() => {
  if (process.platform === "darwin" && fs.existsSync(ICON)) app.dock.setIcon(nativeImage.createFromPath(ICON));
  // Release builds only: not `npm run app`, nor a build that runs the source folder (desktop/repo.json).
  if (!IS_WINDOWS && app.isPackaged && !fs.existsSync(path.join(__dirname, "repo.json"))) {
    void checkForUpdate();
    setInterval(() => void checkForUpdate(), 60 * 60_000);
  }
  void createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && void createWindow());
});

app.on("window-all-closed", () => app.quit());

/** Stops the server Bops started (and the bots' browsers). Says whether there was one. */
function stopServer() {
  if (!server) return false;
  try {
    if (IS_WINDOWS) execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-server.pid);
  } catch {}
  server = undefined;
  if (!IS_WINDOWS) {
    try { execFileSync("pkill", ["-f", ".bops/chrome/"]); } catch {}
  }
  return true;
}

app.on("will-quit", () => void stopServer());
