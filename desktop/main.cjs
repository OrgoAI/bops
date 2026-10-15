/**
 * Bops for Mac. A native window around the Bops app: it starts the app's local server if one
 * isn't already running, opens the window with the Mac title bar from the design, and on quit
 * stops what it started, including the bots' background browsers.
 */
const { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, Notification, screen, session, shell, systemPreferences } = require("electron");
const { execFile, execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { startRenderService } = require("./render.cjs");

const PORT = 3210;
const URL = `http://localhost:${PORT}`;
/*
 * The server listens on 127.0.0.1 only. "localhost" can also mean ::1, where another account on this
 * Mac could listen and pass health on to the real server; so this app's own calls go to 127.0.0.1,
 * and the window, which keeps its localhost address, is told localhost is 127.0.0.1.
 */
const LOCAL = `http://127.0.0.1:${PORT}`;
// Bops' port only: other localhost pages (a dev server in a tab) still reach ::1.
app.commandLine.appendSwitch("host-resolver-rules", `MAP localhost:${PORT} 127.0.0.1:${PORT}`);

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
/**
 * Where the server asks this app to read a page in a browser (desktop/render.cjs): a socket in Bops'
 * Application Support folder, readable by this user only, the same each start (so a server found running
 * from an earlier start reaches it too). A path too long for a socket goes in this user's own temp folder.
 */
function renderSocket() {
  const file = path.join(app.getPath("userData"), "render.sock");
  return Buffer.byteLength(file) < 100 ? file : path.join(os.tmpdir(), "bops-render.sock");
}
let renderService;

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

/**
 * Startup and other trouble the window can't show, for support: ~/Library/Logs/Bops/main.log (the
 * server's own output is in server.log). Never throws.
 */
function mainLog(text) {
  try {
    fs.mkdirSync(app.getPath("logs"), { recursive: true });
    const file = path.join(app.getPath("logs"), "main.log");
    // Starts over once it passes 5 MB, like server.log.
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 5 * 1024 * 1024) fs.writeFileSync(file, "");
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A command's output, or null when it fails or takes over `timeout` ms. Never blocks the window. */
const output = (file, args, timeout = 3000) =>
  new Promise((resolve) => execFile(file, args, { timeout, killSignal: "SIGKILL" }, (err, out) => resolve(err ? null : String(out))));

/*
 * Apps opened from Finder get a bare PATH; borrow the login shell's so node and codex resolve. Asked
 * without blocking the window and cut off hard: an interactive zsh ignores the SIGTERM a plain
 * timeout sends, so a slow or stuck ~/.zshrc used to hold Bops on its splash for as long as it ran.
 * The PATH comes between markers, so what an rc file prints (a banner, a notice) stays out of it, and
 * it's taken as soon as it arrives, even when the rc left a background job holding the output open.
 * Asked once per launch; a server started again later uses the same.
 */
const FALLBACK_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const PATH_MARK = "__BOPS_PATH__";
let shellPath;
/** The login shell still being asked, so quitting can stop it. */
let pathProbe;
function loginPath() {
  shellPath ??= new Promise((resolve) => {
    const fallback = [...new Set([...(process.env.PATH ?? "").split(":").filter(Boolean), ...FALLBACK_PATH])].join(":");
    let out = "";
    let done = false;
    const finish = (found, why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (why) mainLog(`login shell PATH: ${why}; using ${fallback}`);
      resolve(found ?? fallback);
    };
    // In a process group of its own, so a stuck one goes with what its rc started.
    const sh = spawn(process.env.SHELL || "/bin/zsh", ["-ilc", `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    pathProbe = sh;
    const timer = setTimeout(() => {
      try {
        process.kill(-sh.pid, "SIGKILL");
      } catch {}
      finish(null, "took over 4s");
    }, 4000);
    const take = (d) => {
      out += d;
      const between = new RegExp(`${PATH_MARK}([^\\n]*?)${PATH_MARK}`).exec(out)?.[1];
      if (between === undefined) return;
      // Only absolute folders: an rc's unset variable leaves an empty entry ("$UNSET:$PATH").
      const dirs = [...new Set(between.split(":").filter((d) => d.startsWith("/")))];
      // Still drained: a background job the rc started may write to it later, and a closed pipe would kill it.
      sh.stdout.off("data", take);
      sh.stdout.resume();
      finish(dirs.length ? dirs.join(":") : null, dirs.length ? null : "no folders in its PATH");
    };
    sh.stdout.on("data", take);
    sh.once("error", (e) => finish(null, e.message));
    sh.once("exit", (code) => {
      pathProbe = undefined;
      setTimeout(() => finish(null, `exited with ${code} and no PATH`), 200);
    });
  });
  return shellPath;
}

/** Something listens on the port: a server still loading, one on its way out, or another program. Only a refused connection means free. */
function portTaken() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => (s.destroy(), resolve(true)));
  });
}

/** A release build: it runs the server it carries, not `next dev` from a source folder. */
const isRelease = () => app.isPackaged && !fs.existsSync(path.join(__dirname, "repo.json"));

/** This build's id (Next's BUILD_ID, which the server it carries reports too), or null when it can't be read. Read each time: the app's files can be replaced while it runs. */
function ourBuild() {
  try {
    return fs.readFileSync(path.join(process.resourcesPath, "server", ".next", "BUILD_ID"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** Where the bundled server runs: ~/Library/Application Support/Bops/server. */
const serverHome = () => path.join(app.getPath("userData"), "server");

/*
 * Who answers on the port. Only our own server will do: it proves it was started with this window's
 * token (an HMAC of a fresh nonce, app/api/health/route.ts; a mark anyone could read and replay
 * wouldn't do), and in a release it runs this very build from this very app. Anything else answering
 * there used to be taken as Bops all the same, and left the window stuck: another copy's server
 * whose files were replaced since (its pages ask for scripts that are gone), or one with another
 * token (every call refused, "Loading Bops…" for good). A Bops server on its way out says so (503).
 */
async function whoAnswers() {
  const nonce = crypto.randomBytes(16).toString("hex");
  let res;
  try {
    res = await fetch(`${LOCAL}/api/health?nonce=${nonce}`, { signal: AbortSignal.timeout(1500) });
  } catch {
    return { up: false };
  }
  const health = await res.json().catch(() => null);
  if (res.status === 503 && health?.bops && health.stopping) return { up: false, stopping: true };
  if (!res.ok || !health?.bops) return { up: true, bops: false };
  // A development server: as before, any Bops will do.
  if (!isRelease()) return { up: true, bops: true, mine: true };
  const want = crypto.createHmac("sha256", windowToken()).update(nonce).digest("hex");
  const proven = typeof health.proof === "string" && /^[0-9a-f]{64}$/.test(health.proof) && crypto.timingSafeEqual(Buffer.from(health.proof, "hex"), Buffer.from(want, "hex"));
  const build = ourBuild();
  const why =
    health.proof === undefined
      ? "a Bops from before 0.0.27"
      : !proven
        ? "started for another window"
        : build && health.build !== build
          ? `build ${health.build}, this app's is ${build}`
          : health.exe && realpath(health.exe) !== realpath(nodeBinary())
            ? `runs from ${health.exe}`
            : null;
  return { up: true, bops: true, mine: !why, why, version: health.version };
}

/**
 * The process listening on the port, as the system sees it (not as whatever answers there says):
 * its id, name, user, parent and folder. Null when there's none, or it can't be seen (another user's).
 */
async function listener() {
  const out = (await output("lsof", ["-b", "-w", "-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-Fpc"])) ?? "";
  // One entry per process ("p<pid>" then "c<name>"); a port can have more than one (127.0.0.1 and ::1).
  const found = [...out.matchAll(/^p(\d+)\n(?:c(.*))?/gm)].map((m) => ({ pid: Number(m[1]), name: m[2] || "a program" })).filter((l) => l.pid > 1);
  const all = [];
  for (const { pid, name } of found.slice(0, 3)) {
    const ps = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(((await output("ps", ["-p", String(pid), "-o", "uid=,ppid=,comm="])) ?? "").trim());
    const home = /^n(.+)$/m.exec((await output("lsof", ["-b", "-w", "-a", "-p", String(pid), "-d", "cwd", "-Fn"])) ?? "")?.[1];
    all.push({ pid, name, uid: ps ? Number(ps[1]) : undefined, ppid: ps ? Number(ps[2]) : undefined, comm: ps?.[3] ?? "", home });
  }
  return all.find((l) => stoppable(l)) ?? all[0] ?? null;
}

/** "Docker (pid 812)", for the trouble page and the log. */
const named = (l) => (l ? `${l.name} (pid ${l.pid})` : null);

/** A Bops server by its process: Next renames its process ("next-server (v16…)"), and before that it's the Helper. */
const looksLikeBops = (l) => !!l && (l.comm.startsWith("next-server") || l.comm.includes("Bops Helper"));

/*
 * A server Bops may stop: a Bops server of this user's, running in this Mac's Application Support,
 * and either started by this app or left behind by one that's gone (its parent is launchd). One a
 * Bops that's still open is using is never stopped (the single instance lock below keeps a second
 * copy from opening, but an old copy from before it can still be open).
 */
const stoppable = (l) =>
  looksLikeBops(l) && l.uid === process.getuid() && !!l.home && realpath(l.home) === realpath(serverHome()) && (l.ppid === 1 || l.ppid === process.pid);

/**
 * Stops a server by its process group (its bots' tools with it): SIGINT first, which lets one in the
 * middle of its last save to Bops Cloud finish it (up to 5s, lib/server/persist.ts), then SIGKILL.
 * Waits for the process to end as well as the port (one stuck before it listened holds none).
 * Resolves whether the port is free.
 */
async function stopProcess(pid) {
  const running = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e?.code === "EPERM";
    }
  };
  const holding = async () => running() || (await portTaken());
  const kill = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {}
    }
  };
  kill("SIGINT");
  for (let i = 0; i < 28 && (await holding()); i++) await sleep(250);
  if (await holding()) {
    mainLog(`pid ${pid} still running 7s after SIGINT: SIGKILL`);
    kill("SIGKILL");
  }
  for (let i = 0; i < 20 && (await holding()); i++) await sleep(250);
  const free = !(await portTaken());
  if (!free) mainLog(`the port is still taken after stopping pid ${pid}`);
  return free;
}

/*
 * Where the server runs from. A release build carries a prebuilt server (Next's standalone output,
 * copied to Resources/server by electron-builder) and runs it with the app's own Node. A build made
 * with `npm run app:build` (desktop/repo.json) or `npm run app` runs `next dev` in the source folder.
 */
function packagedServer() {
  if (!isRelease()) return null;
  const dir = path.join(process.resourcesPath, "server");
  if (!fs.existsSync(path.join(dir, "server.js"))) return null;
  // The app bundle is read-only (and sealed by its signature), but the server keeps its state in
  // .data/ under its working folder and reads vm/ and node_modules/ from there. So it runs in
  // ~/Library/Application Support/Bops/server, where everything but .data links into the bundle.
  const home = serverHome();
  fs.mkdirSync(path.join(home, ".data"), { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name === ".data" || name.startsWith(".env")) continue;
    const link = path.join(home, name);
    const st = fs.lstatSync(link, { throwIfNoEntry: false });
    if (st && !st.isSymbolicLink()) continue;
    if (st && fs.readlinkSync(link) === path.join(dir, name)) continue;
    if (st) fs.unlinkSync(link);
    fs.symlinkSync(path.join(dir, name), link);
  }
  // Settings for this Mac (self-hosting, testing) go in ~/Library/Application Support/Bops/.env.local;
  // the app itself ships with no keys.
  let env = {};
  try {
    env = require("node:util").parseEnv(fs.readFileSync(path.join(app.getPath("userData"), ".env.local"), "utf8"));
  } catch {}
  const relay = path.join(process.resourcesPath, "bin", "orgo-relay");
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

/** How the server we started ended, while it hasn't been replaced: "exited with code 1", "stopped by SIGKILL". */
let serverEnded;
/** Quitting or restarting: the server going away then is expected. */
let leaving = false;
/** A server of ours this app found running (left by a Bops that quit badly) and uses: watched, and stopped on quit, like one it started. */
let adopted;
/** Our server being stopped because it never answered: killed outright if Bops quits meanwhile (it has nothing to save). */
let lettingGo;

async function spawnServer() {
  const packaged = packagedServer();
  const PATH = await loginPath();
  if (leaving) {
    if (packaged) fs.closeSync(packaged.log);
    return;
  }
  serverEnded = undefined;
  const child = packaged
    ? // Run as Node by the app's Helper binary (LSUIElement), not the app's own: run by the app's
      // binary, macOS listed the server in the Dock as a second app ("exec"). server.js changes into
      // its folder on start; keeping the working folder in Application Support is what lets the
      // server write its state.
      spawn(nodeBinary(), ["-e", "process.chdir = () => {}; require(process.env.BOPS_SERVER_JS)"], {
        cwd: packaged.home,
        env: {
          ...process.env,
          ...packaged.env,
          PATH,
          ELECTRON_RUN_AS_NODE: "1",
          BOPS_SERVER_JS: path.join(packaged.dir, "server.js"),
          NODE_ENV: "production",
          // The server exits on SIGTERM itself, after its last work (the state saved to Bops Cloud, or self-hosted to its file).
          NEXT_MANUAL_SIG_HANDLE: "true",
          PORT: String(PORT),
          BOPS_UI_TOKEN: windowToken(),
          BOPS_RENDER_SOCKET: renderSocket(),
          // Only this Mac can reach the bundled server, unless its settings say BOPS_LISTEN_ALL=1:
          // bot computers' app calls and phone webhooks reach Bops over the tailnet, so they need
          // it (proxy.ts then lets other addresses reach only those paths).
          HOSTNAME: packaged.env.BOPS_LISTEN_ALL === "1" ? "0.0.0.0" : "127.0.0.1",
        },
        stdio: ["ignore", packaged.log, packaged.log],
        detached: true,
      })
    : spawn("npx", ["next", "dev", "--port", String(PORT)], {
        cwd: REPO,
        env: { ...process.env, PATH, BOPS_UI_TOKEN: windowToken(), BOPS_RENDER_SOCKET: renderSocket() },
        stdio: "ignore",
        detached: true,
      });
  if (packaged) fs.closeSync(packaged.log);
  server = child;
  // A server that can't start, or stops later, is noticed now, not after a long wait on its port.
  child.once("error", (e) => {
    serverEnded = `couldn't start: ${e.message}`;
    mainLog(`server ${serverEnded}`);
    if (server === child) server = undefined;
  });
  child.once("exit", (code, signal) => {
    // Only the current server's end counts: one Bops stopped on purpose was let go first.
    if (server !== child) return;
    serverEnded = signal ? `stopped by ${signal}` : `exited with code ${code}`;
    server = undefined;
    if (leaving) return;
    mainLog(`server (pid ${child.pid}) ${serverEnded}`);
    void serverGone();
  });
}

/**
 * Watches a server this app found running and uses, which it has no exit event for: when it goes,
 * Bops starts its own. Only one that's ours to stop (`ours`) is stopped on quit (`adopted`).
 */
let adoptedWatch;
let found;
function watchAdopted(pid, ours = false) {
  clearInterval(adoptedWatch);
  found = pid;
  adopted = pid && ours ? pid : undefined;
  if (!pid) return;
  adoptedWatch = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e?.code === "EPERM") return;
      clearInterval(adoptedWatch);
      if (found !== pid) return;
      found = adopted = undefined;
      serverEnded = "went away";
      if (leaving) return;
      mainLog(`server (pid ${pid}) went away`);
      void serverGone();
    }
  }, 2000);
}

/*
 * Has our own server answering on the port, or says why it can't. Waits against a deadline, and
 * looks at what holds the port each time round:
 * - our server answering: done;
 * - an old Bops server of this user's (a Bops that quit badly; perhaps a since replaced copy): stopped, and ours started;
 * - another Bops (one still open, another user's) or another program answering there: we can't use the port;
 * - the port taken by a program that isn't Bops and doesn't answer: the same, right away;
 * - the port taken by a Bops server that doesn't answer (starting, on its way out, or stuck): wait, then stop it if it may be stopped;
 * - the port free: start ours (again, if it stopped).
 */
const START_MS = 60_000;
const SILENT_MS = 15_000;
/** One start at a time, whichever window asks. */
let ensuring;
const ensureServer = () => (ensuring ??= startOrFind().finally(() => (ensuring = undefined)));
async function startOrFind() {
  const started = Date.now();
  let spawned = 0;
  let stopped = false;
  let silentSince = 0;
  for (;;) {
    if (leaving) return { ok: false, reason: "error", detail: "Bops is quitting" };
    const who = await whoAnswers();
    if (who.up && who.mine) {
      // One found running: watched, and stopped on quit, only when it's ours to stop.
      const l = server ? null : await listener();
      watchAdopted(isRelease() && l ? l.pid : undefined, stoppable(l));
      mainLog(`server answering after ${((Date.now() - started) / 1000).toFixed(1)}s${found ? ` (one already running, pid ${found}${adopted ? "" : ", not ours to stop"})` : ""}`);
      return { ok: true };
    }
    if (who.up) {
      const l = await listener();
      if (!stopped && stoppable(l)) {
        stopped = true;
        mainLog(`an old Bops server (pid ${l.pid}, ${who.why ?? "not Bops"}) holds the port: stopping it`);
        if (await stopProcess(l.pid)) continue;
      }
      mainLog(`port ${PORT} answered by ${who.bops ? `another Bops (${who.why})` : "something else"}: ${named(l) ?? "unknown"}`);
      return { ok: false, reason: who.bops ? "other-bops" : "port-taken", detail: named(l) };
    }
    if (!(await portTaken())) {
      silentSince = 0;
      if (!server) {
        if (spawned >= 2) return { ok: false, reason: "server-ended", detail: serverEnded };
        spawned++;
        mainLog(spawned === 1 ? "starting the server" : `starting the server again (it ${serverEnded ?? "stopped"})`);
        await spawnServer();
      }
    } else if (isRelease() && !server) {
      // Taken by something we didn't start, and nothing answers. Not Bops at all: say so now. A Bops
      // server: give it a while (it may be starting, or saving on its way out), then stop it if it's
      // ours to stop, or say so if it isn't. (Our own server starting is just waited on.)
      const l = await listener();
      if (l && !looksLikeBops(l)) {
        mainLog(`port ${PORT} held by ${named(l)}, which isn't Bops${who.stopping ? " (it answers as a Bops on its way out)" : " and doesn't answer"}`);
        return { ok: false, reason: "port-taken", detail: named(l) };
      }
      if (!silentSince) {
        silentSince = started;
        mainLog(`port ${PORT} held by ${named(l) ?? "a program Bops can't see"}${who.stopping ? ", a Bops on its way out" : ", not answering"}: waiting`);
      }
      if (!stopped && l && Date.now() - silentSince > SILENT_MS) {
        if (!stoppable(l)) {
          const why = l.uid !== process.getuid() ? "another user's" : realpath(l.home ?? "") !== realpath(serverHome()) ? `it runs in ${l.home ?? "a folder Bops can't see"}` : `its parent is pid ${l.ppid}`;
          mainLog(`${named(l)} hasn't answered in ${SILENT_MS / 1000}s and isn't ours to stop (${why})`);
          return { ok: false, reason: "other-bops", detail: named(l) };
        }
        stopped = true;
        mainLog(`the Bops server (pid ${l.pid}) holds the port but hasn't answered in ${SILENT_MS / 1000}s: stopping it`);
        await stopProcess(l.pid);
        continue;
      }
    }
    if (Date.now() - started > START_MS) {
      if (!server && (await portTaken())) {
        const l = await listener();
        mainLog(`no server after ${START_MS / 1000}s, port held by ${named(l) ?? "a program Bops can't see"}`);
        return { ok: false, reason: looksLikeBops(l) || !l ? "other-bops" : "port-taken", detail: named(l) };
      }
      mainLog(`no server after ${START_MS / 1000}s${serverEnded ? ` (it ${serverEnded})` : ""}`);
      // Ours never answered (stuck before it listened, say): stopped, so Try again starts a new one.
      if (server) {
        const child = server;
        server = undefined;
        serverEnded = "never answered";
        mainLog(`our server (pid ${child.pid}) never answered: stopping it`);
        lettingGo = child.pid;
        await stopProcess(child.pid);
        lettingGo = undefined;
      }
      return { ok: false, reason: "server-slow", detail: serverEnded };
    }
    await sleep(500);
  }
}

/** Boppy bopping to music while the server starts (desktop/splash.html). */
const SPLASH = path.join(__dirname, "splash.html");
/** What the window shows when Bops can't start, with Try again (desktop/trouble.html). */
const TROUBLE = path.join(__dirname, "trouble.html");

/** When the server stopped or the page failed lately, to tell one that keeps failing from one that failed once. */
let failures = [];

/*
 * Starts the server if it isn't ours and running, then shows the app; or what went wrong, never a
 * blank window. One at a time per window. Trouble that comes while the app's page is loading (the
 * server going, the load failing) is kept and taken care of once this open is done, not dropped.
 */
let opening;
let openingWin;
/** What went while an open was under way ("server", "page" or "load"), taken care of when it's done. */
let goneWhileOpening = null;
function openApp(win) {
  if (opening && openingWin === win) return opening;
  openingWin = win;
  const run = (async () => {
    let failed = false;
    try {
      const result = await ensureServer().catch((e) => ({ ok: false, reason: "error", detail: e?.message ?? String(e) }));
      // What happened to a server before ours answered was ensureServer's to handle.
      goneWhileOpening = null;
      if (win.isDestroyed()) return;
      if (!result.ok) return showTrouble(win, result);
      await giveWindowToken();
      // A load that fails is tried again from the start (below); one that never finishes says so.
      const loaded = await Promise.race([
        win.loadURL(URL).then(
          () => true,
          (e) => {
            if (e?.code !== "ERR_ABORTED") failed = true;
            return true;
          },
        ),
        sleep(30_000).then(() => false),
      ]);
      // A page that crashed reports its load failed a few ms before the crash itself: wait for that
      // report, so the incident is told as a crash, and once.
      if (failed && goneWhileOpening !== "page" && !win.isDestroyed()) {
        const wc = win.webContents;
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            wc.off("render-process-gone", done);
            resolve();
          };
          const timer = setTimeout(done, 500);
          wc.on("render-process-gone", done);
        });
      }
      if (!loaded && !win.isDestroyed()) {
        mainLog("the app's page took over 30s to load");
        goneWhileOpening = null;
        win.webContents.stop();
        showTrouble(win, { reason: "server-slow" });
      }
    } finally {
      if (opening === run) opening = openingWin = undefined;
      const what = goneWhileOpening ?? (failed ? "load" : null);
      goneWhileOpening = null;
      if (what && !win.isDestroyed() && !leaving) setImmediate(() => void serverGone(what));
    }
  })();
  opening = run;
  return run;
}

/** What the trouble page said last, to say again if the page itself crashes. */
let lastTrouble;
function showTrouble(win, { reason, detail }) {
  lastTrouble = { reason, detail };
  mainLog(`showing trouble: ${reason}${detail ? ` (${detail})` : ""}`);
  if (win.isDestroyed()) return;
  void win.loadFile(TROUBLE, { query: { reason, detail: detail ?? "", logs: app.getPath("logs") } }).catch(() => {});
}

/*
 * The server stopped, or the app's page didn't load or its renderer went: start again from the
 * splash, once per incident (an open under way takes it on). More than three in two minutes, and
 * the window says Bops keeps stopping instead of trying forever.
 */
let reopening = false;
const GONE_RANK = { load: 0, server: 1, page: 2 };
/** How the window's page last went: "crashed (5)". */
let lastPageGone;
async function serverGone(what = "server") {
  const win = mainWin;
  if (!win || win.isDestroyed() || leaving) return;
  if (opening && openingWin === win) {
    // A crashed page says more than a stopped server, which says more than the failed load it causes.
    if (goneWhileOpening == null || GONE_RANK[what] > GONE_RANK[goneWhileOpening]) goneWhileOpening = what;
    return;
  }
  if (reopening) return;
  reopening = true;
  try {
    const now = Date.now();
    failures = failures.filter((t) => now - t < 120_000);
    failures.push(now);
    if (failures.length > 3) {
      // Saying so already: not again (a page that can't run would go round and round), unless the
      // trouble page itself crashed, a few times at most.
      const showing = win.webContents.getURL().startsWith(pathToFileURL(TROUBLE).href);
      if (!showing) {
        const reason = { page: "page-crashed", load: "page-failed" }[what] ?? "server-crashed";
        return showTrouble(win, { reason, detail: what === "page" ? lastPageGone : what === "load" ? null : serverEnded });
      }
      if (!win.webContents.isCrashed()) return;
      // The trouble page itself crashed: the same words again, a few times; then a dialog, which needs no page.
      if (failures.length <= 8) return showTrouble(win, lastTrouble ?? { reason: "page-crashed", detail: lastPageGone });
      mainLog("the trouble page keeps crashing: asking in a dialog");
      const { response } = await dialog.showMessageBox(win, { type: "warning", message: "Bops' window keeps crashing", detail: `Try again, and if it happens again, send us the logs (${app.getPath("logs")}).`, buttons: ["Try again", "Quit"], defaultId: 0, cancelId: 1 });
      mainLog(`dialog: ${response === 1 ? "Quit" : "Try again"}`);
      if (response === 1) return app.quit();
      failures = [];
      await win.loadFile(SPLASH).catch(() => {});
      await openApp(win);
      return;
    }
    await win.loadFile(SPLASH).catch(() => {});
    await openApp(win);
  } finally {
    reopening = false;
  }
}

ipcMain.handle("startup-retry", async () => {
  mainLog("Try again");
  failures = [];
  if (!mainWin || mainWin.isDestroyed()) return;
  if (opening && openingWin === mainWin) return opening;
  await mainWin.loadFile(SPLASH).catch(() => {});
  await openApp(mainWin);
});
ipcMain.handle("startup-logs", () => shell.openPath(app.getPath("logs")));

/** Brings the Bops window forward, or opens it again when it was closed (the Mac previews' window can outlive it). */
function showMain() {
  if (!mainWin || mainWin.isDestroyed()) return void createWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1180,
    minHeight: 640,
    title: "Bops",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
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
  // The app's page didn't load (the server went away between its health and the page, say), or its
  // renderer crashed: try again from the start, never a blank window.
  win.webContents.on("did-fail-load", (_, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !url.startsWith(URL) || leaving) return;
    mainLog(`the app's page didn't load: ${description} (${code})`);
    void serverGone("load");
  });
  win.webContents.on("render-process-gone", (_, details) => {
    if (leaving || details.reason === "clean-exit") return;
    lastPageGone = `${details.reason} (${details.exitCode})`;
    mainLog(`the window's page crashed: ${lastPageGone}`);
    // A page that can't start at all would only go round: it's logged, and that's all.
    if (details.reason === "launch-failed") return;
    // During an open, the open takes it on (its load fails too); otherwise a moment later.
    if (opening && openingWin === win) return void serverGone("page");
    setTimeout(() => void serverGone("page"), 1000);
  });
  await win.loadFile(SPLASH).catch(() => {});
  await openApp(win);
}

/*
 * The tabs' sessions (persist:bops-web-<user>) answer what a page may use. Electron says yes to everything
 * unless told otherwise; a site in a tab never gets to read the clipboard (a key copied in the Vault sits
 * there for a minute) or reach USB, HID, serial or MIDI devices. The rest stays as a browser has it.
 */
const TAB_DENIED = new Set(["clipboard-read", "hid", "serial", "usb", "midi", "midiSysex"]);
const fencedTabs = new WeakSet();
function fenceTabSession(s) {
  if (fencedTabs.has(s)) return;
  fencedTabs.add(s);
  s.setPermissionRequestHandler((_wc, permission, callback) => callback(!TAB_DENIED.has(permission)));
  s.setPermissionCheckHandler((_wc, permission) => !TAB_DENIED.has(permission));
  s.setDevicePermissionHandler(() => false);
}

// A page in a tab that opens a new window opens it in your browser instead.
app.on("web-contents-created", (_, contents) => {
  if (contents.getType() !== "webview") return;
  fenceTabSession(contents.session);
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
});

/*
 * A key copied in the Vault (components/app/keys.tsx). On the Mac it's marked concealed and transient
 * (nspasteboard.org), so clipboard managers skip it, and kept to this Mac, so Universal Clipboard doesn't
 * send it to your iPhone. The value goes to osascript on stdin, never in its arguments. After a minute it's
 * cleared if it's still there; here, unlike the page, that works with the window in the background.
 */
const SECRET_CLIPBOARD_MS = 60_000;
const COPY_CONCEALED = `ObjC.import("AppKit");
const text = $.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding);
const pb = $.NSPasteboard.generalPasteboard;
pb.prepareForNewContentsWithOptions(1);
pb.setStringForType(text, "public.utf8-plain-text");
pb.setDataForType($.NSData.data, "org.nspasteboard.ConcealedType");
pb.setDataForType($.NSData.data, "org.nspasteboard.TransientType");
"ok";`;
let secretClear;
const copyConcealed = (value) =>
  new Promise((resolve) => {
    const child = execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", COPY_CONCEALED], { timeout: 5000, killSignal: "SIGKILL" }, (err, out) => resolve(!err && String(out).trim() === "ok"));
    child.stdin?.end(value);
  });
ipcMain.handle("copy-secret", async (_, value) => {
  if (typeof value !== "string" || !value) return false;
  const ok = process.platform === "darwin" ? await copyConcealed(value) : (clipboard.writeText(value), true);
  if (!ok) return false;
  clearTimeout(secretClear);
  secretClear = setTimeout(() => {
    if (clipboard.readText() === value) clipboard.clear();
  }, SECRET_CLIPBOARD_MS);
  return true;
});

/*
 * Skills on this Mac (lib/server/workspace-skills.ts): a folder picked in Finder to import as a skill (only
 * its path goes to the page; Bops' own server reads it), and a skill's folder shown in Finder. Only a
 * folder under a workspaces folder Bops keeps skills in is shown, never any other path the page names.
 */
ipcMain.handle("pick-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const r = await dialog.showOpenDialog(win, { title: "Import a skill", buttonLabel: "Import", properties: ["openDirectory"] });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});
/** The real path of a folder the page may show: under a Bops data folder's workspaces (no "..", no link out), and never a bundle such as an .app. */
function skillFolderToShow(dir) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) return null;
  let real;
  try {
    real = fs.realpathSync(dir);
    if (!fs.statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  const roots = [path.join(serverHome(), ".data"), path.join(REPO, ".data")].flatMap((r) => {
    try {
      return [fs.realpathSync(r)];
    } catch {
      return [];
    }
  });
  const under = roots.some((r) => real.startsWith(r + path.sep) && path.relative(r, real).split(path.sep).includes("workspaces"));
  if (!under || real.split(path.sep).some((seg) => /\.(app|bundle|framework|plugin|kext|prefPane|appex|workflow|pkg|mpkg)$/i.test(seg))) return null;
  return real;
}
ipcMain.handle("reveal-folder", async (_, dir) => {
  const real = skillFolderToShow(dir);
  if (!real) return false;
  return (await shell.openPath(real)) === "";
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
  // The Bops window itself (a page being read in a hidden window is a window too).
  const win = mainWin && !mainWin.isDestroyed() ? mainWin : BrowserWindow.getAllWindows().find((w) => w.isVisible());
  const bopsOn = win ? String(screen.getDisplayMatching(win.getBounds()).id) : undefined;
  if (access !== "granted") return { access, displays, sources: [], bopsOn };
  const list = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
  return { access, displays, bopsOn, sources: list.map((s) => ({ id: s.id, name: s.name, displayId: s.display_id || undefined })) };
});
ipcMain.handle("mac-screen-settings", () => shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"));

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
ipcMain.handle("perm-settings", (_, id) => (PANES[id] ? shell.openExternal(PANES[id]) : undefined));
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
    mainLog("Restart Bops");
    let pid;
    // A server that doesn't answer isn't asked (that only waited out the 20s).
    const who = await whoAnswers();
    if (who.up && who.mine)
      try {
        const res = await fetch(`${LOCAL}/api/restart`, { method: "POST", headers: { "x-bops-window": windowToken() }, signal: AbortSignal.timeout(20_000) });
        pid = (await res.json()).pid;
      } catch (e) {
        mainLog(`restart: the server didn't let go cleanly: ${e?.message ?? e}`);
      }
    else mainLog(`restart: ${who.up ? "the server answering isn't this Bops'" : "the server isn't answering"}`);
    leaving = true;
    // Wait for the port to close (its last save gets up to 5s), so the new Bops starts its own server
    // instead of finding the old one still answering and then losing it. One that won't let go is
    // stopped hard.
    if (stopServer() || (await stopOtherServer(pid))) for (let i = 0; i < 28 && (await portTaken()); i++) await sleep(250);
    if (await portTaken()) {
      const l = await listener();
      if (stoppable(l)) {
        mainLog(`restart: the server (pid ${l.pid}) still holds the port: SIGKILL`);
        try {
          process.kill(-l.pid, "SIGKILL");
        } catch {
          try {
            process.kill(l.pid, "SIGKILL");
          } catch {}
        }
        for (let i = 0; i < 20 && (await portTaken()); i++) await sleep(250);
      }
    }
    app.relaunch();
    app.exit(0);
  })();
  return restarting;
}
ipcMain.handle("relaunch", () => restart());

/** Stops a release build's server this app didn't start (the one on the port, which gave this process id if it answered), once it's surely Bops' own. Says whether it did. */
async function stopOtherServer(pid) {
  if (!isRelease()) return false;
  const l = await listener();
  if (!stoppable(l) || (pid && l.pid !== pid)) return false;
  try {
    process.kill(-l.pid, "SIGTERM");
  } catch {
    try {
      process.kill(l.pid, "SIGTERM");
    } catch {
      return false;
    }
  }
  try {
    execFileSync("pkill", ["-f", ".bops/chrome/"]);
  } catch {}
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
    title: "Your Mac",
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  pipWin.setAlwaysOnTop(true, "floating");
  pipWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void pipWin.loadURL(`${URL}/pip`);
  pipWin.on("closed", () => (pipWin = undefined));
});
ipcMain.handle("mac-pip-close", () => pipWin?.close());
ipcMain.handle("mac-show-main", () => showMain());

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
/*
 * One Bops at a time. Every copy shares the same Application Support folder and server, so a second
 * one (another copy opened from a download, say) brings the first to the front and closes, instead
 * of the two fighting over the server.
 */
const first = app.requestSingleInstanceLock();
if (!first) {
  // `npm run app` shares the installed app's folder: say why it closed.
  if (!app.isPackaged) console.error("Bops is already open (the installed app, or another npm run app). Quit it to run this one.");
  app.quit();
}
app.on("second-instance", () => app.isReady() && showMain());
app.whenReady().then(() => {
  if (!first) return;
  mainLog(`Bops ${app.getVersion()} opening (pid ${process.pid})`);
  if (process.platform === "darwin" && fs.existsSync(ICON)) app.dock.setIcon(nativeImage.createFromPath(ICON));
  // Release builds only: not `npm run app`, nor a build that runs the source folder (desktop/repo.json).
  if (isRelease()) {
    void checkForUpdate();
    setInterval(() => void checkForUpdate(), 60 * 60_000);
  }
  // Pages the server can't read with a plain fetch (one that draws itself, one that checks for a human), read in a hidden window.
  try {
    renderService = startRenderService({ socketPath: renderSocket(), token: windowToken(), log: mainLog });
  } catch (e) {
    mainLog(`render service didn't start: ${e?.message ?? e}`);
  }
  void createWindow();
  app.on("activate", () => showMain());
});

app.on("window-all-closed", () => app.quit());

/** Stops the server Bops started or uses (and the bots' browsers). Says whether there was one. */
function stopServer() {
  const pid = server?.pid ?? adopted;
  if (!pid) return false;
  server = undefined;
  watchAdopted(undefined);
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  try {
    execFileSync("pkill", ["-f", ".bops/chrome/"]);
  } catch {}
  return true;
}

app.on("will-quit", () => {
  leaving = true;
  renderService?.close();
  if (lettingGo)
    try {
      process.kill(-lettingGo, "SIGKILL");
    } catch {
      try {
        process.kill(lettingGo, "SIGKILL");
      } catch {}
    }
  const pid = server?.pid ?? adopted;
  // A server too stuck to act on SIGTERM would outlive Bops: stopped hard once its exit work's 8s are up.
  if (stopServer() && pid)
    try {
      spawn("/bin/sh", ["-c", `sleep 10; kill -KILL -${pid} 2>/dev/null || kill -KILL ${pid} 2>/dev/null`], { detached: true, stdio: "ignore" }).unref();
    } catch {}
  // A login shell still being asked for its PATH (a stuck ~/.zshrc) goes too.
  if (pathProbe)
    try {
      process.kill(-pathProbe.pid, "SIGKILL");
    } catch {}
});
