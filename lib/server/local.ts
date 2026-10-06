import "server-only";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DISPLAYS } from "@/lib/types";
import { executorKey } from "./cloud";
import { mirroredTarget } from "./mirror";

/**
 * Local Mac host. Each bot's "screen" is its own background Chrome on the user's Mac, with its own
 * profile and debugging port, so sessions browse from their home IP instead of a datacenter.
 * It runs headless (no windows on their screen; the app's live view shows it) and the agent
 * drives it through Playwright MCP over CDP, so it never takes their mouse.
 * Set BOPS_CHROME_WINDOWS=1 to see the windows instead.
 */

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const BOPS_HOME = join(homedir(), ".bops");
export const WORKSPACE = join(BOPS_HOME, "workspace");
const CHROME_VERSION = (() => {
  try {
    return execFileSync("defaults", ["read", "/Applications/Google Chrome.app/Contents/Info", "CFBundleShortVersionString"])
      .toString()
      .trim();
  } catch {
    return "154.0.0.0";
  }
})();
/** Headless Chrome announces itself as "HeadlessChrome"; present as the normal Mac browser. */
const USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION.split(".")[0]}.0.0.0 Safari/537.36`;
const PLAYWRIGHT_MCP = join(process.cwd(), "node_modules/@playwright/mcp/cli.js");

/** One port per bot screen: 9300 + 10 per bot + screen index. */
export const cdpPort = (botIndex: number, display: number) => 9300 + botIndex * 10 + DISPLAYS.indexOf(display);

async function cdpUp(port: number) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

/** Start the screen's Chrome if it isn't already running. */
export async function ensureChrome(botId: string, port: number) {
  if (await cdpUp(port)) return;
  const profile = join(BOPS_HOME, "chrome", `${botId}-${port}`);
  mkdirSync(profile, { recursive: true });
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
    { detached: true, stdio: "ignore" },
  ).unref();
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
 * The environment for Codex, whose agent runs the user's own commands on this Mac: the server's,
 * minus what only makes the server run. ELECTRON_RUN_AS_NODE would make any Electron app the agent
 * starts by its binary run as Node instead, and NODE_ENV=production would make `npm install` skip
 * dev dependencies.
 */
const SERVER_ONLY_ENV = new Set(["ELECTRON_RUN_AS_NODE", "BOPS_SERVER_JS", "NODE_ENV"]);
export function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries({ ...process.env, ...extra }).filter(([k]) => !SERVER_ONLY_ENV.has(k))) as NodeJS.ProcessEnv;
}

/** The agent's browser tools for one screen, run by the executor on this Mac. */
export const browserMcp = (port: number) => {
  const args = [PLAYWRIGHT_MCP, "--cdp-endpoint", `http://127.0.0.1:${port}`];
  // The executor's environment doesn't carry ELECTRON_RUN_AS_NODE (agentEnv), so it's set here.
  return asNode
    ? { type: "stdio", command: "/usr/bin/env", args: ["ELECTRON_RUN_AS_NODE=1", process.execPath, ...args], cwd: WORKSPACE }
    : { type: "stdio", command: process.execPath, args, cwd: WORKSPACE };
};

/** Start `codex exec-server` for one session; it dials out to OpenAI and runs the agent's tools here. */
export async function startExecutor(envId: string, remoteUrl: string, port: number): Promise<ChildProcess> {
  mkdirSync(join(WORKSPACE, "capabilities/skills"), { recursive: true });
  const key = await executorKey();
  const child = spawn("codex", ["exec-server", "--remote", remoteUrl, "--environment-id", envId], {
    cwd: WORKSPACE,
    env: agentEnv({ CODEX_API_KEY: key, BOPS_CDP_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
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

/** A screen's Chrome: a port on this Mac, or "host:port" anywhere reachable (an Orgo computer on the tailnet). */
export type Endpoint = number | string;
const hostPort = (ep: Endpoint) => (typeof ep === "number" ? `127.0.0.1:${ep}` : ep);

type PageTarget = { id: string; type: string; url: string; webSocketDebuggerUrl: string };

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

/** The tab that's on screen: the one the mirror follows, else whichever Chrome reports visible. */
async function screenPage(base: string): Promise<PageTarget> {
  const targets = (await (await fetch(`http://${base}/json/list`, { signal: AbortSignal.timeout(3000) })).json()) as PageTarget[];
  const pages = targets.filter((t) => t.type === "page" && !/^(devtools|chrome-extension|chrome):/.test(t.url));
  if (!pages.length) throw new Error("no page");
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
  const r = await cdp<{ result: { value?: string } }>(ep, "Runtime.evaluate", { expression, returnByValue: true });
  return JSON.parse(r.result.value ?? "{}") as { url: string; title: string; text: string; fields: PageField[]; buttons: PageButton[] };
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

/** Type into one tagged field (see pageText), replacing what's there. The value goes straight to the page. */
export async function fillField(ep: Endpoint, fieldId: string, value: string) {
  const r = await cdp<{ result: { value?: boolean } }>(ep, "Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector('[data-bops-field="${tag(fieldId)}"]'); if (!el) return false; el.focus();
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

/** The address the screen's active tab is on. */
/** The page a screen's Chrome is showing: its address and title. */
export async function currentPage(ep: Endpoint) {
  const targets = (await (await fetch(`http://${hostPort(ep)}/json/list`, { signal: AbortSignal.timeout(2000) })).json()) as { type: string; url: string; title: string }[];
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
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
