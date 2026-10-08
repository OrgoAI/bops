// Tests for the Mac tools a task with Full access gets (vm/mac-ui-mcp.mjs, lib/server/local.ts macUiMcp):
// Cua Driver's tools reach any window and take any arguments, so a task reaches them through Bops' own
// MCP server, which passes on only what a task may do. Its checks are fed calls here (what's refused,
// what's rewritten), then the server itself runs against a stand-in `cua-driver mcp` that notes every
// call it gets: Bops itself and its helpers, terminals, remote sessions, Keychain Access and the rest are
// hidden from the lists and refused as targets (by name, by the bundle id in the Info.plist of each app
// bundle the process runs from, and by those bundles' names, so the "apps" here are real processes:
// /bin/sleep linked into app bundles of a temporary folder); input goes in the background only, to a named
// window of that app; no drag, no quitting, closing or clipboard shortcuts or menu items (in other languages
// too, nor such a menu item found in a window); lists that aren't lists are refused; a page is only read; an
// app is launched without a command line or a debugging port; and what Cua asks of the task's side (an
// elicitation, the roots) never gets there: Bops answers it, with no. Nothing reaches the real Cua Driver or
// the user's windows. macOS only (ps, plutil and app bundles).
// Usage: node scripts/test-mac-ui.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

if (process.platform !== "darwin") {
  console.log("mac ui: skipped (macOS only)");
  process.exit(0);
}
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const script = join(root, "vm/mac-ui-mcp.mjs");
const U = await import(script);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- The checks, call by call ---------------- */

// The same tools as the task's MCP server is allowed (local.ts), without drag.
const local = readFileSync(join(root, "lib/server/local.ts"), "utf8");
const listed = [...local.slice(local.indexOf("export const MAC_UI_TOOLS = ["), local.indexOf("];", local.indexOf("export const MAC_UI_TOOLS = ["))).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
assert.deepEqual(listed, U.TOOLS, "local.ts MAC_UI_TOOLS and the server list the same tools");
assert.ok(!U.TOOLS.includes("drag"), "no drag (Cua only drags in front of the user)");
for (const t of ["bring_to_front", "move_cursor", "clipboard_read", "clipboard_write", "kill_app", "set_config", "get_desktop_state", "browser_navigate"]) assert.ok(!U.TOOLS.includes(t), t);

// Off limits, by name, bundle id or where the process runs from; the rest aren't.
for (const [app, what] of [
  [{ name: "Bops" }, "Bops"],
  [{ name: "Bops Helper (Renderer)" }, "Bops"],
  [{ name: "Electron" }, "Bops"],
  [{ bundleId: "ai.orgo.bops" }, "Bops"],
  [{ bundleId: "ai.orgo.bops.helper" }, "Bops"],
  [{ name: "Renderer", path: "/Applications/Bops.app/Contents/Frameworks/Bops Helper (Renderer).app/Contents/MacOS/Bops Helper (Renderer)" }, "Bops"],
  [{ path: "/Applications/Bops.app" }, "Bops"],
  [{ name: "Cua Driver" }, "Cua Driver"],
  [{ path: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver" }, "Cua Driver"],
  [{ name: "System Settings" }, "System Settings"],
  [{ bundleId: "com.apple.systempreferences" }, "System Settings"],
  [{ name: "SecurityAgent" }, "System Settings"],
  [{ name: "Keychain Access" }, "Keychain Access"],
  [{ name: "Passwords" }, "Keychain Access"],
  [{ name: "1Password 7" }, "a password manager"],
  [{ bundleId: "com.1password.1password" }, "a password manager"],
  [{ name: "Bitwarden" }, "a password manager"],
  [{ name: "Terminal" }, "a terminal"],
  [{ name: "iTerm2" }, "a terminal"],
  [{ path: "/Applications/Warp.app/Contents/MacOS/stable" }, "a terminal"],
  [{ bundleId: "com.mitchellh.ghostty" }, "a terminal"],
  [{ name: "Visual Studio Code" }, "a terminal"],
  [{ name: "Script Editor" }, "a terminal"],
  // Any build of Bops; terminals by their real names and ids; editors and apps that run commands.
  [{ name: "Bops Beta" }, "Bops"],
  [{ path: "/Applications/Bops Dev.app/Contents/MacOS/Bops Dev" }, "Bops"],
  [{ bundleId: "org.alacritty" }, "a terminal"],
  [{ name: "Code - Insiders" }, "a terminal"],
  [{ bundleId: "com.microsoft.VSCodeInsiders" }, "a terminal"],
  [{ path: "/Applications/VSCodium.app/Contents/MacOS/codium" }, "a terminal"],
  [{ name: "RustRover" }, "a terminal"],
  [{ name: "Fleet" }, "a terminal"],
  [{ bundleId: "dev.warp.Warp-Preview" }, "a terminal"],
  [{ path: "/Applications/Docker.app/Contents/MacOS/com.docker.backend" }, "a terminal"],
  [{ name: "Xcode" }, "a terminal"],
  [{ name: "Shortcuts" }, "a terminal"],
  [{ name: "Raycast" }, "a terminal"],
  // Remote sessions: remote desktop, SSH, VM consoles, the user's phone.
  [{ path: "/Applications/NoMachine.app/Contents/Frameworks/bin/nxplayer.bin" }, "a remote session"],
  [{ name: "Screen Sharing" }, "a remote session"],
  [{ name: "Windows App" }, "a remote session"],
  [{ bundleId: "com.microsoft.rdc.macos" }, "a remote session"],
  [{ name: "UTM" }, "a remote session"],
  [{ name: "SecureCRT" }, "a remote session"],
  [{ name: "Royal TSX" }, "a remote session"],
  [{ bundleId: "com.apple.ScreenContinuity" }, "a remote session"],
  // AI agent apps (the Codex app's program is called ChatGPT), clipboard managers, Activity Monitor.
  [{ name: "ChatGPT", path: "/Applications/Codex.app/Contents/MacOS/ChatGPT" }, "an AI agent app"],
  [{ bundleIds: ["com.openai.codex"] }, "an AI agent app"],
  [{ name: "Claude" }, "an AI agent app"],
  [{ name: "Paste" }, "a clipboard manager"],
  [{ bundleId: "com.wiheads.paste" }, "a clipboard manager"],
  [{ name: "Maccy" }, "a clipboard manager"],
  [{ name: "Activity Monitor" }, "a system utility"],
  [{ bundleId: "com.apple.ActivityMonitor" }, "a system utility"],
  [{ name: "Disk Utility" }, "a system utility"],
  [{ name: "Google Chrome" }, null],
  [{ name: "Microsoft Word", bundleId: "com.microsoft.Word" }, null],
  [{ name: "Bopsy" }, null],
  [{ name: "Preview" }, null],
  [{ name: "Safari", bundleId: "com.apple.Safari" }, null],
  [{ name: "Messages", path: "/System/Applications/Messages.app/Contents/MacOS/Messages" }, null],
  [{ name: "Notes" }, null],
  [{ name: "Slack" }, null],
  [{ name: "Finder" }, null],
])
  assert.equal(U.offLimits(app), what, JSON.stringify(app));

// Shortcuts and menu items that quit, close, copy, cut or paste (or force quit), however they're written.
for (const keys of [["cmd", "q"], ["command", "w"], ["⌘", "c"], ["cmd", "shift", "v"], ["cmd+x"], ["Cmd-Q"], ["cmd", "option", "escape"], ["meta", "option", "shift", "v"]]) assert.ok(U.refusedKeys(keys), keys.join("+"));
for (const keys of [["cmd", "l"], ["cmd", "t"], ["cmd", "f"], ["ctrl", "c"], ["shift", "tab"], ["return"], ["cmd", "enter"], ["option", "escape"]]) assert.equal(U.refusedKeys(keys), null, keys.join("+"));
for (const path of [["Google Chrome", "Quit Google Chrome"], ["File", "Close Tab"], ["Edit", "Copy"], ["Edit", "Paste and Match Style"], ["Edit", "Cut"], ["Apple", "About This Mac"], ["Apple", "Restart…"], ["", "Sleep"], ["File", "Force Quit…"]]) assert.ok(U.refusedMenu(path), path.join(" > "));
for (const path of [["File", "New Tab"], ["View", "Closed Captions"], ["Edit", "Select All"], ["Window", "Shortcuts"], ["History", "Show All History"]]) assert.equal(U.refusedMenu(path), null, path.join(" > "));
// In the languages macOS commonly runs in (a menu item is found by its title).
for (const path of [
  ["Google Chrome", "Google Chrome beenden"],
  ["Édition", "Coller"],
  ["Edición", "Pegar"],
  ["Archivo", "Cerrar pestaña"],
  ["Modifica", "Incolla"],
  ["Bewerken", "Kopiëren"],
  ["編集", "ペースト"],
  ["编辑", "粘贴"],
  ["編輯", "貼上"],
  ["편집", "붙여넣기"],
  ["Правка", "Вставить"],
])
  assert.ok(U.refusedMenu(path), path.join(" > "));
for (const path of [["Archivo", "Nueva pestaña"], ["Bearbeiten", "Alles auswählen"], ["Fichier", "Ouvrir…"], ["表示", "再読み込み"], ["Вид", "Обновить"]]) assert.equal(U.refusedMenu(path), null, path.join(" > "));
// Elements a click may not press (from the window's last get_window_state): such a menu item, or a window's close button.
for (const el of [{ role: "AXMenuItem", label: "Paste" }, { role: "menu item", title: "Coller" }, { role: "AXButton", subrole: "AXCloseButton" }, { role: "AXMenuItem", label: "Quit Google Chrome" }])
  assert.ok(U.refusedElement(el), JSON.stringify(el));
for (const el of [{ role: "AXButton", label: "Close" }, { role: "AXMenuItem", label: "New Tab" }, { role: "AXLink", label: "Copy link" }, null]) assert.equal(U.refusedElement(el), null, JSON.stringify(el));

// A stand-in for what runs on the Mac: Chrome (pid 101) with two windows, Bops (102), a Bops helper
// whose window says only "Renderer" (103, known by its path), Terminal (104).
const running = {
  101: { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", name: "Google Chrome", windows: [{ window_id: 11, app_name: "Google Chrome" }, { window_id: 12, app_name: "Google Chrome" }] },
  102: { path: "/Applications/Bops.app/Contents/MacOS/Bops", name: "Bops", windows: [{ window_id: 21, app_name: "Bops" }] },
  103: { path: "/Applications/Bops.app/Contents/Frameworks/Bops Helper (Renderer).app/Contents/MacOS/Bops Helper (Renderer)", name: "Renderer", windows: [{ window_id: 31, app_name: "Renderer" }] },
  104: { path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", name: "Terminal", windows: [{ window_id: 41, app_name: "Terminal" }] },
};
// Elements of windows the task read, by element_token (ctx.element).
const elements = { tok_paste: { role: "AXMenuItem", label: "Paste" }, tok_close: { role: "AXButton", subrole: "AXCloseButton" }, tok_ok: { role: "AXButton", label: "Close" }, tok_new: { role: "AXMenuItem", label: "New Window" } };
const ctx = {
  app: async (pid) => running[pid] ?? null,
  paths: async () => new Map(Object.entries(running).map(([pid, a]) => [Number(pid), a.path])),
  element: async (a) => elements[a.element_token] ?? null,
};
const vet = (tool, args) => U.vet(tool, args, ctx);
const refused = async (tool, args, why) => {
  const v = await vet(tool, args);
  assert.equal(v.ok, false, `${tool} ${JSON.stringify(args)} is refused`);
  if (why) assert.match(v.why, why);
  assert.doesNotMatch(v.why, /[—–]/, "no dashes");
};
const passed = async (tool, args) => {
  const v = await vet(tool, args);
  assert.equal(v.ok, true, `${tool} ${JSON.stringify(args)} passes (${v.why ?? ""})`);
  return v.args;
};
const chrome = { pid: 101, window_id: 11 };

// Input goes in the background, to a window named by pid and window_id, of that app.
assert.deepEqual(await passed("click", { ...chrome, element_token: "t1" }), { ...chrome, element_token: "t1", delivery_mode: "background" });
assert.deepEqual(await passed("click", { ...chrome, x: 10, y: 20, delivery_mode: "background", scope: "window", debug_image_out: "/tmp/x.png" }), { ...chrome, x: 10, y: 20, delivery_mode: "background" });
await refused("click", { ...chrome, x: 1, y: 2, delivery_mode: "foreground" }, /background/);
await refused("type_text", { ...chrome, text: "hi", delivery_mode: "foreground" }, /background/);
await refused("click", { x: 1, y: 2, scope: "desktop" }, /window/);
await refused("click", { target: { kind: "window", pid: 102, window_id: 21 }, x: 1, y: 2 }, /pid and window_id/);
await refused("click", { pid: 101, x: 1, y: 2 }, /pid and window_id/);
await refused("click", { element_token: "t1" }, /pid and window_id/);
await refused("hotkey", { keys: ["cmd", "l"] }, /pid and window_id/);
await refused("click", { pid: 101, window_id: 21, x: 1, y: 2 }, /isn't one of that app's windows/);
await refused("click", { pid: 999, window_id: 11 }, /Nothing is running/);
// Off limits: Bops, its helper (by its path), a terminal; reading them too.
await refused("click", { pid: 102, window_id: 21, x: 1, y: 2 }, /Bops itself is off limits/);
await refused("click", { pid: 103, window_id: 31, x: 1, y: 2 }, /Bops itself is off limits/);
await refused("get_window_state", { pid: 102, window_id: 21 }, /off limits/);
await refused("page", { pid: 102, window_id: 21, action: "get_text" }, /off limits/);
await refused("type_text", { pid: 104, window_id: 41, text: "ls" }, /a terminal is off limits/);
await refused("list_windows", { pid: 102 }, /off limits/);
// No drag, nor any tool outside the list.
await refused("drag", { ...chrome, from_x: 1, from_y: 1, to_x: 2, to_y: 2 }, /isn't one of the Mac tools/);
for (const t of ["bring_to_front", "kill_app", "clipboard_write", "move_cursor", "set_config", "get_desktop_state"]) await refused(t, { ...chrome }, /isn't one of the Mac tools/);
// Shortcuts and menu items.
await refused("hotkey", { ...chrome, keys: ["cmd", "q"] }, /quitting/);
await refused("hotkey", { ...chrome, keys: ["cmd", "v"] }, /pasting/);
await refused("press_key", { ...chrome, key: "w", modifiers: ["command"] }, /closing/);
await refused("press_key", { ...chrome, key: "cmd+c" }, /copying/);
assert.deepEqual(await passed("hotkey", { ...chrome, keys: ["cmd", "l"] }), { ...chrome, keys: ["cmd", "l"], delivery_mode: "background" });
assert.deepEqual(await passed("press_key", { ...chrome, key: "return" }), { ...chrome, key: "return", delivery_mode: "background" });
await refused("invoke_menu", { ...chrome, path: ["Google Chrome", "Quit Google Chrome"] }, /Quit Google Chrome/);
await refused("invoke_menu", { ...chrome, path: ["Edit", "Paste"] }, /Paste/);
await refused("invoke_menu", { ...chrome, path: ["Apple", "System Settings…"] });
assert.deepEqual(await passed("invoke_menu", { ...chrome, path: ["File", "New Tab"] }), { ...chrome, path: ["File", "New Tab"] });
await refused("invoke_menu", { ...chrome, path: ["Google Chrome", "Google Chrome beenden"] }, /beenden/);
// Lists are lists: anything else is refused, not passed on for Cua to read its own way.
await refused("invoke_menu", { ...chrome, path: "Chrome > Quit Chrome" }, /path is a list of strings/);
await refused("invoke_menu", { ...chrome }, /path is a list of strings/);
await refused("hotkey", { ...chrome, keys: "cmd+q" }, /keys is a list of strings/);
await refused("press_key", { ...chrome, key: "q", modifiers: "cmd" }, /modifiers is a list of strings/);
await refused("press_key", { ...chrome, key: ["q"], modifiers: ["cmd"] }, /key is one key/);
await refused("click", { ...chrome, x: 1, y: 2, modifier: "cmd" }, /modifier is a list of strings/);
assert.deepEqual(await passed("press_key", { ...chrome, key: "a", modifiers: [] }), { ...chrome, key: "a", modifiers: [], delivery_mode: "background" });
// Pressing a menu item Bops saw that pastes, or a window's close button: refused; a page's own Close button isn't.
await refused("click", { ...chrome, element_token: "tok_paste" }, /"Paste"/);
await refused("press_key", { ...chrome, element_token: "tok_paste", key: "return" }, /"Paste"/);
await refused("click", { ...chrome, element_token: "tok_close" }, /close button/);
await passed("click", { ...chrome, element_token: "tok_ok" });
await passed("click", { ...chrome, element_token: "tok_new" });
// A page is only read: no JavaScript, nothing that turns on JavaScript from Apple Events, and what's left over isn't passed on.
await refused("page", { ...chrome, action: "execute_javascript", javascript: "document.title" }, /only reads/);
await refused("page", { ...chrome, action: "enable_javascript_apple_events", bundle_id: "com.google.Chrome", user_has_confirmed_enabling: true }, /only reads/);
await refused("page", { ...chrome, action: "insert_text", text: "x" }, /only reads/);
assert.deepEqual(await passed("page", { ...chrome, action: "get_text", javascript: "alert(1)", cdp_port: 9222, target_url_contains: "x" }), { ...chrome, action: "get_text" });
assert.deepEqual(await passed("page", { ...chrome, action: "query_dom", css_selector: "a", attributes: ["href"] }), { ...chrome, action: "query_dom", css_selector: "a", attributes: ["href"] });
// Reading a window writes nothing to a file.
assert.deepEqual(await passed("get_window_state", { ...chrome, screenshot_out_file: "/Users/someone/x.png", include_screenshot: false }), { ...chrome, include_screenshot: false });
// Launching: no command line, no debugging port, no second copy; nothing off limits; only pages, files and folders to open.
assert.deepEqual(
  await passed("launch_app", { bundle_id: "com.google.Chrome", additional_arguments: ["--remote-debugging-port=9222"], cdp_debugging_port: 9222, webkit_inspector_port: 9333, creates_new_application_instance: true, urls: ["https://example.com", "/Users/me/Downloads"] }),
  { bundle_id: "com.google.Chrome", urls: ["https://example.com", "/Users/me/Downloads"] },
);
assert.deepEqual(await passed("launch_app", { name: "Notes" }), { name: "Notes" });
await refused("launch_app", { bundle_id: "ai.orgo.bops" }, /Bops itself is off limits/);
await refused("launch_app", { name: "Terminal" }, /off limits/);
await refused("launch_app", { name: "/Applications/Bops.app" }, /off limits/);
await refused("launch_app", { bundle_id: "com.googlecode.iterm2" }, /off limits/);
await refused("launch_app", { name: "System Settings" }, /off limits/);
await refused("launch_app", { bundle_id: "com.apple.finder", urls: ["/Applications/Utilities/Terminal.app"] }, /not apps/);
await refused("launch_app", { bundle_id: "com.apple.finder", urls: ["/Users/me/run.command"] }, /not apps/);
await refused("launch_app", { bundle_id: "com.apple.Safari", urls: ["x-apple.systempreferences:com.apple.preference.security"] }, /not apps/);
await refused("launch_app", { bundle_id: "com.apple.Safari", urls: ["javascript:alert(1)"] }, /not apps/);
await refused("launch_app", {}, /bundle_id or name/);

// What a task is shown of Cua's tools: only the allowed ones, without the arguments it can't use, naming the window.
const cuaTools = [
  { name: "click", description: "Click.", inputSchema: { type: "object", additionalProperties: false, properties: { pid: { type: "integer" }, window_id: { type: "integer" }, x: { type: "number" }, delivery_mode: { enum: ["background", "foreground"] }, scope: { enum: ["window", "desktop"] }, target: {}, debug_image_out: { type: "string" } }, required: [] } },
  { name: "drag", description: "Drag.", inputSchema: { type: "object", properties: { from_x: { type: "number" } }, required: ["from_x"] } },
  { name: "bring_to_front", description: "Front.", inputSchema: { type: "object", properties: {} } },
  { name: "page", description: "Page.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["execute_javascript", "get_text", "query_dom", "click_element", "insert_text", "type_keystrokes", "enable_javascript_apple_events"] }, javascript: { type: "string" }, pid: { type: "integer" }, window_id: { type: "integer" }, css_selector: { type: "string" }, cdp_port: { type: "integer" }, user_has_confirmed_enabling: { type: "boolean" } }, required: ["action"] } },
  { name: "launch_app", description: "Launch.", inputSchema: { type: "object", properties: { bundle_id: { type: "string" }, name: { type: "string" }, urls: { type: "array" }, additional_arguments: { type: "array" }, webkit_inspector_port: { type: "integer" }, cdp_debugging_port: { type: "integer" }, creates_new_application_instance: { type: "boolean" } } } },
  { name: "list_windows", description: "Windows.", inputSchema: { type: "object", properties: { pid: { type: "integer" }, on_screen_only: { type: "boolean" } } } },
];
const shown = U.trimTools(cuaTools);
assert.deepEqual(shown.map((t) => t.name), ["click", "page", "launch_app", "list_windows"]);
const shownClick = shown.find((t) => t.name === "click");
assert.deepEqual(Object.keys(shownClick.inputSchema.properties), ["pid", "window_id", "x"]);
assert.deepEqual(shownClick.inputSchema.required, ["pid", "window_id"]);
assert.match(shownClick.description, /^Click\. In Bops: name the window with pid and window_id/);
assert.deepEqual(shown.find((t) => t.name === "page").inputSchema.properties.action.enum, ["get_text", "query_dom"]);
assert.deepEqual(Object.keys(shown.find((t) => t.name === "page").inputSchema.properties), ["action", "pid", "window_id", "css_selector"]);
assert.deepEqual(Object.keys(shown.find((t) => t.name === "launch_app").inputSchema.properties), ["bundle_id", "name", "urls"]);
assert.equal(cuaTools[0].inputSchema.properties.delivery_mode !== undefined, true, "Cua's own list is left as it was");

// Answers: the lists leave out what's off limits, in the structured answer and in its text.
const windowsAnswer = {
  content: [{ type: "text", text: "Google Chrome (pid 101) window 11\nBops (pid 102) window 21\nRenderer (pid 103) window 31\nTerminal (pid 104) window 41" }],
  structuredContent: { windows: [101, 102, 103, 104].flatMap((pid) => running[pid].windows.map((w) => ({ pid, window_id: w.window_id, app_name: w.app_name, title: "x" }))) },
};
const seen = await U.screenResult("list_windows", windowsAnswer, ctx);
assert.deepEqual(seen.structuredContent.windows.map((w) => w.pid), [101, 101]);
assert.doesNotMatch(seen.content[0].text, /Bops|Terminal|"pid":10[234]/);
assert.match(seen.content[0].text, /Google Chrome/);
const jsonText = await U.screenResult("list_apps", { content: [{ type: "text", text: JSON.stringify({ apps: [{ name: "Bops", bundle_id: "ai.orgo.bops", pid: 102 }, { name: "Notes", bundle_id: "com.apple.Notes", pid: 0 }, { name: "1Password", bundle_id: "com.1password.1password", pid: 0 }] }) }] }, ctx);
assert.deepEqual(JSON.parse(jsonText.content[0].text).apps.map((a) => a.name), ["Notes"]);
// A launch that turns out to be an app off limits isn't shown.
const launched = await U.screenResult("launch_app", { content: [{ type: "text", text: "launched" }], structuredContent: { pid: 104, name: "Shell", windows: running[104].windows } }, ctx);
assert.equal(launched.isError, true);
assert.match(launched.content[0].text, /off limits/);
assert.equal((await U.screenResult("launch_app", { structuredContent: { pid: 101, name: "Google Chrome" } }, ctx)).isError, undefined);

/* ---------------- The server, against a stand-in Cua Driver ---------------- */

const scratch = mkdtempSync(join(tmpdir(), "bops-test-mac-ui-"));
// Real processes for the apps, each /bin/sleep linked into an app bundle, so ps names it by that path.
const apps = {};
const procs = [];
for (const [key, path] of [
  ["chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"],
  ["bops", "Bops.app/Contents/MacOS/Bops"],
  ["helper", "Bops.app/Contents/Frameworks/Bops Helper (Renderer).app/Contents/MacOS/Bops Helper (Renderer)"],
  ["terminal", "Terminal.app/Contents/MacOS/Terminal"],
  // Known only by its bundle id (a remote desktop app under another name): read from its Info.plist.
  ["remote", "Workspace.app/Contents/MacOS/Workspace"],
]) {
  const bin = join(scratch, "Applications", path);
  mkdirSync(dirname(bin), { recursive: true });
  symlinkSync("/bin/sleep", bin);
  if (key === "remote")
    writeFileSync(
      join(scratch, "Applications/Workspace.app/Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.microsoft.rdc.macos</string></dict></plist>\n`,
    );
  const p = spawn(bin, ["120"], { stdio: "ignore" });
  procs.push(p);
  apps[key] = p.pid;
}
const windows = [
  { pid: apps.chrome, window_id: 11, app_name: "Google Chrome", title: "Inbox" },
  { pid: apps.chrome, window_id: 12, app_name: "Google Chrome", title: "Flights" },
  { pid: apps.bops, window_id: 21, app_name: "Bops", title: "Bops" },
  { pid: apps.helper, window_id: 31, app_name: "Renderer", title: "" },
  { pid: apps.terminal, window_id: 41, app_name: "Terminal", title: "ssh prod" },
  { pid: apps.remote, window_id: 51, app_name: "Workspace", title: "prod-db-1" },
];
const appList = [
  { name: "Google Chrome", bundle_id: "com.google.Chrome", pid: apps.chrome, running: true, launch_path: join(scratch, "Applications/Google Chrome.app") },
  { name: "Bops", bundle_id: "ai.orgo.bops", pid: apps.bops, running: true, launch_path: join(scratch, "Applications/Bops.app") },
  { name: "Terminal", bundle_id: "com.apple.Terminal", pid: apps.terminal, running: true, launch_path: join(scratch, "Applications/Terminal.app") },
  { name: "Notes", bundle_id: "com.apple.Notes", pid: 0, running: false, launch_path: "/System/Applications/Notes.app" },
  { name: "CuaDriver", bundle_id: "com.trycua.driver", pid: 0, running: false, launch_path: "/Applications/CuaDriver.app" },
];
// The stand-in `cua-driver mcp`: Cua's tools (two pages of them), every call it gets noted, and once it's
// set up it asks the task's side for something (an elicitation, the roots), which Bops answers itself.
const log = join(scratch, "cua.log");
const fake = join(scratch, "cua-driver");
writeFileSync(
  fake,
  `#!/usr/bin/env node
const fs = require("fs"), readline = require("readline");
const log = (x) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(x) + "\\n");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const windows = ${JSON.stringify(windows)}, apps = ${JSON.stringify(appList)}, tools = ${JSON.stringify(cuaTools)};
log({ args: process.argv.slice(2) });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) return log({ answer: m });
  if (m.id === undefined) return log({ note: m.method });
  if (m.method === "initialize") {
    send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "cua-driver", version: "0.22.2" } } });
    send({ id: "cua-1", method: "elicitation/create", params: { message: "Allow?" } });
    send({ id: "cua-2", method: "roots/list" });
    return;
  }
  if (m.method === "tools/list") return send({ id: m.id, result: m.params?.cursor ? { tools: tools.slice(3) } : { tools: tools.slice(0, 3), nextCursor: "more" } });
  if (m.method !== "tools/call") return send({ id: m.id, error: { code: -32601, message: "no" } });
  const { name, arguments: a } = m.params;
  log({ call: name, args: a });
  if (name === "list_windows") {
    const ws = windows.filter((w) => a.pid === undefined || w.pid === a.pid);
    return send({ id: m.id, result: { content: [{ type: "text", text: ws.map((w) => w.app_name + " (pid " + w.pid + ") window " + w.window_id + ": " + w.title).join("\\n") }], structuredContent: { windows: ws } } });
  }
  if (name === "list_apps") return send({ id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ apps }) }], structuredContent: { apps } } });
  if (name === "launch_app") {
    const pid = a.name === "Shell" ? ${apps.terminal} : ${apps.chrome};
    return send({ id: m.id, result: { content: [{ type: "text", text: "launched" }], structuredContent: { pid, name: a.name ?? "Google Chrome", windows: windows.filter((w) => w.pid === pid) } } });
  }
  if (name === "get_window_state")
    return send({ id: m.id, result: { content: [{ type: "text", text: "tree" }], structuredContent: { snapshot_id: "s0000abcd", elements: [{ element_index: 1, element_token: "tok_paste", role: "AXMenuItem", label: "Paste" }, { element_index: 2, element_token: "tok_new", role: "AXMenuItem", label: "New Window" }] } } });
  send({ id: m.id, result: { content: [{ type: "text", text: "done " + name }] } });
});
`,
  { mode: 0o755 },
);
const server = spawn(process.execPath, [script, "--cua", fake], { stdio: ["pipe", "pipe", "inherit"] });
const answers = new Map();
const unasked = [];
createInterface({ input: server.stdout }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && answers.has(m.id)) answers.get(m.id)(m);
  else unasked.push(m);
});
let next = 0;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10_000);
    answers.set(id, (m) => (clearTimeout(timer), resolve(m)));
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const calls = () =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((x) => x.call);
const callTool = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;

try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } });
  assert.equal(init.result.serverInfo.name, "bops_mac");
  assert.deepEqual(init.result.capabilities, { tools: {} }, "tools only: Cua's resources aren't offered");
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  // Cua started as an MCP server, and what it asked the task's side was answered by Bops: no to the elicitation, no roots.
  const until = async (check, what) => {
    for (const end = Date.now() + 10_000; Date.now() < end; await sleep(25)) if (check()) return;
    assert.fail(`timed out waiting for ${what}`);
  };
  await until(() => existsSync(log) && readFileSync(log, "utf8").split('"answer"').length > 2 && readFileSync(log, "utf8").includes("notifications/initialized"), "Cua's questions to be answered");
  const logged = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(logged[0], { args: ["mcp"] });
  assert.ok(logged.some((x) => x.note === "notifications/initialized"));
  assert.equal(logged.find((x) => x.answer?.id === "cua-1").answer.error.message, "not available through Bops");
  assert.deepEqual(logged.find((x) => x.answer?.id === "cua-2").answer.result, { roots: [] });

  // Both pages of Cua's tools, trimmed.
  const list = (await rpc("tools/list", {})).result.tools;
  assert.deepEqual(list.map((t) => t.name), ["click", "page", "launch_app", "list_windows"]);
  assert.ok(!("delivery_mode" in list[0].inputSchema.properties));
  // (What the server writes comes in order, so anything of Cua's passed on would have come before this answer.)
  assert.deepEqual(unasked, [], "nothing Cua asked reached the task's side");

  // The lists leave out Bops, its helper (known only by its path), Terminal and Cua Driver.
  const ws = await callTool("list_windows", {});
  assert.deepEqual(ws.structuredContent.windows.map((w) => w.window_id), [11, 12], "Workspace too, by its bundle id");
  assert.doesNotMatch(ws.content[0].text, /Bops|Renderer|Terminal|ssh prod|prod-db-1/);
  assert.match(ws.content[0].text, /Inbox/);
  const as = await callTool("list_apps", {});
  assert.deepEqual(as.structuredContent.apps.map((a) => a.name), ["Google Chrome", "Notes"]);
  assert.deepEqual(JSON.parse(as.content[0].text).apps.map((a) => a.name), ["Google Chrome", "Notes"]);

  // Refused calls never reach Cua; the rest reach it as Bops rewrote them.
  const before = calls().length;
  for (const [name, args] of [
    ["click", { pid: apps.bops, window_id: 21, x: 5, y: 5 }],
    ["click", { pid: apps.helper, window_id: 31, x: 5, y: 5 }],
    ["get_window_state", { pid: apps.terminal, window_id: 41 }],
    ["click", { pid: apps.chrome, window_id: 21, x: 5, y: 5 }],
    ["type_text", { pid: apps.remote, window_id: 51, text: "sudo rm -rf /" }],
    ["invoke_menu", { pid: apps.chrome, window_id: 11, path: "Edit > Paste" }],
    ["click", { pid: apps.chrome, window_id: 11, x: 5, y: 5, delivery_mode: "foreground" }],
    ["click", { x: 5, y: 5, scope: "desktop" }],
    ["drag", { pid: apps.chrome, window_id: 11, from_x: 1, from_y: 1, to_x: 9, to_y: 9 }],
    ["hotkey", { pid: apps.chrome, window_id: 11, keys: ["cmd", "q"] }],
    ["invoke_menu", { pid: apps.chrome, window_id: 11, path: ["Edit", "Paste"] }],
    ["page", { pid: apps.chrome, window_id: 11, action: "execute_javascript", javascript: "1" }],
    ["page", { pid: apps.chrome, window_id: 11, action: "enable_javascript_apple_events", user_has_confirmed_enabling: true }],
    ["launch_app", { bundle_id: "ai.orgo.bops" }],
    ["kill_app", { pid: apps.bops }],
  ]) {
    const r = await callTool(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)} is refused`);
  }
  // (Bops' own look at which windows an app has goes to Cua as list_windows; nothing else did.)
  assert.deepEqual(calls().slice(before).filter((c) => c.call !== "list_windows"), [], "no refused call reached Cua");

  // A menu item it read in a window (a context menu's Paste) can't be pressed, by element_token or by index.
  await callTool("get_window_state", { pid: apps.chrome, window_id: 12 });
  const read = calls().length;
  assert.equal((await callTool("click", { pid: apps.chrome, window_id: 12, element_token: "tok_paste" })).isError, true);
  assert.equal((await callTool("click", { pid: apps.chrome, window_id: 12, element_index: 1, snapshot_id: "s0000abcd" })).isError, true);
  assert.deepEqual(calls().slice(read).filter((c) => c.call !== "list_windows"), [], "never reached Cua");
  assert.equal((await callTool("click", { pid: apps.chrome, window_id: 12, element_index: 2, snapshot_id: "s0000abcd" })).content[0].text, "done click");

  const passedOn = calls().length;
  assert.equal((await callTool("click", { pid: apps.chrome, window_id: 12, element_token: "e7", debug_image_out: "/tmp/x.png" })).content[0].text, "done click");
  await callTool("hotkey", { pid: apps.chrome, window_id: 12, keys: ["cmd", "l"] });
  await callTool("page", { pid: apps.chrome, window_id: 12, action: "get_text", javascript: "x", cdp_port: 9222 });
  await callTool("launch_app", { bundle_id: "com.google.Chrome", additional_arguments: ["--remote-debugging-port=9222"], cdp_debugging_port: 9222, urls: ["https://example.com"] });
  const shell = await callTool("launch_app", { name: "Shell" });
  assert.equal(shell.isError, true, "an app off limits, once launched, isn't shown");
  assert.doesNotMatch(JSON.stringify(shell), /ssh prod/);
  assert.deepEqual(
    calls().slice(passedOn).filter((c) => c.call !== "list_windows"),
    [
      { call: "click", args: { pid: apps.chrome, window_id: 12, element_token: "e7", delivery_mode: "background" } },
      { call: "hotkey", args: { pid: apps.chrome, window_id: 12, keys: ["cmd", "l"], delivery_mode: "background" } },
      { call: "page", args: { pid: apps.chrome, window_id: 12, action: "get_text" } },
      { call: "launch_app", args: { bundle_id: "com.google.Chrome", urls: ["https://example.com"] } },
      { call: "launch_app", args: { name: "Shell" } },
    ],
  );
  // A method it doesn't serve is turned down, and resources aren't Cua's.
  assert.equal((await rpc("sampling/createMessage", {})).error.code, -32601);
  assert.deepEqual((await rpc("resources/list", {})).result, { resources: [] });
  assert.deepEqual(unasked, []);
} finally {
  server.kill();
  for (const p of procs) p.kill();
  await sleep(100);
  rmSync(scratch, { recursive: true, force: true });
}

// The task's tools reach Cua through this server, never `cua-driver mcp` itself (lib/server/local.ts;
// scripts/test-mac-tasks.mjs checks what a task with Full access is given).
assert.match(local, /vm\/mac-ui-mcp\.mjs/);
assert.doesNotMatch(local, /command: CUA_DRIVER/);
console.log("mac ui: all passed");
process.exit(0);
