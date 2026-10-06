import "server-only";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Live pictures of the windows bots use on the user's Mac, for the previews in Bops. Cua Driver
 * (installed with permission to see the screen) captures one window at a time, in the background,
 * without touching what the user is doing. Nothing else on the screen is captured.
 */

const CUA = process.env.CUA_DRIVER_PATH ?? join(homedir(), ".local/bin/cua-driver");

function cua<T>(tool: string, args: object, timeout = 4000) {
  return new Promise<T>((resolve, reject) =>
    execFile(CUA, ["call", tool, JSON.stringify(args)], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(String(out)) as T);
      } catch (e) {
        reject(e);
      }
    }),
  );
}

type Win = { app_name: string; pid: number; window_id: number; title?: string; is_on_screen?: boolean; layer?: number; z_index?: number | null; bounds?: { x?: number; y?: number; width: number; height: number } };
let windows: { at: number; list: Win[] } = { at: 0, list: [] };

async function allWindows() {
  if (Date.now() - windows.at < 2000) return windows.list;
  const r = await cua<{ windows?: Win[]; structuredContent?: { windows?: Win[] } }>("list_windows", {});
  windows = { at: Date.now(), list: r.windows ?? r.structuredContent?.windows ?? [] };
  return windows.list;
}

/** An app's main window: its biggest normal one, preferring what's on screen ("Chrome" finds Google Chrome). */
export async function mainWindow(app: string) {
  const name = app.toLowerCase();
  const mine = (await allWindows()).filter((w) => {
    const owner = w.app_name.toLowerCase();
    return (owner === name || owner.includes(name) || name.includes(owner)) && (w.layer ?? 0) === 0 && (w.bounds?.height ?? 0) > 80 && (w.bounds?.width ?? 0) > 120;
  });
  const area = (w: Win) => (w.bounds?.width ?? 0) * (w.bounds?.height ?? 0) + (w.is_on_screen ? 1e9 : 0);
  return mine.sort((a, b) => area(b) - area(a))[0];
}

/** Every normal window an app has open, frontmost first (a bot can open several, e.g. one per conversation). */
export async function appWindows(app: string) {
  const name = app.toLowerCase();
  return (await allWindows())
    .filter((w) => {
      const owner = w.app_name.toLowerCase();
      return (owner === name || owner.includes(name) || name.includes(owner)) && (w.layer ?? 0) === 0 && (w.bounds?.height ?? 0) > 80 && (w.bounds?.width ?? 0) > 120;
    })
    .sort((a, b) => Number(b.is_on_screen ?? false) - Number(a.is_on_screen ?? false) || (b.z_index ?? 0) - (a.z_index ?? 0));
}

/**
 * Where macOS draws its "this window is being shared" marker on a window (a small purple capsule
 * over the traffic lights, shown while Bops streams it), relative to the window, in points. It's a
 * tiny window of its own, owned by the same app; null when there isn't one right now.
 */
export async function sharingMarker(win: Win) {
  const b = win.bounds;
  if (b?.x === undefined || b.y === undefined) return null;
  const m = (await allWindows()).find((w) => {
    const c = w.bounds;
    return w.pid === win.pid && w.window_id !== win.window_id && c?.x !== undefined && c.y !== undefined && c.width <= 120 && c.height <= 40 && c.x >= b.x! && c.x < b.x! + 160 && c.y >= b.y! && c.y < b.y! + 60;
  });
  return m?.bounds ? { x: m.bounds.x! - b.x!, y: m.bounds.y! - b.y!, w: m.bounds.width, h: m.bounds.height } : null;
}

const shots = new Map<string, { at: number; png: Buffer; title: string }>();

/** A picture of an app's main window, at most `max` pixels on the long edge. Reused for half a second. */
export async function capture(app: string, max = 640) {
  const key = `${app.toLowerCase()}:${max}`;
  const hit = shots.get(key);
  if (hit && Date.now() - hit.at < 500) return hit;
  const w = await mainWindow(app);
  if (!w) return null;
  const r = await cua<{ screenshot_png_b64?: string; window_title?: string }>("get_window_state", {
    pid: w.pid,
    window_id: w.window_id,
    include_accessibility_tree: false,
    max_dimension: max,
  });
  if (!r.screenshot_png_b64) return null;
  const shot = { at: Date.now(), png: Buffer.from(r.screenshot_png_b64, "base64"), title: r.window_title ?? w.title ?? app };
  shots.set(key, shot);
  return shot;
}

/** Every window open on the Mac that's worth watching (normal windows of real apps), for the Watch picker. */
export async function listWindows() {
  const skip = /^(Bops|Electron|Cua Driver|cua-spacesd|Dock|Window Server|Control Center|Notification Center|CursorUIViewService|Wallpaper)$/i;
  return (await allWindows())
    .filter((w) => (w.layer ?? 0) === 0 && (w.bounds?.height ?? 0) > 120 && (w.bounds?.width ?? 0) > 160 && w.title && !skip.test(w.app_name))
    .sort((a, b) => Number(b.is_on_screen ?? false) - Number(a.is_on_screen ?? false) || (b.z_index ?? 0) - (a.z_index ?? 0))
    .map((w) => ({ app: w.app_name, title: w.title!, windowId: w.window_id }));
}

/**
 * A watched window: the app's window showing that title (a Messages window switches between
 * conversations, so its id alone isn't enough), else the one it was, else any of the app's windows.
 */
export async function findWindow(app: string, title: string, windowId?: number) {
  const all = await appWindows(app);
  return all.find((w) => (w.title ?? "") === title) ?? all.find((w) => w.window_id === windowId) ?? all[0];
}

type AxElement = { role?: string; label?: string; value?: string; actions?: string[]; frame?: { x: number; y: number; w: number; h: number } };

/**
 * The text a window shows, read through macOS accessibility (no screenshot, nothing clicked):
 * message bubbles, list previews ("Unread"), headings. In screen order, deduplicated.
 */
export async function windowText(pid: number, windowId: number) {
  const r = await cua<{ elements?: AxElement[]; structuredContent?: { elements?: AxElement[] } }>(
    "get_window_state",
    { pid, window_id: windowId, include_screenshot: false, max_elements: 900 },
    20_000,
  );
  const elements = r.elements ?? r.structuredContent?.elements ?? [];
  // Chat bubbles (Messages: the ones you can tapback) don't say who sent them, but where they sit
  // does: yours hug the window's right edge, theirs the left. Jev needs that to not flag your own.
  const win = elements.find((e) => e.role === "AXWindow")?.frame;
  const bubble = (e: AxElement) => e.role === "AXTextArea" && !!e.actions?.some((a) => /tapback/i.test(a));
  const who = (e: AxElement) => {
    if (!win || !e.frame || !bubble(e)) return "";
    return e.frame.x + e.frame.w >= win.x + win.w - 48 ? "Me: " : "Them: ";
  };
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const e of elements) {
    if (!/AXStaticText|AXTextArea|AXHeading|AXLink|AXCell|AXRow/.test(e.role ?? "")) continue;
    // A text area (a document, a long message) holds many lines: keep them as lines.
    for (const part of (e.value || e.label || "").split(/\n+/)) {
      const text = part.replace(/\s+/g, " ").trim();
      if (text.length < 2) continue;
      const line = `${who(e)}${text}`.slice(0, 300);
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  return lines;
}
