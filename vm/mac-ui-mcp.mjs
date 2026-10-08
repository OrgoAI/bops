#!/usr/bin/env node
// The user's own apps and windows for a Bops task on their Mac with Full access: a small MCP server
// (stdio) that the task's executor starts in place of `cua-driver mcp` (lib/server/local.ts macUiMcp).
// It runs Cua Driver's own MCP server and passes on only what a task may do with it, since Cua's tools
// reach any window and take any arguments:
// - Some apps are off limits, hidden from the lists and refused as a target (by name, by bundle id and by
//   the app bundles the process runs from): Bops itself and its helpers (its window holds every chat,
//   payment approvals and its settings), Cua Driver, System Settings and the system's password and
//   permission prompts, Keychain Access and Passwords, password managers, terminals (and editors, script
//   and automation apps that run commands), remote sessions (remote desktop, SSH, VM consoles), AI agent
//   apps, clipboard managers, and the system utilities that quit or erase things (Activity Monitor, Disk Utility).
// - Every call that reads or acts on a window names it (pid and window_id, from list_windows), and the
//   window has to be that app's. Input goes in the background only (delivery_mode background): never in
//   front of the user, never their pointer. No drag (Cua only drags in front), no screen-wide clicks.
// - No quitting, closing, copying, cutting or pasting, by shortcut, by menu (in the languages macOS
//   commonly runs in) or by a menu item found in a window, and nothing from the Apple menu. A page is
//   only read (get_text, query_dom): no JavaScript in it, nothing that turns on JavaScript from Apple
//   Events. An app is launched without a command line or a debugging port. Arguments of the wrong type
//   are refused, not passed on.
// This is a second layer, for a task that stays on its tools. It isn't what protects Bops: a task with Full
// access also has a shell, as the user, which can run cua-driver itself or reach Bops' own server. What
// protects payment approvals, "Just do it" and Full access has to be outside the task's reach (asking for
// Touch ID or the user's password; the window's token out of a file the user's processes can read).
// Usage: node mac-ui-mcp.mjs --cua <path to cua-driver>
import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** The Cua tools a task gets (lib/server/local.ts MAC_UI_TOOLS keeps the same list). */
export const TOOLS = [
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
/** Tools that send input: in the background only. */
const INPUT = new Set(["click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll"]);
/** Tools that read or act on one window, named by pid and window_id. */
const WINDOW = new Set(TOOLS.filter((t) => !["list_apps", "list_windows", "launch_app"].includes(t)));
/** Arguments never passed on: a debug picture or screenshot written to a file anywhere. */
const DROPPED = ["debug_image_out", "screenshot_out_file"];
/** What page may do: read. */
const PAGE_READS = ["get_text", "query_dom"];
/** What launch_app keeps: which app, and pages, files or folders for it to open. */
const LAUNCH_KEEPS = ["bundle_id", "name", "urls"];

/**
 * Apps off limits: what to call it, then its names (as macOS shows them, or its bundle's name on disk)
 * and its bundle ids. Matched on the name Cua gives, and on the bundle id and name of every app bundle in
 * the path of the process (Bops' helpers live inside Bops.app; the Codex app's program is called ChatGPT).
 */
const OFF_LIMITS = [
  // Any build of Bops ("Bops", "Bops Beta", "Bops Dev", "Bops Helper (Renderer)").
  ["Bops", /^(bops\b.*|electron(\s+helper\b.*)?)$/, /^(ai\.orgo\.bops|com\.github\.electron)(\.|$)/],
  ["Cua Driver", /^(cua ?driver|cua-driver|cua-spacesd)$/, /^com\.trycua\./],
  [
    "System Settings",
    /^(system settings|system preferences|securityagent|coreautha|universalaccessauthwarn|usernotificationcenter)$/,
    /^com\.apple\.(systempreferences|settings|securityagent|coreautha|universalaccessauthwarn|usernotificationcenter)(\.|$)/,
  ],
  ["Keychain Access", /^(keychain access|passwords)$/, /^com\.apple\.(keychainaccess|passwords)(\.|$)/],
  [
    "a password manager",
    /^(1password( \d+)?|bitwarden|dashlane|lastpass|keepassxc|keepassium|macpass|strongbox|enpass|nordpass|proton pass|roboform|keeper( password manager)?)$/,
    /(1password|agilebits|bitwarden|dashlane|lastpass|keepassxc|keepassium|macpass|strongbox|enpass|nordpass|protonpass|proton\.pass|roboform|keepersecurity)/,
  ],
  // Terminals, editors with one built in, and apps that run commands or scripts.
  [
    "a terminal",
    /^(terminal|iterm2?|warp( ?preview)?|alacritty|kitty|wezterm(-gui)?|hyper|ghostty|tabby|rio|wave|termius|script editor|automator|shortcuts|visual studio code( - insiders)?|code( - insiders)?|vscodium|codium|cursor|windsurf|zed|xcode|intellij idea.*|pycharm.*|webstorm|goland|clion|rubymine|phpstorm|rider|datagrip|rustrover|fleet|aqua|dataspell|appcode|jetbrains (gateway|toolbox)|android studio|docker( desktop)?|com\.docker\.backend|orbstack|raycast|alfred( \d+)?|launchbar|keyboard maestro.*|hammerspoon|bettertouchtool)$/,
    /^(com\.apple\.(terminal|scripteditor2|automator|shortcuts|dt\.xcode)|com\.googlecode\.iterm2|dev\.warp\.|io\.alacritty|org\.alacritty|net\.kovidgoyal\.kitty|com\.github\.wez\.wezterm|co\.zeit\.hyper|com\.mitchellh\.ghostty|org\.tabby|com\.raphaelamorim\.rio|dev\.commandline\.waveterm|com\.termius|com\.microsoft\.vscode|com\.vscodium|com\.todesktop\.230313mzl4w4u92|com\.exafunction\.windsurf|dev\.zed\.|com\.jetbrains\.|com\.google\.android\.studio|com\.docker\.|dev\.kdrag0n\.macvirt|com\.raycast\.|com\.runningwithcrayons\.alfred|at\.obdev\.launchbar|com\.stairways\.keyboardmaestro|org\.hammerspoon\.|com\.hegenberg\.bettertouchtool)/,
  ],
  // Another computer (or the user's phone) from this one: remote desktop, SSH, VM consoles.
  [
    "a remote session",
    /^(nomachine|nxplayer(\.bin)?|nxdock|screen sharing|remote desktop|microsoft remote desktop|windows app|utm|vmware fusion|parallels desktop|virtualbox(vm)?|securecrt|royal tsx|teamviewer|anydesk|jump desktop|rustdesk|vnc viewer|tigervnc.*|splashtop.*|parsec|iphone mirroring|orgo)$/,
    /^(com\.nomachine\.|com\.apple\.(screensharing|remotedesktop|screencontinuity)|com\.microsoft\.rdc\.|com\.utmapp\.|com\.vmware\.fusion|com\.parallels\.|org\.virtualbox\.|com\.vandyke\.securecrt|com\.lemonmojo\.royaltsx|com\.teamviewer\.|com\.philandro\.anydesk|com\.p5sys\.jump\.|com\.carriez\.rustdesk|com\.realvnc\.|com\.splashtop\.|tv\.parsec\.|ai\.orgo\.desktop)/,
  ],
  // Apps whose agents run commands on this Mac.
  ["an AI agent app", /^(codex|chatgpt|claude)$/, /^(com\.openai\.(codex|chat)|com\.anthropic\.)/],
  // What the user copied before: passwords and codes too.
  [
    "a clipboard manager",
    /^(paste|maccy|pastebot|copyclip( \d+)?|flycut|clipy|pastenow|jumpcut|unclutter|clipboard manager.*)$/,
    /^(com\.wiheads\.paste|org\.p0deje\.maccy|com\.tapbots\.pastebot|com\.fiplab\.copyclip|com\.generalarcade\.flycut|com\.clipy-app\.|com\.pastenow\.|net\.sf\.jumpcut|com\.eon\.unclutter)/,
  ],
  // Force quitting anything (Bops too) from a button, erasing disks, installing software.
  [
    "a system utility",
    /^(activity monitor|disk utility|installer|migration assistant|boot camp assistant|directory utility)$/,
    /^com\.apple\.(activitymonitor|diskutility|installer|migrateassistant|bootcampassistant|directoryutility)(\.|$)/,
  ],
];
/** The apps off limits, as a task is told. */
export const OFF_LIMITS_SAID = "Bops itself, System Settings, Keychain Access, password managers, terminals and apps that run commands, remote sessions, AI agent apps, clipboard managers and Activity Monitor";
/** The names any of them goes by, for a line of text that isn't JSON. */
const MENTIONS =
  /\b(bops|electron|cua ?driver|cua-driver|system settings|system preferences|securityagent|keychain access|passwords|1password|bitwarden|dashlane|lastpass|keepassxc|terminal|iterm2?|warp|alacritty|kitty|wezterm|ghostty|script editor|automator|shortcuts|visual studio code|vscodium|cursor|xcode|docker|nomachine|screen sharing|remote desktop|windows app|utm|teamviewer|anydesk|iphone mirroring|codex|chatgpt|claude|paste|maccy|activity monitor|disk utility)\b/i;

/** The app bundles a path runs from ("/Applications/Bops.app/Contents/Frameworks/Bops Helper.app/…" has two), and its program's name. */
const bundlesIn = (path) =>
  typeof path === "string" && path ? [...[...path.matchAll(/([^/]+)\.(?:app|bundle)(?=\/|$)/gi)].map((m) => m[1]), path.split("/").filter(Boolean).at(-1) ?? ""] : [];

/** The app bundle folders a path runs from, outermost first ("/Applications/Bops.app", "/Applications/Bops.app/…/Bops Helper.app"). */
export const appDirsIn = (path) => (typeof path === "string" ? [...path.matchAll(/\.app(?=\/|$)/gi)].map((m) => path.slice(0, m.index + 4)) : []);

/**
 * What makes an app off limits ("Bops", "a terminal"…), or null: by its name, its bundle id (`bundleId`,
 * or `bundleIds` for every app bundle its process runs from), or where its process runs from.
 */
export function offLimits({ name, bundleId, bundleIds, path } = {}) {
  const names = [name, ...bundlesIn(path)].filter((n) => typeof n === "string" && n.trim()).map((n) => n.toLowerCase().replace(/\.app$/, "").trim());
  const ids = [bundleId, ...(Array.isArray(bundleIds) ? bundleIds : [])].filter((x) => typeof x === "string" && x).map((x) => x.toLowerCase());
  for (const [what, byName, byId] of OFF_LIMITS) if (names.some((n) => byName.test(n)) || ids.some((id) => byId.test(id))) return what;
  return null;
}
const offLimitsWhy = (what) => `${what === "Bops" ? "Bops itself is" : `${what} is`} off limits to Bops tasks. Say so and stop if the task needs it.`;

const MODIFIERS = { cmd: "cmd", command: "cmd", "⌘": "cmd", meta: "cmd", super: "cmd", ctrl: "ctrl", control: "ctrl", "⌃": "ctrl", option: "option", opt: "option", alt: "option", "⌥": "option", shift: "shift", "⇧": "shift", fn: "fn" };
const SHORTCUTS = { q: "quitting an app", w: "closing a window or tab", c: "copying", x: "cutting", v: "pasting" };

/** What a key combination does that a task may not (quit, close, copy, cut, paste, force quit), or null. */
export function refusedKeys(keys) {
  const parts = (Array.isArray(keys) ? keys : [keys])
    .flatMap((k) => String(k ?? "").split(/\+|(?<=\w)-(?=\w)/))
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const mods = new Set(parts.map((k) => MODIFIERS[k]).filter(Boolean));
  if (!mods.has("cmd")) return null;
  for (const k of parts.filter((x) => !MODIFIERS[x])) {
    if (SHORTCUTS[k]) return SHORTCUTS[k];
    if ((k === "escape" || k === "esc") && mods.has("option")) return "force quitting apps";
  }
  return null;
}

/**
 * Menu items a task may not use, by title, in the languages macOS commonly runs in (Cua finds a menu item
 * by its title, and its key equivalent isn't in reach): quit, close, copy, cut, paste, and the system's
 * own (log out, shut down, restart, sleep, lock, settings, empty the trash). Words in scripts with spaces
 * between words are matched whole; Chinese, Japanese and Korean ones anywhere in the title.
 */
const MENU_WORDS = [
  // English
  "quit", "close", "copy", "cut", "paste", "force quit", "log ?out", "shut ?down", "restart", "sleep", "lock screen", "system settings", "system preferences", "empty trash",
  // German, French, Spanish, Italian, Portuguese
  "beenden", "schlie(?:ß|ss)en", "kopieren", "ausschneiden", "einfügen", "abmelden", "entleeren",
  "quitter", "fermer", "copier", "couper", "coller", "vider",
  "salir", "cerrar", "copiar", "cortar", "pegar", "vaciar",
  "esci", "chiudi", "copia", "taglia", "incolla", "svuota",
  "encerrar", "sair", "fechar", "colar", "esvaziar",
  // Dutch, Swedish, Norwegian, Danish, Finnish
  "sluiten", "kopiëren", "knippen", "plakken", "afsluiten",
  "avsluta", "stäng", "kopiera", "klipp ut", "klistra in",
  "avslutt", "lukk", "kopier", "sett inn",
  "afslut", "luk", "klip", "indsæt",
  "lopeta", "sulje", "kopioi", "leikkaa", "liitä",
  // Polish, Czech, Slovak, Turkish, Hungarian, Romanian, Vietnamese, Indonesian and Malay, Catalan
  "zakończ", "zamknij", "kopiuj", "wytnij", "wklej",
  "ukončit", "zavřít", "kopírovat", "vyjmout", "vložit",
  "ukončiť", "zavrieť", "kopírovať", "vystrihnúť", "vložiť",
  "çık", "kapat", "kopyala", "kes", "yapıştır",
  "kilépés", "bezárás", "másolás", "kivágás", "beillesztés",
  "ieși", "ieşi", "închide", "copiază", "decupează", "lipește",
  "thoát", "đóng", "sao chép", "cắt", "dán",
  "keluar", "tutup", "salin", "potong", "tempel",
  "surt", "tanca", "copia", "retalla", "enganxa",
  // Russian, Ukrainian, Greek, Hebrew, Arabic
  "завершить", "закрыть", "копировать", "скопировать", "вырезать", "вставить",
  "завершити", "закрити", "копіювати", "скопіювати", "вирізати", "вставити",
  "τερματισμός", "κλείσιμο", "αντιγραφή", "αποκοπή", "επικόλληση",
  "סיים", "צא", "סגור", "העתק", "גזור", "הדבק",
  "إنهاء", "إغلاق", "نسخ", "قص", "لصق",
];
const MENU_REFUSED = new RegExp(`(?<![\\p{L}\\p{N}])(?:${MENU_WORDS.join("|")})(?![\\p{L}\\p{N}])`, "iu");
/** Chinese (simplified and traditional), Japanese and Korean: quit, close, copy, cut, paste, log out. */
const MENU_REFUSED_CJK = /退出|结束|結束|关闭|關閉|拷贝|拷貝|复制|複製|剪切|剪下|粘贴|貼上|終了|閉じる|コピー|カット|ペースト|貼り付け|ログアウト|종료|닫기|복사|잘라내기|붙여넣기|로그아웃/u;
const refusedTitle = (x) => MENU_REFUSED.test(x) || MENU_REFUSED_CJK.test(x);

/** The item of a menu path a task may not use (Quit, Close Tab, Copy, Paste…, anything in the Apple menu), or null. */
export function refusedMenu(path) {
  const items = (Array.isArray(path) ? path : []).map((x) => String(x ?? "").trim());
  const hit = items.find(refusedTitle);
  if (hit) return `"${hit}"`;
  if (items.length && /^(apple|)$/i.test(items[0])) return "the Apple menu";
  return null;
}

/**
 * An element of a window a click may not press: a menu item (a context menu's Copy or Paste, an app
 * menu's Quit) whose title is one of those, or a window's close button. From the window's last
 * get_window_state; null when Bops didn't see the element (a click by position).
 */
export function refusedElement(el) {
  if (!el || typeof el !== "object") return null;
  const text = (k) => (typeof el[k] === "string" ? el[k] : "");
  const role = `${text("role")} ${text("subrole")} ${text("role_description")}`;
  if (/close ?button/i.test(role)) return "a window's close button";
  const title = [text("label"), text("title"), text("value")].find(Boolean) ?? "";
  if (/menu ?item/i.test(role) && title && refusedTitle(title)) return `"${title.slice(0, 60)}"`;
  return null;
}

/** What launch_app may open: web pages, and files or folders by path. */
const OPENABLE = /^(https?:\/\/|\/|~\/)/i;
/** Paths that start something rather than open it: an app, a script, an installer, a link file. */
const STARTS = /\.(app|command|tool|terminal|workflow|scpt|scptd|applescript|shortcut|pkg|mpkg|prefpane|keychain|keychain-db|webloc|inetloc|fileloc)\/?$/i;

const isInt = (n) => Number.isInteger(n) && n > 0;
const strings = (x, min = 0) => Array.isArray(x) && x.length >= min && x.every((k) => typeof k === "string");

/**
 * A tool call, as Bops passes it on: `{ ok: true, args }` with the arguments Cua gets, or `{ ok: false,
 * why }` with what the task is told instead. `ctx.app(pid)` says what's running as that pid: the path of
 * its program, the bundle ids of the app bundles it runs from, its name, and its windows (`{ path,
 * bundleIds, name, windows: [{ window_id, app_name }] }`), or null when nothing is. `ctx.element(args)`
 * (optional) is the element a call names (element_token, or element_index with snapshot_id) as the
 * window's last get_window_state showed it, or null.
 */
export async function vet(tool, raw, ctx) {
  const no = (why) => ({ ok: false, why });
  if (!TOOLS.includes(tool)) return no(`${tool} isn't one of the Mac tools Bops tasks can use.`);
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  if (args.delivery_mode !== undefined && args.delivery_mode !== "background")
    return no(`Only in the background: delivery_mode "${args.delivery_mode}" would bring the window in front of the user. If input in the background doesn't land, say so and stop.`);
  if (args.scope !== undefined && args.scope !== "window") return no("Only inside a window: name it with pid and window_id (from list_windows), not the whole screen.");
  if (args.target !== undefined) return no("Name the window with pid and window_id (from list_windows), not target.");
  for (const k of ["delivery_mode", "scope", "target", ...DROPPED]) delete args[k];

  if (tool === "list_apps") return { ok: true, args: {} };
  if (tool === "list_windows") {
    const out = {};
    if (typeof args.on_screen_only === "boolean") out.on_screen_only = args.on_screen_only;
    if (args.pid !== undefined) {
      if (!isInt(args.pid)) return no("pid is a number, from list_windows.");
      const app = await ctx.app(args.pid);
      const what = app && offLimits(app);
      if (what) return no(offLimitsWhy(what));
      out.pid = args.pid;
    }
    return { ok: true, args: out };
  }
  if (tool === "launch_app") {
    const out = {};
    for (const k of ["bundle_id", "name"]) if (typeof args[k] === "string" && args[k].trim()) out[k] = args[k].trim();
    if (!out.bundle_id && !out.name) return no("Say which app: its bundle_id or name.");
    const what = offLimits({ name: out.name, bundleId: out.bundle_id, path: out.name });
    if (what) return no(offLimitsWhy(what));
    if (args.urls !== undefined) {
      const urls = Array.isArray(args.urls) ? args.urls : [args.urls];
      const bad = urls.find((u) => typeof u !== "string" || !OPENABLE.test(u.trim()) || STARTS.test(u.trim()));
      if (bad !== undefined) return no(`urls can only be web pages (https://) and files or folders to open (by path), not apps, scripts or other links: ${String(bad).slice(0, 80)}`);
      out.urls = urls.map((u) => u.trim());
    }
    // Everything else is left out: a command line for the app (additional_arguments), a debugging port into
    // it (webkit_inspector_port, cdp_debugging_port), a second copy of it.
    for (const k of Object.keys(out)) if (!LAUNCH_KEEPS.includes(k)) delete out[k];
    return { ok: true, args: out };
  }

  // Everything else reads or acts on one window: it names the window, which has to be that app's, of an app tasks may use.
  if (!WINDOW.has(tool)) return no(`${tool} isn't one of the Mac tools Bops tasks can use.`);
  if (!isInt(args.pid) || !isInt(args.window_id)) return no("Name the window: pass its pid and window_id (from list_windows).");
  const app = await ctx.app(args.pid);
  if (!app) return no(`Nothing is running as pid ${args.pid}: get it from list_windows.`);
  const win = (app.windows ?? []).find((w) => w.window_id === args.window_id);
  if (!win) return no(`Window ${args.window_id} isn't one of that app's windows: get both from list_windows.`);
  const what = offLimits(app) ?? offLimits({ name: win.app_name });
  if (what) return no(offLimitsWhy(what));
  // Lists are lists: anything else (a string, an object) is refused here rather than passed on for Cua to read its own way.
  for (const [k, need] of [
    ["keys", tool === "hotkey"],
    ["modifiers", false],
    ["modifier", false],
    ["path", tool === "invoke_menu"],
  ])
    if ((need || args[k] !== undefined) && !strings(args[k], need ? 1 : 0)) return no(`${k} is a list of strings, such as ${k === "path" ? '["File", "New Tab"]' : '["cmd", "l"]'}.`);
  if (tool === "press_key" && typeof args.key !== "string") return no('key is one key\'s name, such as "return".');
  if (INPUT.has(tool)) args.delivery_mode = "background";
  if (tool === "press_key" || tool === "hotkey") {
    const keys = tool === "hotkey" ? args.keys : [...(args.modifiers ?? []), args.key];
    const does = refusedKeys(keys);
    if (does) return no(`Not allowed: that shortcut is for ${does}, which Bops tasks don't do.`);
  }
  if (tool === "invoke_menu") {
    const item = refusedMenu(args.path);
    if (item) return no(`Not allowed: ${item} isn't a menu item Bops tasks use (no quitting, closing, copying, cutting or pasting, nothing in the Apple menu).`);
  }
  // Pressing an element Bops saw: not a menu item that quits, closes, copies, cuts or pastes (a context menu's Paste), nor a window's close button.
  if (INPUT.has(tool) || tool === "set_value") {
    const el = (args.element_token !== undefined || args.element_index !== undefined) && ctx.element ? await ctx.element(args) : null;
    const item = refusedElement(el);
    if (item) return no(`Not allowed: ${item} isn't something Bops tasks press (no quitting, closing, copying, cutting or pasting).`);
  }
  if (tool === "page") {
    if (!PAGE_READS.includes(args.action)) return no(`page only reads a tab (get_text, query_dom): "${args.action}" isn't allowed.`);
    return { ok: true, args: Object.fromEntries(Object.entries(args).filter(([k]) => ["action", "pid", "window_id", "css_selector", "attributes"].includes(k))) };
  }
  return { ok: true, args };
}

/** The tools as a task sees them: only TOOLS, without the arguments that are refused or dropped, and saying which window. */
export function trimTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => TOOLS.includes(t?.name))
    .map((t) => {
      const schema = JSON.parse(JSON.stringify(t.inputSchema ?? { type: "object", properties: {} }));
      const props = (schema.properties ??= {});
      for (const k of ["delivery_mode", "scope", "target", ...DROPPED]) delete props[k];
      if (t.name === "launch_app") for (const k of Object.keys(props)) if (!LAUNCH_KEEPS.includes(k)) delete props[k];
      if (t.name === "page") {
        for (const k of Object.keys(props)) if (!["action", "pid", "window_id", "css_selector", "attributes"].includes(k)) delete props[k];
        if (props.action) props.action.enum = [...PAGE_READS];
      }
      if (WINDOW.has(t.name)) schema.required = [...new Set([...(schema.required ?? []), "pid", "window_id"])];
      if (Array.isArray(schema.required)) schema.required = schema.required.filter((k) => k in props);
      const note = WINDOW.has(t.name)
        ? ` In Bops: name the window with pid and window_id (from list_windows); in the background only. ${OFF_LIMITS_SAID} are off limits.`
        : t.name === "launch_app"
          ? ` In Bops: no command line or debugging port, and not apps that are off limits (${OFF_LIMITS_SAID}).`
          : " In Bops: apps that are off limits to tasks aren't listed.";
      return { ...t, description: `${t.description ?? ""}${note}`, inputSchema: schema };
    });
}

/** The records of a list answer (list_windows' windows, list_apps' apps) without those of apps off limits. */
function keepAllowed(obj, keep) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? obj.filter(keep) : { ...obj };
  if (!Array.isArray(obj)) for (const k of ["windows", "apps"]) if (Array.isArray(out[k])) out[k] = out[k].filter(keep);
  return out;
}

/** The records in a list answer: list_windows' windows, list_apps' apps, or the list itself. */
const recordsIn = (obj) => (Array.isArray(obj) ? obj : obj && typeof obj === "object" ? ["windows", "apps"].flatMap((k) => (Array.isArray(obj[k]) ? obj[k] : [])) : []);

/**
 * Cua's answer, as the task gets it: list_windows and list_apps without apps off limits (in the structured
 * answer and in its text), and an app just launched that turns out to be one of them isn't shown.
 * `ctx.paths()` says which program each pid runs (a Map), `ctx.ids(path)` (optional) the bundle ids of the
 * app bundles a path is in, `ctx.app(pid)` as for vet.
 */
export async function screenResult(tool, result, ctx) {
  if (!result || typeof result !== "object") return result;
  if (tool === "launch_app") {
    const pid = result.structuredContent?.pid;
    const app = isInt(pid) ? await ctx.app(pid) : null;
    const what = app && (offLimits(app) ?? offLimits({ name: result.structuredContent?.name, bundleId: result.structuredContent?.bundle_id }));
    return what ? { content: [{ type: "text", text: offLimitsWhy(what) }], isError: true } : result;
  }
  if (tool !== "list_windows" && tool !== "list_apps") return result;
  const texts = (Array.isArray(result.content) ? result.content : []).map((c) => {
    if (c?.type !== "text" || typeof c.text !== "string") return undefined;
    try {
      const j = JSON.parse(c.text);
      return j && typeof j === "object" ? j : undefined;
    } catch {
      return undefined;
    }
  });
  // What each pid in the answer runs: off limits or not, by its program's path and the bundle ids of the app bundles it's in.
  const paths = await ctx.paths();
  const byPid = new Map();
  for (const r of [result.structuredContent, ...texts].flatMap(recordsIn))
    if (isInt(r?.pid) && !byPid.has(r.pid)) {
      const path = paths.get(r.pid);
      byPid.set(r.pid, path ? offLimits({ path, bundleIds: ctx.ids ? await ctx.ids(path).catch(() => []) : [] }) : null);
    }
  // By what the record says (its name, bundle id, the app's path) and by what its pid runs.
  const keep = (r) => !r || typeof r !== "object" || !(offLimits({ name: r.app_name ?? r.name, bundleId: r.bundle_id, path: r.launch_path ?? r.path }) ?? (isInt(r.pid) ? byPid.get(r.pid) : null));
  const out = { ...result };
  if (result.structuredContent && typeof result.structuredContent === "object") out.structuredContent = keepAllowed(result.structuredContent, keep);
  out.content = (Array.isArray(result.content) ? result.content : []).map((c, i) => {
    if (c?.type !== "text" || typeof c.text !== "string") return c;
    if (texts[i]) return { ...c, text: JSON.stringify(keepAllowed(texts[i], keep)) };
    // Text for people: the structured answer as JSON instead, or the lines that don't name one of them.
    return { ...c, text: out.structuredContent ? JSON.stringify(out.structuredContent) : c.text.split("\n").filter((l) => !MENTIONS.test(l)).join("\n") };
  });
  return out;
}

/* ---------------- The server ---------------- */

/** The program each pid runs, by its path (ps): `pid` alone, or every process. */
const ps = (pid) =>
  new Promise((resolve) =>
    execFile("/bin/ps", pid === undefined ? ["-A", "-o", "pid=,comm="] : ["-o", "comm=", "-p", String(pid)], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? "" : String(out))),
  );

/** The bundle ids of the app bundles a program's path is in (CFBundleIdentifier of each, outermost first), kept per bundle. */
const idCache = new Map();
const bundleId = (dir) => {
  if (!idCache.has(dir))
    idCache.set(
      dir,
      new Promise((resolve) =>
        execFile("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(dir, "Contents/Info.plist")], (err, out) => resolve(err ? null : String(out).trim() || null)),
      ),
    );
  return idCache.get(dir);
};
const bundleIds = async (path) => (await Promise.all(appDirsIn(path).map(bundleId))).filter(Boolean);

function main() {
  const cuaAt = process.argv.indexOf("--cua");
  const cua = cuaAt > 0 ? process.argv[cuaAt + 1] : undefined;
  if (!cua) {
    process.stderr.write("usage: mac-ui-mcp.mjs --cua <path to cua-driver>\n");
    process.exit(2);
  }
  const child = spawn(cua, ["mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const toCua = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", (e) => {
    process.stderr.write(`cua-driver: ${e.message}\n`);
    process.exit(1);
  });
  process.stdin.on("end", () => child.kill());

  // Requests to Cua, the task's and Bops' own, each under an id of this server's.
  let n = 0;
  const waiting = new Map();
  /** Task request ids by this server's, so a cancel reaches the right one. */
  const forwarded = new Map();
  const ask = (method, params, from) =>
    new Promise((resolve) => {
      const id = `bops-${++n}`;
      waiting.set(id, resolve);
      if (from !== undefined) forwarded.set(from, id);
      toCua({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      const done = waiting.get(m.id);
      waiting.delete(m.id);
      for (const [from, id] of forwarded) if (id === m.id) forwarded.delete(from);
      return done?.(m);
    }
    // Cua asking the task's side something (sampling, elicitation, roots): nothing is answered for the user.
    if (m.id !== undefined) return toCua({ jsonrpc: "2.0", id: m.id, ...(m.method === "roots/list" ? { result: { roots: [] } } : { error: { code: -32601, message: "not available through Bops" } }) });
    // Its notifications: progress and log lines go on; Bops' list of tools doesn't change.
    if (m.method === "notifications/progress" || m.method === "notifications/message") send(m);
  });

  /** Cua's answer to one of its tools, for Bops' own checks. */
  const call = async (name, args) => {
    const r = await ask("tools/call", { name, arguments: args });
    return r.result ?? null;
  };
  const windowsIn = (result) => {
    const sc = result?.structuredContent?.windows;
    if (Array.isArray(sc)) return sc;
    for (const c of result?.content ?? [])
      try {
        const j = JSON.parse(c.text);
        if (Array.isArray(j?.windows)) return j.windows;
      } catch {}
    return [];
  };
  // What runs as each pid, asked again after a moment (windows come and go).
  const apps = new Map();
  // The elements of the windows the task read (get_window_state), by element_token and by snapshot and index.
  const elements = new Map();
  const remember = (args, result) => {
    const sc = result?.structuredContent;
    if (!sc || typeof sc !== "object" || !Array.isArray(sc.elements)) return;
    if (elements.size > 50_000) elements.clear();
    const snap = typeof sc.snapshot_id === "string" ? sc.snapshot_id : undefined;
    for (const el of sc.elements) {
      if (!el || typeof el !== "object") continue;
      if (typeof el.element_token === "string") elements.set(`t:${el.element_token}`, el);
      if (Number.isInteger(el.element_index)) {
        if (snap ?? el.snapshot_id) elements.set(`s:${snap ?? el.snapshot_id}:${el.element_index}`, el);
        elements.set(`w:${args.pid}:${args.window_id}:${el.element_index}`, el);
      }
    }
  };
  const ctx = {
    async app(pid) {
      const hit = apps.get(pid);
      if (hit && Date.now() - hit.at < 1500) return hit.app;
      const [path, windows] = await Promise.all([ps(pid).then((o) => o.trim() || null), call("list_windows", { pid }).then(windowsIn, () => [])]);
      const mine = windows.filter((w) => w?.pid === pid);
      const app = path ? { path, bundleIds: await bundleIds(path), name: mine.find((w) => w.app_name)?.app_name, windows: mine } : null;
      apps.set(pid, { at: Date.now(), app });
      return app;
    },
    ids: bundleIds,
    async element(args) {
      if (typeof args.element_token === "string") return elements.get(`t:${args.element_token}`) ?? null;
      if (!Number.isInteger(args.element_index)) return null;
      return elements.get(typeof args.snapshot_id === "string" ? `s:${args.snapshot_id}:${args.element_index}` : `w:${args.pid}:${args.window_id}:${args.element_index}`) ?? null;
    },
    async paths() {
      const out = new Map();
      for (const line of (await ps()).split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(.+)$/);
        if (m) out.set(Number(m[1]), m[2].trim());
      }
      return out;
    },
  };

  createInterface({ input: process.stdin }).on("line", async (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id === undefined) {
      if (m.method === "notifications/initialized") toCua(m);
      if (m.method === "notifications/cancelled" && forwarded.has(m.params?.requestId)) toCua({ ...m, params: { ...m.params, requestId: forwarded.get(m.params.requestId) } });
      return;
    }
    const reply = (body) => send({ jsonrpc: "2.0", id: m.id, ...body });
    const passOn = (r, shape) => reply(r.error ? { error: r.error } : { result: shape(r.result ?? {}) });
    try {
      if (m.method === "initialize")
        return passOn(await ask("initialize", m.params, m.id), (r) => ({ ...r, capabilities: { tools: {} }, serverInfo: { name: "bops_mac", version: "1" } }));
      if (m.method === "ping") return reply({ result: {} });
      if (m.method === "tools/list") {
        const tools = [];
        let cursor;
        for (let page = 0; page < 20; page++) {
          const r = await ask("tools/list", cursor ? { cursor } : {}, m.id);
          if (r.error) return reply({ error: r.error });
          tools.push(...(r.result?.tools ?? []));
          cursor = r.result?.nextCursor;
          if (!cursor) break;
        }
        return reply({ result: { tools: trimTools(tools) } });
      }
      if (m.method === "tools/call") {
        const name = m.params?.name;
        const v = await vet(name, m.params?.arguments, ctx);
        if (!v.ok) return reply({ result: { content: [{ type: "text", text: v.why }], isError: true } });
        const r = await ask("tools/call", { ...m.params, arguments: v.args }, m.id);
        // The task looked at what's open, or opened something: what runs as each pid is read again.
        if (name === "list_windows" || name === "launch_app") apps.clear();
        if (r.error) return reply({ error: r.error });
        if (name === "get_window_state") remember(v.args, r.result);
        return reply({ result: await screenResult(name, r.result, ctx) });
      }
      if (m.method === "resources/list") return reply({ result: { resources: [] } });
      if (m.method === "resources/templates/list") return reply({ result: { resourceTemplates: [] } });
      if (m.method === "prompts/list") return reply({ result: { prompts: [] } });
      reply({ error: { code: -32601, message: `unknown method ${m.method}` } });
    } catch (e) {
      reply({ error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    }
  });
}

// Run as the server; imported (the tests), it only lends its checks.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
