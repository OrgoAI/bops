import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The mirrored computer: a live DOM copy of a bot's screen instead of screenshots.
 *
 * rrweb's recorder is injected into the screen's Chrome over CDP (it survives navigations via
 * addScriptToEvaluateOnNewDocument) and reports every DOM change through a CDP binding. We keep
 * the latest full snapshot plus the changes since, so a viewer that joins late gets the current
 * page at once, then streams changes as they happen. The app replays them in a sandboxed iframe
 * (no page scripts run there), so the view is crisp at any size and costs a few KB a second.
 *
 * One DevTools connection to the whole browser follows the bot across tabs: the tab that's on
 * screen (Chrome marks the others hidden) is the one mirrored, and the list of open tabs streams
 * too (as a `bops-tabs` event) so the app can draw them as windows.
 *
 * Works with any reachable Chrome: the Mac's own screens on 127.0.0.1, or an Orgo computer's over
 * the tailnet.
 */

type Event = { type: number; timestamp: number; data?: unknown };
type Listener = (json: string) => void;
type TargetInfo = { targetId: string; type: string; title: string; url: string };
export type Tab = { id: string; title: string; url: string; active: boolean };

const RECORDER = readFileSync(join(process.cwd(), "node_modules/@rrweb/record/dist/record.umd.min.cjs"), "utf8");
const START = `
(() => {
  // Only the top page records; rrweb includes same-origin iframes itself.
  if (window !== window.top || window.__bopsMirror || typeof __bopsEmit !== "function") return;
  window.__bopsMirror = rrwebRecord.record({
    emit: (e) => __bopsEmit(JSON.stringify(e)),
    maskInputOptions: { password: true },
    sampling: { mousemove: 50, scroll: 100, input: "last" },
    slimDOMOptions: "all",
    inlineImages: false,
    recordCanvas: false,
    collectFonts: true,
  });
})();`;
const INJECT = `${RECORDER}\n;${START}`;
const STOP = "window.__bopsMirror && (window.__bopsMirror(), window.__bopsMirror = undefined)";
/** What every tab says when someone clicks or types in it (the bot's tools, or the user taking control): that's where the work is. */
const ACTED = '{"type":"bops-acted"}';
const WATCH_INPUT = `(() => { if (window.__bopsActed) return; window.__bopsActed = true; let last = 0;
  const said = () => { const now = Date.now(); if (now - last < 1000) return; last = now; try { __bopsEmit('${ACTED}'); } catch {} };
  for (const e of ["pointerdown", "keydown", "input"]) addEventListener(e, said, true); })()`;
/** Past this many changes, ask the page for a fresh snapshot so late joiners don't replay a backlog. */
const CHECKOUT_AFTER = 4000;
const IDLE_CLOSE_MS = 30_000;

const isTab = (t: TargetInfo) => t.type === "page" && !/^(devtools|chrome-extension|chrome):/.test(t.url);

class Mirror {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (result: unknown) => void>();
  private buffer: string[] = [];
  private listeners = new Set<Listener>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private retry?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  /** Every open tab, with the DevTools session attached to it. */
  private tabs = new Map<string, TargetInfo & { sessionId?: string }>();
  /** Tabs in the order they opened, so the window bar doesn't reshuffle as the bot moves around. */
  private opened: string[] = [];
  /** When each tab last went to a new address, opened, or was clicked or typed in: the bot's browser tools open pages in windows of their own, all visible at once. */
  private movedAt = new Map<string, number>();
  /** The tab being recorded, and its recorder script (removed when we switch away). */
  private active?: { targetId: string; scriptId?: string };
  private tabsJson = "";
  error?: string;

  constructor(private endpoint: string) {
    void this.connect();
  }

  subscribe(fn: Listener) {
    clearTimeout(this.idleTimer);
    this.listeners.add(fn);
    if (this.tabsJson) fn(this.tabsJson);
    for (const json of this.buffer) fn(json);
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
    };
  }

  /** The tab being mirrored, so input and page reads go to the same one the viewer sees. */
  get activeTarget() {
    return this.active?.targetId;
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ id: this.nextId++, method, params, ...(sessionId ? { sessionId } : {}) }));
  }

  /** Send a command and wait for its result (or undefined if the connection drops or it takes too long). */
  private call<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T | undefined> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(undefined);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(undefined);
      }, 4000);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r as T);
      });
      this.ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  private async connect() {
    if (this.closed) return;
    try {
      const version = (await (await fetch(`http://${this.endpoint}/json/version`, { signal: AbortSignal.timeout(3000) })).json()) as { webSocketDebuggerUrl: string };
      // Chrome names itself by whatever host we asked; pin it to the endpoint we can actually reach.
      const url = version.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${this.endpoint}`);
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.error = undefined;
        this.tabs.clear();
        this.opened = [];
        this.active = undefined;
        this.send("Target.setDiscoverTargets", { discover: true });
        clearInterval(this.poll);
        this.poll = setInterval(() => void this.follow(), 1500);
      };
      ws.onmessage = (e) => this.onMessage(String(e.data));
      ws.onclose = () => {
        if (this.ws === ws) this.ws = undefined;
        clearInterval(this.poll);
        this.scheduleReconnect();
      };
      ws.onerror = () => ws.close();
    } catch (e) {
      this.error = (e as Error).message;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.closed) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), 1500);
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw) as {
      id?: number;
      result?: unknown;
      method?: string;
      sessionId?: string;
      params?: { targetInfo?: TargetInfo; targetId?: string; sessionId?: string; name?: string; payload?: string };
    };
    if (msg.id !== undefined) {
      this.pending.get(msg.id)?.(msg.result);
      this.pending.delete(msg.id);
      return;
    }
    switch (msg.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        const t = msg.params!.targetInfo!;
        if (!isTab(t)) return;
        const known = this.tabs.get(t.targetId);
        this.tabs.set(t.targetId, { ...t, sessionId: known?.sessionId });
        if (!known || known.url !== t.url) {
          this.movedAt.set(t.targetId, Date.now());
          if (known) void this.follow();
        }
        if (!known) {
          this.opened.push(t.targetId);
          // A session on every tab, so we can tell which one is on screen.
          this.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        }
        this.publishTabs();
        return;
      }
      case "Target.targetDestroyed": {
        const id = msg.params!.targetId!;
        this.tabs.delete(id);
        this.movedAt.delete(id);
        this.opened = this.opened.filter((x) => x !== id);
        if (this.active?.targetId === id) this.active = undefined;
        this.publishTabs();
        void this.follow();
        return;
      }
      case "Target.attachedToTarget": {
        const { sessionId, targetInfo } = msg.params!;
        const t = targetInfo && this.tabs.get(targetInfo.targetId);
        if (!t) {
          this.send("Target.detachFromTarget", { sessionId });
          return;
        }
        t.sessionId = sessionId;
        this.send("Runtime.enable", {}, sessionId);
        this.send("Runtime.addBinding", { name: "__bopsEmit" }, sessionId);
        // Every tab says when it's clicked or typed in, now and on each page it goes to.
        this.send("Page.addScriptToEvaluateOnNewDocument", { source: WATCH_INPUT }, sessionId);
        this.send("Runtime.evaluate", { expression: WATCH_INPUT }, sessionId);
        void this.follow();
        return;
      }
      case "Runtime.bindingCalled": {
        if (msg.params?.name === "__bopsEmit" && msg.params.payload === ACTED) {
          const tab = [...this.tabs.values()].find((t) => t.sessionId === msg.sessionId);
          if (tab) this.movedAt.set(tab.targetId, Date.now());
          if (tab && tab.targetId !== this.active?.targetId) void this.follow();
          return;
        }
        const session = this.active && this.tabs.get(this.active.targetId)?.sessionId;
        if (!session || msg.sessionId !== session || msg.params?.name !== "__bopsEmit" || !msg.params.payload) return;
        const json = msg.params.payload;
        const event = JSON.parse(json) as Event;
        // A Meta event opens each new page (or checkout): it and the full snapshot after it replace the backlog.
        if (event.type === 4) this.buffer = [json];
        else this.buffer.push(json);
        if (this.buffer.length > CHECKOUT_AFTER) {
          this.buffer = [];
          this.send("Runtime.evaluate", { expression: "window.rrwebRecord && rrwebRecord.record.takeFullSnapshot(true)" }, session);
        }
        for (const fn of this.listeners) fn(json);
        return;
      }
    }
  }

  /**
   * Mirror the tab that's actually on screen: Chrome marks background tabs hidden, so this follows
   * the bot when it opens or switches tabs, and ignores busy tabs left open behind it.
   */
  private following = false;
  private async follow() {
    if (this.following || this.closed) return;
    this.following = true;
    try {
      const tabs = this.opened.map((id) => this.tabs.get(id)).filter((t): t is TargetInfo & { sessionId: string } => !!t?.sessionId);
      if (!tabs.length) return;
      const states = await Promise.all(
        tabs.map((t) => this.call<{ result: { value?: string } }>("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, t.sessionId)),
      );
      const visible = tabs.filter((_, i) => states[i]?.result?.value === "visible");
      const current = this.active && tabs.find((t) => t.targetId === this.active!.targetId);
      // The visible tab; when several are (each page the bot's browser tools open is a window of its
      // own), the one that went somewhere or was clicked or typed in last, which is where the bot is: staying on the first would
      // leave the viewer, and the screen watch that signs the bot in, on a page it left behind.
      const at = (t: { targetId: string }) => this.movedAt.get(t.targetId) ?? 0;
      const seed = current && visible.includes(current) ? current : visible.at(-1);
      const latest = seed && visible.reduce((a, t) => (at(t) > at(a) ? t : a), seed);
      if (current && latest === current) return;
      // Else the newest tab.
      const next = latest ?? (current ? undefined : tabs.at(-1));
      if (next && next.targetId !== this.active?.targetId) await this.record(next);
    } finally {
      this.following = false;
    }
  }

  /** Move the recorder to this tab: stop it on the old one, start it (and keep it across navigations) here. */
  private async record(tab: TargetInfo & { sessionId: string }) {
    const old = this.active && this.tabs.get(this.active.targetId);
    if (old?.sessionId) {
      this.send("Runtime.evaluate", { expression: STOP }, old.sessionId);
      if (this.active?.scriptId) this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.active.scriptId }, old.sessionId);
    }
    this.active = { targetId: tab.targetId };
    this.publishTabs();
    this.send("Page.enable", {}, tab.sessionId);
    this.send("Page.setBypassCSP", { enabled: true }, tab.sessionId);
    const added = await this.call<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source: INJECT }, tab.sessionId);
    if (this.active?.targetId === tab.targetId) this.active.scriptId = added?.identifier;
    this.send("Runtime.evaluate", { expression: `${STOP};\n${INJECT}` }, tab.sessionId);
  }

  private publishTabs() {
    const tabs: Tab[] = this.opened.flatMap((x) => this.tabs.get(x) ?? []).map((t) => ({ id: t.targetId, title: t.title, url: t.url, active: t.targetId === this.active?.targetId }));
    this.tabsJson = JSON.stringify({ type: "bops-tabs", tabs });
    for (const fn of this.listeners) fn(this.tabsJson);
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearTimeout(this.idleTimer);
    clearInterval(this.poll);
    // Stop the recorder in the page; the injected script goes away with this DevTools connection.
    const session = this.active && this.tabs.get(this.active.targetId)?.sessionId;
    if (session) this.send("Runtime.evaluate", { expression: STOP }, session);
    setTimeout(() => this.ws?.close(), 200);
    mirrors().delete(this.endpoint);
  }
}

const mirrors = (): Map<string, Mirror> => ((globalThis as { __bopsMirrors4?: Map<string, Mirror> }).__bopsMirrors4 ??= new Map());

/** The mirror for one screen's Chrome ("host:port"), started on first use. */
export function mirror(endpoint: string) {
  let m = mirrors().get(endpoint);
  if (!m) mirrors().set(endpoint, (m = new Mirror(endpoint)));
  return m;
}

/**
 * Close every mirror (a sign-out, or another account signing in): each keeps the last page it saw,
 * and the next account's bot on the same port would be shown it before its own.
 */
export function closeMirrors() {
  for (const m of [...mirrors().values()]) m.close();
}

/** The tab a screen's mirror is showing, if it's running. */
export const mirroredTarget = (endpoint: string) => mirrors().get(endpoint)?.activeTarget;
