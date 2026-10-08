import "server-only";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Local desktop windows used by Bops.
 *
 * macOS keeps using cua-driver. Windows uses Win32 window APIs and UI Automation through
 * Windows PowerShell, so the same Bops APIs can enumerate, preview and read local app windows.
 * Internal "mac" names are retained for saved-state/API compatibility.
 */

const WINDOWS = process.platform === "win32";
const CUA = process.env.CUA_DRIVER_PATH ?? join(homedir(), ".local/bin/cua-driver");

type Bounds = { x?: number; y?: number; width: number; height: number };
type Win = {
  app_name: string;
  process_name?: string;
  pid: number;
  window_id: number;
  title?: string;
  is_on_screen?: boolean;
  layer?: number;
  z_index?: number | null;
  bounds?: Bounds;
};

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

function ps(script: string, timeout = 6000) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, out, stderr) => (err ? reject(new Error(String(stderr || err.message))) : resolve(String(out).trim())),
    ),
  );
}

const WINDOWS_ENUM = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BopsWindowApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
$items = [System.Collections.Generic.List[object]]::new()
$z = 0
[BopsWindowApi]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [BopsWindowApi]::IsWindowVisible($hWnd)) { return $true }
  $len = [BopsWindowApi]::GetWindowTextLength($hWnd)
  if ($len -lt 1) { return $true }
  $sb = [Text.StringBuilder]::new($len + 2)
  [void][BopsWindowApi]::GetWindowText($hWnd, $sb, $sb.Capacity)
  $title = $sb.ToString().Trim()
  if (-not $title) { return $true }
  $processId = [uint32]0
  [void][BopsWindowApi]::GetWindowThreadProcessId($hWnd, [ref]$processId)
  $rect = New-Object BopsWindowApi+RECT
  if (-not [BopsWindowApi]::GetWindowRect($hWnd, [ref]$rect)) { return $true }
  $w = [Math]::Max(0, $rect.Right - $rect.Left)
  $h = [Math]::Max(0, $rect.Bottom - $rect.Top)
  if ($w -lt 40 -or $h -lt 40) { return $true }
  try { $p = Get-Process -Id $processId -ErrorAction Stop } catch { return $true }
  $process = $p.ProcessName
  $items.Add([pscustomobject]@{
    app_name = $process
    process_name = $process
    pid = [int]$processId
    window_id = $hWnd.ToInt64()
    title = $title
    is_on_screen = -not [BopsWindowApi]::IsIconic($hWnd)
    layer = 0
    z_index = (100000 - $z)
    bounds = [pscustomobject]@{ x=$rect.Left; y=$rect.Top; width=$w; height=$h }
  })
  $z++
  return $true
}, [IntPtr]::Zero) | Out-Null
@($items) | ConvertTo-Json -Depth 5 -Compress
`;

let windows: { at: number; list: Win[] } = { at: 0, list: [] };
let windowsPending: Promise<Win[]> | null = null;

const windowsAppName = (name: string) => {
  const map: Record<string, string> = {
    chrome: "Google Chrome",
    msedge: "Microsoft Edge",
    explorer: "File Explorer",
    notepad: "Notepad",
    code: "Visual Studio Code",
    winword: "Word",
    excel: "Excel",
    powerpnt: "PowerPoint",
    outlook: "Outlook",
    teams: "Teams",
    "ms-teams": "Teams",
  };
  return map[name.toLowerCase()] ?? name;
};

async function allWindows() {
  if (Date.now() - windows.at < 1500) return windows.list;
  if (WINDOWS) {
    if (windowsPending) return windowsPending;
    windowsPending = (async () => {
      try {
        const out = await ps(WINDOWS_ENUM, 8000);
        const parsed = out ? (JSON.parse(out) as Win[] | Win) : [];
        const list = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).map((w) => ({ ...w, app_name: windowsAppName(w.process_name ?? w.app_name) }));
        windows = { at: Date.now(), list };
        return list;
      } finally {
        windowsPending = null;
      }
    })();
    return windowsPending;
  }
  const r = await cua<{ windows?: Win[]; structuredContent?: { windows?: Win[] } }>("list_windows", {});
  windows = { at: Date.now(), list: r.windows ?? r.structuredContent?.windows ?? [] };
  return windows.list;
}

const canon = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.exe$/i, "")
    .replace(/microsoft|google|windows|application/g, "")
    .replace(/[^a-z0-9]+/g, "");

const aliases: Record<string, string[]> = {
  googlechrome: ["chrome", "googlechrome"],
  chrome: ["chrome", "googlechrome"],
  microsoftedge: ["msedge", "edge", "microsoftedge"],
  edge: ["msedge", "edge", "microsoftedge"],
  fileexplorer: ["explorer", "fileexplorer"],
  explorer: ["explorer", "fileexplorer"],
  notepad: ["notepad"],
  outlook: ["outlook", "olk"],
};

function matches(win: Win, app: string) {
  const wanted = canon(app);
  const options = new Set([wanted, ...(aliases[wanted] ?? [])].map(canon));
  const owners = [win.app_name, win.process_name ?? ""].map(canon).filter(Boolean);
  return owners.some((owner) => [...options].some((x) => owner === x || owner.includes(x) || x.includes(owner)));
}

/** An app's main window: its biggest normal one, preferring what's visible. */
export async function mainWindow(app: string) {
  const mine = (await allWindows()).filter(
    (w) => matches(w, app) && (w.layer ?? 0) === 0 && (w.bounds?.height ?? 0) > 80 && (w.bounds?.width ?? 0) > 120,
  );
  const area = (w: Win) => (w.bounds?.width ?? 0) * (w.bounds?.height ?? 0) + (w.is_on_screen ? 1e9 : 0);
  return mine.sort((a, b) => area(b) - area(a))[0];
}

/** Every normal window an app has open, frontmost first. */
export async function appWindows(app: string) {
  return (await allWindows())
    .filter(
      (w) => matches(w, app) && (w.layer ?? 0) === 0 && (w.bounds?.height ?? 0) > 80 && (w.bounds?.width ?? 0) > 120,
    )
    .sort((a, b) => Number(b.is_on_screen ?? false) - Number(a.is_on_screen ?? false) || (b.z_index ?? 0) - (a.z_index ?? 0));
}

/** macOS's window-sharing marker has no Windows equivalent. */
export async function sharingMarker(win: Win) {
  if (WINDOWS) return null;
  const b = win.bounds;
  if (b?.x === undefined || b.y === undefined) return null;
  const m = (await allWindows()).find((w) => {
    const c = w.bounds;
    return w.pid === win.pid && w.window_id !== win.window_id && c?.x !== undefined && c.y !== undefined && c.width <= 120 && c.height <= 40 && c.x >= b.x! && c.x < b.x! + 160 && c.y >= b.y! && c.y < b.y! + 60;
  });
  return m?.bounds ? { x: m.bounds.x! - b.x!, y: m.bounds.y! - b.y!, w: m.bounds.width, h: m.bounds.height } : null;
}

const shots = new Map<string, { at: number; png: Buffer; title: string }>();

const windowsCaptureScript = (hwnd: number, max: number) => String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BopsCaptureApi {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
}
"@
$hWnd = [IntPtr]::new([int64]${hwnd})
$r = New-Object BopsCaptureApi+RECT
if (-not [BopsCaptureApi]::GetWindowRect($hWnd, [ref]$r)) { throw "window disappeared" }
$w = [Math]::Max(1, $r.Right - $r.Left)
$h = [Math]::Max(1, $r.Bottom - $r.Top)
$bmp = New-Object Drawing.Bitmap $w, $h, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [BopsCaptureApi]::PrintWindow($hWnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) {
  $g2 = [Drawing.Graphics]::FromImage($bmp)
  $g2.CopyFromScreen($r.Left, $r.Top, 0, 0, [Drawing.Size]::new($w,$h))
  $g2.Dispose()
}
$limit = ${max}
if ([Math]::Max($w,$h) -gt $limit) {
  $scale = $limit / [double][Math]::Max($w,$h)
  $nw = [Math]::Max(1,[int]($w*$scale))
  $nh = [Math]::Max(1,[int]($h*$scale))
  $small = New-Object Drawing.Bitmap $nw,$nh
  $sg = [Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.DrawImage($bmp,0,0,$nw,$nh)
  $sg.Dispose()
  $bmp.Dispose()
  $bmp = $small
}
$ms = New-Object IO.MemoryStream
$bmp.Save($ms,[Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
[Convert]::ToBase64String($ms.ToArray())
$ms.Dispose()
`;

/** A picture of an app's main window, at most `max` pixels on the long edge. */
export async function capture(app: string, max = 640) {
  const key = `${app.toLowerCase()}:${max}`;
  const hit = shots.get(key);
  if (hit && Date.now() - hit.at < 500) return hit;
  const w = await mainWindow(app);
  if (!w) return null;

  if (WINDOWS) {
    const b64 = await ps(windowsCaptureScript(w.window_id, max), 12_000);
    if (!b64) return null;
    const shot = { at: Date.now(), png: Buffer.from(b64, "base64"), title: w.title ?? app };
    shots.set(key, shot);
    return shot;
  }

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

/** Every local app window worth watching, for the Watch picker. */
export async function listWindows() {
  const skip = WINDOWS
    ? /^(Bops|Electron|Program Manager|Windows Shell Experience Host|Search|TextInputHost|Application Frame Host)$/i
    : /^(Bops|Electron|Cua Driver|cua-spacesd|Dock|Window Server|Control Center|Notification Center|CursorUIViewService|Wallpaper)$/i;
  return (await allWindows())
    .filter((w) => (w.layer ?? 0) === 0 && (w.bounds?.height ?? 0) > 120 && (w.bounds?.width ?? 0) > 160 && w.title && !skip.test(w.app_name))
    .sort((a, b) => Number(b.is_on_screen ?? false) - Number(a.is_on_screen ?? false) || (b.z_index ?? 0) - (a.z_index ?? 0))
    .map((w) => ({ app: w.app_name, title: w.title!, windowId: w.window_id }));
}

/** Find a watched window by title, id, or app fallback. */
export async function findWindow(app: string, title: string, windowId?: number) {
  const all = await appWindows(app);
  return all.find((w) => (w.title ?? "") === title) ?? all.find((w) => w.window_id === windowId) ?? all[0];
}

type AxElement = { role?: string; label?: string; value?: string; actions?: string[]; frame?: { x: number; y: number; w: number; h: number } };

const windowsTextScript = (hwnd: number) => String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
$root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([int64]${hwnd}))
if ($null -eq $root) { @() | ConvertTo-Json -Compress; exit }
$all = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
$seen = [Collections.Generic.HashSet[string]]::new()
$lines = [Collections.Generic.List[string]]::new()
for ($i=0; $i -lt $all.Count -and $i -lt 900; $i++) {
  $e = $all.Item($i)
  $name = ""
  try { $name = $e.Current.Name } catch {}
  $value = ""
  try {
    $p = $e.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    if ($p) { $value = $p.Current.Value }
  } catch {}
  foreach ($v in @($name,$value)) {
    if (-not $v) { continue }
    foreach ($part in ($v -split "[\r\n]+")) {
      $t = ($part -replace "\s+"," ").Trim()
      if ($t.Length -lt 2 -or $t.Length -gt 500) { continue }
      if ($seen.Add($t)) { $lines.Add($t.Substring(0,[Math]::Min(300,$t.Length))) }
    }
  }
}
@($lines) | ConvertTo-Json -Compress
`;

/** Text visible to accessibility/UI Automation in a local app window. */
export async function windowText(pid: number, windowId: number) {
  if (WINDOWS) {
    const out = await ps(windowsTextScript(windowId), 20_000);
    if (!out) return [];
    const parsed = JSON.parse(out) as string[] | string;
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  }

  const r = await cua<{ elements?: AxElement[]; structuredContent?: { elements?: AxElement[] } }>(
    "get_window_state",
    { pid, window_id: windowId, include_screenshot: false, max_elements: 900 },
    20_000,
  );
  const elements = r.elements ?? r.structuredContent?.elements ?? [];
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
