import "server-only";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { DISPLAYS } from "@/lib/types";
import { executorKey } from "./cloud";
import { codexPath, findCodex } from "./codex-cli";
import { codexInSandbox, installDir, remotePort, SANDBOX_EXEC, sandboxArgs } from "./executor-sandbox";
import { closeMirrors, mirroredTarget } from "./mirror";
import { userChrome, userHome } from "./store";
import { bopsHome, chromeRoot } from "./user-paths";

/**
 * Local Mac host. Each bot's "screen" is its own background Chrome on the user's Mac, with its own
 * profile and debugging port, so sessions browse from their home IP instead of a datacenter.
 * It runs headless (no windows on their screen; the app's live view shows it) and the agent
 * drives it through Playwright MCP over CDP, so it never takes their mouse.
 * Set BOPS_CHROME_WINDOWS=1 to see the windows instead.
 *
 * Each Orgo user's bots have their own profiles (their cookies, their sign-ins on sites), under
 * ~/.bops/chrome/<user>/, and their Mac tasks their own folders (~/.bops/users/<user>/tasks): another
 * account signed in on this Mac never gets them, and a Chrome left running for one account is closed
 * before another's bot uses its port.
 */

const WINDOWS = process.platform === "win32";
export const CHROME = process.env.BOPS_CHROME_PATH || (
  WINDOWS
    ? [
        process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
        process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
        process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
      ].find((p) => p && existsSync(p)) || ""
    : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
);
/**
 * Where the signed-in user's Mac tasks keep their folders: ~/.bops/users/<id>/tasks, beside their
 * Chrome profiles' own folder (~/.bops/tasks on a self-hosted install running on its own key). Signed
 * out on the Mac app there is none, and no task runs.
 */
export function tasksRoot() {
  const home = userHome();
  if (!home) throw new Error("Sign in to Bops first.");
  return join(home, "tasks");
}
/**
 * Each Mac task's own folder (<tasks>/<session>): its workspace, Codex home and temp files. It's the
 * only place the task's executor can write (executor-sandbox.ts), made fresh when the executor starts
 * and removed when it stops. It's under the user's own, so another account signed in on this Mac never
 * gets what a task left (Codex keeps the task's conversation in its home).
 */
export const taskDir = (sessionId: string) => join(tasksRoot(), sessionId);
/**
 * Where a Mac task's browser tools keep their sockets (~/.bops/s/<hash of its folder>). Playwright puts
 * them in the temp folder by default, and the task's (<tasks>/<session>/tmp) is too deep for a Unix
 * socket's path (104 bytes on macOS): the browser tools failed to start. Made and removed with the folder.
 */
export const taskSockets = (dir: string) => join(/*turbopackIgnore: true*/ bopsHome(), "s", createHash("sha256").update(dir).digest("hex").slice(0, 12));
/** A Mac task's workspace: the agent session's workspace_directory, and where its browser tools run. */
export const taskWorkspace = (sessionId: string) => join(taskDir(sessionId), "workspace");
const CHROME_VERSION = (() => {
  if (WINDOWS) return "154.0.0.0";
  try { return execFileSync("defaults", ["read", "/Applications/Google Chrome.app/Contents/Info", "CFBundleShortVersionString"]).toString().trim(); }
  catch { return "154.0.0.0"; }
})();
/** Headless Chrome announces itself as "HeadlessChrome"; present as the normal Mac browser. */
const USER_AGENT = `Mozilla/5.0 (${WINDOWS ? "Windows NT 10.0; Win64; x64" : "Macintosh; Intel Mac OS X 10_15_7"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION.split(".")[0]}.0.0.0 Safari/537.36`;
const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
/** The browser tools' package folder, at its real path: in the app, the server's node_modules links into the app bundle. */
const nodeModules = () => real(join(process.cwd(), "node_modules"));

/** One port per bot screen: 9300 + 10 per bot + screen index. */
export const cdpPort = (botIndex: number, display: number) => 9300 + botIndex * 10 + DISPLAYS.indexOf(display);

/**
 * The port of a bot's Chrome for a task on the user's Mac (Session.macScreen 0 to 2): after its screens'
 * ports, so it never shares a Chrome with them, whether this Mac hosts the bots' screens or Orgo does.
 */
export const macTaskPort = (botIndex: number, slot: number) => 9300 + botIndex * 10 + DISPLAYS.length + slot;

async function cdpUp(port: number) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

/** Whose bots' Chromes are running now: the profile folder they were started from. */
const RUNNING_FOR = () => join(chromeRoot(), ".running-for");
const runningFor = () => {
  try {
    return readFileSync(RUNNING_FOR(), "utf8");
  } catch {
    return "";
  }
};

/** How many times the bots' Chromes were closed for a sign-out or a sign-in (quitBotChromes): one being started across that isn't started. */
const gq = globalThis as unknown as { bopsChromeQuits?: number };
const quits = () => gq.bopsChromeQuits ?? 0;

/**
 * Close every bot's Chrome on this Mac (a sign-out, or another account signing in): they hold one
 * account's cookies, and a running one would be picked up again by whichever bot uses its port next.
 */
export async function quitBotChromes({ switching = true } = {}) {
  // A sign-out or another account's sign-in (not a Chrome left from one, closed to start this user's).
  if (switching) gq.bopsChromeQuits = quits() + 1;
  // The screens' mirrors keep the last page they saw: they go too.
  closeMirrors();
  const pattern = `--user-data-dir=${chromeRoot()}/`;
  if (WINDOWS) {
    // Stop only browser processes with profiles under Bops' managed root.
    const script = "$root=[Console]::In.ReadToEnd().Trim();Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -like ('*--user-data-dir='+$root+'*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    await new Promise<void>((resolve) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.once("close", () => resolve());
      child.once("error", () => resolve());
      child.stdin.end(chromeRoot());
    });
    return;
  }
  const running = () => new Promise<boolean>((r) => execFile("pgrep", ["-f", "--", pattern], (e) => r(!e)));
  if (!(await running())) return;
  await new Promise((r) => execFile("pkill", ["-f", "--", pattern], () => r(null)));
  for (let i = 0; i < 20 && (await running()); i++) await new Promise((r) => setTimeout(r, 150));
}

/** Start the screen's Chrome if it isn't already running (for this user: one left running for another account closes first). */
export async function ensureChrome(botId: string, port: number) {
  const dir = userChrome();
  if (!dir) throw new Error("Sign in to Bops first.");
  const closes = quits();
  if (await cdpUp(port)) {
    if (runningFor() === dir) return;
    await quitBotChromes({ switching: false });
  }
  // The Chromes were closed meanwhile (a sign-out, or another account signing in): one started now
  // for this user would keep running, with their cookies, into the next account's.
  if (closes !== quits() || userChrome() !== dir) throw new Error("Bops is switching accounts.");
  mkdirSync(dir, { recursive: true });
  writeFileSync(RUNNING_FOR(), dir);
  const profile = join(dir, `${botId}-${port}`);
  mkdirSync(profile, { recursive: true });
  if (!CHROME) throw new Error("Chrome/Edge was not found. Set BOPS_CHROME_PATH in the local environment.");
  spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-crash-restore-bubble",
      "--window-size=1280,860",
      ...(process.env.BOPS_CHROME_WINDOWS ? [] : ["--headless=new", `--user-agent=${USER_AGENT}`]),
      "about:blank",
    ],
    { detached: !WINDOWS, stdio: "ignore", windowsHide: true },
  )
    // No Chrome here: the wait below says so, rather than the server going down with it.
    .on("error", () => {})
    .unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpUp(port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome on port ${port} didn't start`);
}

/**
 * In the Mac app the server runs as Node through the app's own binary (desktop/main.cjs), so
 * anything it starts with process.execPath must carry ELECTRON_RUN_AS_NODE, or it opens Bops again.
 */
export const asNode = process.env.ELECTRON_RUN_AS_NODE === "1";

/**
 * The browser tools a Mac task may call: Playwright MCP's, but for browser_run_code_unsafe, which runs
 * any JavaScript in the tools' own process (it reaches Node, so the Mac, not just the page).
 */
export const MAC_BROWSER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_drop",
  "browser_find",
  "browser_tabs",
  "browser_wait_for",
  "browser_handle_dialog",
  "browser_take_screenshot",
  "browser_evaluate",
  "browser_console_messages",
  "browser_network_requests",
  "browser_network_request",
  "browser_file_upload",
  "browser_emulate_media",
  "browser_resize",
  "browser_close",
];

/** The agent's browser tools for one screen, run by the executor on this Mac, in the workspace of the task's folder (`dir`). */
export const browserMcp = (port: number, dir: string) => {
  const args = [join(nodeModules(), "@playwright/mcp/cli.js"), "--cdp-endpoint", `http://127.0.0.1:${port}`];
  // The executor's environment doesn't reach its MCP servers (Codex passes on a few variables), so
  // ELECTRON_RUN_AS_NODE and the sockets folder are set here.
  // Never this server's own pages (it's on the same Mac): what bots mustn't change is also kept behind the
  // Bops window's token (ui-token.ts), since this list doesn't hold against redirects.
  const self = process.env.PORT ?? "3210";
  const blocked = `PLAYWRIGHT_MCP_BLOCKED_ORIGINS=http://localhost:${self};http://127.0.0.1:${self};http://[::1]:${self}`;
  const env = [`PWTEST_SOCKETS_DIR=${taskSockets(dir)}`, blocked, ...(asNode ? ["ELECTRON_RUN_AS_NODE=1"] : [])];
  if (WINDOWS) return { type: "stdio", command: process.execPath, args, cwd: join(dir, "workspace"), env: Object.fromEntries(env.map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)])) };
  return { type: "stdio", command: "/usr/bin/env", args: [...env, process.execPath, ...args], cwd: join(dir, "workspace") };
};

/**
 * Cua Driver (cua.ai): how a task with Full access sees and uses the user's own apps and browsers, the
 * windows on their Mac, in the background: it reads a window (its accessibility tree and a picture of
 * it) and clicks and types into it without moving their pointer or bringing it to the front. Its
 * permissions (Accessibility, Screen Recording) are CuaDriver.app's own: `cua-driver mcp` hands each
 * call to its daemon. mac-windows.ts uses it for the window previews too.
 */
export const CUA_DRIVER = process.env.CUA_DRIVER_PATH ?? join(homedir(), ".local/bin/cua-driver");
export const cuaDriverHere = () => existsSync(CUA_DRIVER);
/**
 * Seeing and using windows (a browser's too: its pages are in the accessibility tree), and `page` to read a
 * tab's text. Not what moves the user's pointer, fronts or quits apps, touches the clipboard or changes
 * Cua's settings, nor Cua's browser_* tools: they need DevTools set up on the user's own browser, and share
 * names with the task's browser tools (its own Chrome). Nor drag, which Cua only does in front of the user.
 * vm/mac-ui-mcp.mjs keeps the same list, and holds what's passed on to these.
 */
export const MAC_UI_TOOLS = [
  "list_apps",
  "list_windows",
  "get_window_state",
  "verify_state",
  "launch_app",
  "invoke_menu",
  "click",
  "double_click",
  "right_click",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "scroll",
  "zoom",
  "page",
];
/** The script a Mac task's tools reach Cua Driver through, which passes on only what a task may do (vm/mac-ui-mcp.mjs). */
const macUiScript = () => real(join(process.cwd(), "vm/mac-ui-mcp.mjs"));
/**
 * The Mac tools for a task with Full access, run by its executor: Cua Driver behind Bops' own MCP server
 * (vm/mac-ui-mcp.mjs), not `cua-driver mcp` itself. Cua's tools reach any window and take any arguments;
 * that script keeps a task's tool calls off Bops itself (its chats, payment approvals and settings),
 * System Settings, Keychain Access, password managers, terminals, remote sessions and the like, works in
 * the background only, and refuses quitting, closing, the clipboard, a page's JavaScript and a browser's
 * debugging port. It's a second layer, not what protects Bops: the same task has a shell as the user,
 * which can run cua-driver itself or reach Bops' own server (the window's token is in a file the user's
 * processes can read). Payment approvals, "Just do it" and turning on Full access need a check outside a
 * task's reach (Touch ID or the user's password) before the proxy can be relied on for them.
 */
export const macUiMcp = (dir: string) => ({
  type: "stdio",
  command: "/usr/bin/env",
  args: [...(asNode ? ["ELECTRON_RUN_AS_NODE=1"] : []), process.execPath, macUiScript(), "--cua", CUA_DRIVER],
  cwd: join(dir, "workspace"),
});

/** The script that serves a Mac task the user's apps (find_app_actions, use_app), and the socket it reaches Bops by (composio.ts serveApps). */
const appsScript = () => real(join(process.cwd(), "vm/apps-mcp.mjs"));
export const appsSocket = (dir: string) => join(taskSockets(dir), "apps.sock");

/** The agent's app tools for a Mac task, run by the executor on this Mac like its browser tools: the user's apps, business data (treg.ts), or both. */
export const appsMcp = (dir: string, has: { apps: boolean; data: boolean }) => ({
  type: "stdio",
  command: "/usr/bin/env",
  args: [...(asNode ? ["ELECTRON_RUN_AS_NODE=1"] : []), process.execPath, appsScript(), "--socket", appsSocket(dir), ...(has.apps ? ["--apps"] : []), ...(has.data ? ["--data"] : [])],
  cwd: join(dir, "workspace"),
});

/** What the executor's environment keeps of the server's: nothing secret, nothing that only makes the server run. */
const KEPT_ENV = ["USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE"];

/**
 * How to start `codex exec-server` for a Mac task: inside the macOS sandbox (executor-sandbox.ts), so
 * neither it nor anything it starts can run a shell or another program, read the user's files, write
 * outside the task's folder or script other apps. It may start Codex itself and what runs the browser
 * tools (this server's Node, through /usr/bin/env in the app). The task's folder is its home, Codex
 * home (Bops' own, never the user's ~/.codex) and temp folder, and its environment is only what it
 * needs: Bops' executor key, not the server's.
 *
 * With `fullAccess` (Full access on this Mac, MacState.fullAccess) there's no sandbox: Codex runs as the
 * user, with their home, a shell and every program on the Mac (osascript, open, shortcuts…), so the
 * agent can use their files and apps. Its Codex home and temp folder are still the task's own, and its
 * environment still carries nothing of the server's.
 */
export function executorCommand(sessionId: string, codex: string, args: string[], opts: { key: string; cdpPort: number; remotePort: number; dir?: string; fullAccess?: boolean }) {
  const dir = opts.dir ?? taskDir(sessionId);
  if (opts.fullAccess) {
    const env: Record<string, string> = Object.fromEntries(KEPT_ENV.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
    const path = [...new Set([...codexPath().split(delimiter), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(delimiter);
    Object.assign(env, { PATH: path, HOME: homedir(), TMPDIR: join(dir, "tmp"), CODEX_HOME: join(dir, "codex"), CODEX_API_KEY: opts.key, BOPS_CDP_PORT: String(opts.cdpPort) });
    return { command: codexInSandbox(codex, path).command, args, cwd: join(dir, "workspace"), env: env as NodeJS.ProcessEnv };
  }
  const run = codexInSandbox(codex, codexPath());
  const box = {
    taskDir: dir,
    sockets: taskSockets(dir),
    programs: [...run.programs, process.execPath, "/usr/bin/env"],
    readable: [...run.readable, installDir(process.execPath), nodeModules(), appsScript()],
    remotePort: opts.remotePort,
    cdpPort: opts.cdpPort,
  };
  const env: Record<string, string> = Object.fromEntries(KEPT_ENV.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
  Object.assign(env, { PATH: codexPath(), HOME: dir, TMPDIR: join(dir, "tmp"), CODEX_HOME: join(dir, "codex"), CODEX_API_KEY: opts.key, BOPS_CDP_PORT: String(opts.cdpPort) });
  return { command: SANDBOX_EXEC, args: sandboxArgs(box, [run.command, ...args]), cwd: join(dir, "workspace"), env: env as NodeJS.ProcessEnv };
}

/** A fresh folder for a Mac task (whatever an earlier run of it left is gone). */
export function prepareTaskDir(sessionId: string, dir = taskDir(sessionId)) {
  rmSync(dir, { recursive: true, force: true });
  rmSync(taskSockets(dir), { recursive: true, force: true });
  for (const sub of ["workspace/capabilities/skills", "codex", "tmp"]) mkdirSync(join(/*turbopackIgnore: true*/ dir, sub), { recursive: true, mode: 0o700 });
  mkdirSync(taskSockets(dir), { recursive: true, mode: 0o700 });
}

/**
 * Start `codex exec-server` for one Mac task; it dials out to OpenAI and runs the agent's tools here,
 * in the sandbox (executorCommand), or without it with `fullAccess`. It runs on Bops' executor key alone (CODEX_API_KEY, from Bops Cloud),
 * so Codex never uses the user's ChatGPT sign-in or their Codex settings for it.
 */
export async function startExecutor(sessionId: string, envId: string, remoteUrl: string, port: number, dir = taskDir(sessionId), fullAccess = false): Promise<ChildProcess> {
  if (WINDOWS) throw new Error("Local Codex executor sandbox is not available on Windows v0.0.24 yet; use an Orgo cloud computer. Bops will not start an unrestricted shell on your PC.");
  if (!fullAccess && !existsSync(SANDBOX_EXEC)) throw new Error("this Mac has no sandbox for bots (/usr/bin/sandbox-exec)");
  const codex = findCodex();
  if (!codex) throw new Error("the Codex CLI isn't on this Mac yet");
  prepareTaskDir(sessionId, dir);
  const run = executorCommand(sessionId, codex, ["exec-server", "--remote", remoteUrl, "--environment-id", envId], {
    key: await executorKey(),
    cdpPort: port,
    remotePort: remotePort(remoteUrl),
    dir,
    fullAccess,
  });
  const child = spawn(run.command, run.args, { cwd: run.cwd, env: run.env, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let log = "";
    const onData = (d: Buffer) => {
      log += d.toString();
      if (/error/i.test(log)) {
        child.kill();
        reject(new Error(`executor failed: ${log.slice(0, 200)}`));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`executor exited (${code}): ${log.slice(0, 200)}`)));
    // Mirrors the Orgo path: no error within a few seconds means it connected.
    setTimeout(() => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      resolve(child);
    }, 3000);
  });
}

/**
 * Stop a Mac task's executor, if it's running (killed outright if it's still there 5 seconds on), and
 * remove the task's folder. At once, not when it has exited: by then the thread may be running again
 * in a fresh folder at the same place.
 */
export function stopExecutor(sessionId: string, child?: ChildProcess, dir?: string) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const kill = setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    child.once("exit", () => clearTimeout(kill));
    child.kill();
  }
  // The folder it was started in (`dir`), else the signed-in user's: signed out there's none to find.
  let folder = dir;
  try {
    folder ??= taskDir(sessionId);
  } catch {
    return;
  }
  rmSync(folder, { recursive: true, force: true });
  rmSync(taskSockets(folder), { recursive: true, force: true });
}

/** A screen's Chrome: a port on this Mac, or "host:port" anywhere reachable (an Orgo computer on the tailnet). */
export type Endpoint = number | string;
const hostPort = (ep: Endpoint) => (typeof ep === "number" ? `127.0.0.1:${ep}` : ep);

type PageTarget = { id: string; type: string; url: string; title: string; webSocketDebuggerUrl: string };

/** One DevTools command on one page target. */
async function cdpOn<T>(base: string, page: PageTarget, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const ws = new WebSocket(page.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${base}`));
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as { id?: number; result?: T; error?: { message: string } };
        if (msg.id !== 1) return;
        clearTimeout(timer);
        if (msg.result) resolve(msg.result);
        else reject(new Error(msg.error?.message ?? `${method} failed`));
      };
      ws.onerror = () => reject(new Error("CDP connection failed"));
    });
  } finally {
    ws.close();
  }
}

/** A screen's open tabs (not Chrome's own pages). */
async function screenPages(base: string) {
  const targets = (await (await fetch(`http://${base}/json/list`, { signal: AbortSignal.timeout(3000) })).json()) as PageTarget[];
  return targets.filter((t) => t.type === "page" && !/^(devtools|chrome-extension|chrome):/.test(t.url));
}

/** A screen's open tabs, by id and address. */
export const openPages = async (ep: Endpoint) => (await screenPages(hostPort(ep))).map((t) => ({ id: t.id, url: t.url }));

/** Tabs a vault sign-in is working in, by screen: every read and keystroke on that screen goes there meanwhile. */
const pinned = new Map<string, string>();
/** Run `fn` with this tab of the screen as the one reads and input go to (onTab), whichever is on screen. */
export async function onTab<T>(ep: Endpoint, targetId: string, fn: () => Promise<T>): Promise<T> {
  const base = hostPort(ep);
  pinned.set(base, targetId);
  try {
    return await fn();
  } finally {
    if (pinned.get(base) === targetId) pinned.delete(base);
  }
}

/**
 * The tab that's on screen: one a sign-in is working in (onTab), the one the mirror follows, else whichever
 * Chrome reports visible. A pinned tab that's gone fails rather than fall back: what was meant for it (a
 * password) never goes to another tab.
 */
async function screenPage(base: string): Promise<PageTarget> {
  const pages = await screenPages(base);
  if (!pages.length) throw new Error("no page");
  const pin = pinned.get(base);
  if (pin) {
    const p = pages.find((t) => t.id === pin);
    if (!p) throw new Error("that tab is gone");
    return p;
  }
  const followed = pages.find((t) => t.id === mirroredTarget(base));
  if (followed || pages.length === 1) return followed ?? pages[0];
  const states = await Promise.all(
    pages.map((p) => cdpOn<{ result: { value?: string } }>(base, p, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }).catch(() => null)),
  );
  return pages.find((_, i) => states[i]?.result?.value === "visible") ?? pages[0];
}

/** Send one DevTools command to the screen's tab (the one on screen). */
async function cdp<T>(ep: Endpoint, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const base = hostPort(ep);
  return cdpOn<T>(base, await screenPage(base), method, params);
}

/** A JPEG of the screen's active tab, captured over CDP. */
export async function screenshot(ep: Endpoint, quality = 60): Promise<ArrayBuffer> {
  const { data } = await cdp<{ data: string }>(ep, "Page.captureScreenshot", { format: "jpeg", quality });
  return Uint8Array.from(Buffer.from(data, "base64")).buffer;
}

export async function viewport(ep: Endpoint) {
  const m = await cdp<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>(ep, "Page.getLayoutMetrics");
  return { width: m.cssVisualViewport.clientWidth, height: m.cssVisualViewport.clientHeight };
}

/** What the screen's page says, as text for quick judgments: address, title, visible text and form fields. */
export async function pageText(ep: Endpoint) {
  // Fields include rich-text boxes (an email body is a contenteditable div). Each field and button
  // is tagged so a Bops card can fill or press exactly that one later. Values never leave the page.
  const expression = `JSON.stringify((() => {
    const visible = (el) => el.offsetParent !== null && !el.disabled;
    const label = (el) => (el.labels?.[0]?.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || "").trim() || undefined;
    const fields = [...document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true], [contenteditable=''], [role=textbox]")]
      .filter((el) => visible(el) && !el.closest("[data-bops-skip]") && !(el.getAttribute("role") === "textbox" && el.querySelector("input,textarea")))
      .slice(0, 24)
      .map((el, i) => {
        el.setAttribute("data-bops-field", "f" + i);
        const rich = el.isContentEditable;
        return { id: "f" + i, type: rich ? "richtext" : el.type, name: el.name || undefined, autocomplete: el.autocomplete || undefined, placeholder: el.placeholder || undefined, label: label(el) };
      });
    const buttons = [...document.querySelectorAll("button, [role=button], input[type=submit], input[type=button], a[role=button]")]
      .filter((el) => visible(el))
      .map((el) => ({ el, text: (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("data-tooltip") || "").replace(/\\s+/g, " ").trim() }))
      .filter((b) => b.text && b.text.length <= 60)
      .slice(0, 40)
      .map((b, i) => {
        b.el.setAttribute("data-bops-button", "b" + i);
        return { id: "b" + i, text: b.text };
      });
    return {
      url: location.href,
      title: document.title,
      text: (document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 3000),
      fields,
      buttons,
    };
  })())`;
  // Read from one tab, named in the answer: a card or the vault fills that tab, never whichever is on screen by then.
  const base = hostPort(ep);
  const tab = await screenPage(base);
  const r = await cdpOn<{ result: { value?: string } }>(base, tab, "Runtime.evaluate", { expression, returnByValue: true });
  return { ...(JSON.parse(r.result.value ?? "{}") as { url: string; title: string; text: string; fields: PageField[]; buttons: PageButton[] }), targetId: tab.id };
}

/** A page's visible text line by line (lists, inboxes and feeds keep their rows), for watching it. */
export async function pageLines(ep: Endpoint) {
  const expression = `JSON.stringify({ url: location.href, title: document.title, text: (document.body?.innerText ?? "").slice(0, 8000) })`;
  const r = await cdp<{ result: { value?: string } }>(ep, "Runtime.evaluate", { expression, returnByValue: true });
  const page = JSON.parse(r.result.value ?? "{}") as { url: string; title: string; text: string };
  const lines = [...new Set((page.text ?? "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()))].filter((l) => l.length >= 3 && l.length <= 200);
  return { url: page.url ?? "", title: page.title ?? "", lines };
}

export type PageField = { id: string; type: string; name?: string; autocomplete?: string; placeholder?: string; label?: string };
export type PageButton = { id: string; text: string };

const tag = (id: string) => id.replace(/[^a-z0-9]/gi, "");

/**
 * Type into one tagged field (see pageText), replacing what's there. The value goes straight to the page,
 * and only on `host` (the site the field was read on): a page that's somewhere else by now gets nothing.
 */
export async function fillField(ep: Endpoint, fieldId: string, value: string, host: string) {
  const r = await cdp<{ result: { value?: boolean } }>(ep, "Runtime.evaluate", {
    expression: `(() => { if (location.hostname !== ${JSON.stringify(host)}) return false; const el = document.querySelector('[data-bops-field="${tag(fieldId)}"]'); if (!el) return false; el.focus();
      if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
      else el.select?.();
      return true; })()`,
    returnByValue: true,
  });
  if (!r.result.value) throw new Error("that field is gone from the page");
  await cdp(ep, "Input.insertText", { text: value });
}

/** The current text of tagged fields, for a card that shows the user what the bot wrote (never sent to a model). */
export async function fieldValues(ep: Endpoint, fieldIds: string[]) {
  const r = await cdp<{ result: { value?: string } }>(ep, "Runtime.evaluate", {
    expression: `JSON.stringify(Object.fromEntries(${JSON.stringify(fieldIds.map(tag))}.map((id) => { const el = document.querySelector('[data-bops-field="' + id + '"]'); return [id, el ? (el.isContentEditable ? el.innerText : el.value) : null]; })))`,
    returnByValue: true,
  });
  return JSON.parse(r.result.value ?? "{}") as Record<string, string | null>;
}

/** Press one tagged button (see pageText). */
export async function pressButton(ep: Endpoint, buttonId: string) {
  const r = await cdp<{ result: { value?: boolean } }>(ep, "Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector('[data-bops-button="${tag(buttonId)}"]'); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`,
    returnByValue: true,
  });
  if (!r.result.value) throw new Error("that button is gone from the page");
}

/**
 * The page as a clean article for the reader view: its title, and the headings, paragraphs, list
 * items, quotes and images of its main content, in order.
 */
export async function readerText(ep: Endpoint) {
  const expression = `JSON.stringify((() => {
    const pick = () => {
      const cands = [...document.querySelectorAll("article, main, [role=main], #content, .content, #bodyContent, .post, .entry-content")];
      const best = cands.sort((a, b) => b.innerText.length - a.innerText.length)[0];
      return best && best.innerText.length > 400 ? best : document.body;
    };
    const root = pick();
    const blocks = [];
    for (const el of root.querySelectorAll("h1, h2, h3, p, li, blockquote, pre, img")) {
      if (el.closest("nav, header, footer, aside, form, [role=navigation], [aria-hidden=true], .navbox, .reflist, .mw-editsection")) continue;
      if (el.tagName === "IMG") {
        const w = el.naturalWidth || el.width;
        if (w >= 220 && el.src.startsWith("http")) blocks.push({ kind: "img", src: el.src, alt: el.alt || "" });
        continue;
      }
      if (el.tagName === "LI" && el.closest("li") !== el && el.parentElement.closest("li")) continue;
      const text = el.innerText.replace(/\\s+/g, " ").trim();
      if (!text || (el.tagName === "P" && text.length < 30)) continue;
      if (blocks.length && blocks[blocks.length - 1].text === text) continue;
      blocks.push({ kind: el.tagName.toLowerCase(), text: text.slice(0, 2000) });
      if (blocks.length > 160) break;
    }
    const site = document.querySelector('meta[property="og:site_name"]')?.content || location.hostname.replace(/^www\\./, "");
    return { url: location.href, title: document.querySelector("h1")?.innerText?.trim() || document.title, site, blocks };
  })())`;
  const r = await cdp<{ result: { value?: string } }>(ep, "Runtime.evaluate", { expression, returnByValue: true });
  return JSON.parse(r.result.value ?? "{}") as { url: string; title: string; site: string; blocks: { kind: string; text?: string; src?: string; alt?: string }[] };
}

/**
 * The page on screen, by address and title: the tab the mirror follows (screenPage), not the first
 * Chrome lists. With the bot's pages each in a window of its own, the first could be one it left long
 * ago, and a watch got named for a page from an earlier task.
 */
export async function currentPage(ep: Endpoint) {
  const page = await screenPage(hostPort(ep)).catch(() => null);
  return page ? { url: page.url, title: page.title } : null;
}

export async function currentUrl(ep: Endpoint) {
  const targets = (await (await fetch(`http://${hostPort(ep)}/json/list`, { signal: AbortSignal.timeout(2000) })).json()) as { type: string; url: string }[];
  return targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"))?.url ?? "";
}

/** Load an address on the screen. Headless screens have no address bar, so the app supplies one. */
export async function navigate(ep: Endpoint, url: string) {
  const to = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
  const base = hostPort(ep);
  const page = await screenPage(base).catch(() => null);
  if (page) return cdpOn(base, page, "Page.navigate", { url: to });
  // On its home screen the screen only has the new tab page, which doesn't answer DevTools commands
  // (an extension draws it): open the address as a new tab and close the home one, so it stays one tab.
  const targets = (await (await fetch(`http://${base}/json/list`, { signal: AbortSignal.timeout(3000) })).json()) as PageTarget[];
  const homes = targets.filter((t) => t.type === "page" && t.url.startsWith("chrome://newtab"));
  const res = await fetch(`http://${base}/json/new?${to}`, { method: "PUT", signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`couldn't open ${to}`);
  for (const h of homes) await fetch(`http://${base}/json/close/${h.id}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
}

/** The user's input on a screen when they take over: a click, typed text, or a key. */
export async function input(
  ep: Endpoint,
  action: { kind: "click"; x: number; y: number } | { kind: "scroll"; x: number; y: number; dy: number } | { kind: "type"; text: string } | { kind: "key"; key: string },
) {
  if (action.kind === "scroll") await cdp(ep, "Input.dispatchMouseEvent", { type: "mouseWheel", x: action.x, y: action.y, deltaX: 0, deltaY: action.dy });
  else if (action.kind === "click") {
    for (const type of ["mousePressed", "mouseReleased"])
      await cdp(ep, "Input.dispatchMouseEvent", { type, x: action.x, y: action.y, button: "left", clickCount: 1 });
  } else if (action.kind === "type") await cdp(ep, "Input.insertText", { text: action.text });
  else {
    const keys: Record<string, { key: string; code: string; keyCode: number }> = {
      Return: { key: "Enter", code: "Enter", keyCode: 13 },
      BackSpace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      Tab: { key: "Tab", code: "Tab", keyCode: 9 },
      Escape: { key: "Escape", code: "Escape", keyCode: 27 },
      Up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      Down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      Left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      Right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    };
    const k = keys[action.key];
    if (!k) return;
    // Enter needs a real keyDown carrying its text, or forms won't submit; other keys are raw.
    const enter = k.key === "Enter";
    for (const type of [enter ? "keyDown" : "rawKeyDown", "keyUp"])
      await cdp(ep, "Input.dispatchKeyEvent", { type, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, ...(enter && type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}) });
  }
}
