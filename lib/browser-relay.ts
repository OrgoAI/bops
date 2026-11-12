import WebSocket from "ws";
import { probeInput, probeTiming } from "@/cloud/browser-probe";
import { isBrowserMethod, POINTER_KINDS, type BrowserActivity, type BrowserFrameMeta, type BrowserPerson, type BrowserPointer, type BrowserTab, type BrowserToRunner, type RunnerToBrowser } from "@/cloud/protocol";

/**
 * The bot's browser, relayed (cloud/protocol.ts "The bot's browser"). Runs where the bot's Chrome is: in a computer's
 * runner (lib/server/browser-runner.ts), and in the local two-person stack's stand-in computer
 * (scripts/dev-two-person.mjs), the same code both places.
 *
 * - It keeps a socket to Bops Cloud (WS /v1/browser/runner, signed in as the computer), which tells it who watches
 *   each bot's browser now ("watch").
 * - A bot watched: the screen its task holds (`screenFor`) is captured, as a CDP screencast of the tab in front of
 *   that screen's Chrome (DevTools on 127.0.0.1, port 9200 + display), and each frame goes to Bops Cloud for those
 *   viewers, never kept anywhere but as the screen's latest (sent again to someone who starts watching). Nobody
 *   watching, no frame is sent; LINGER_MS after the last viewer left, the capture stops.
 * - Take over: one person at a time has control of a screen (Bops Cloud let only someone who may: cloud/browser.ts),
 *   and the runner's own takeover goes with it (`onControl`: the thread on that screen pauses, as when the owner takes
 *   it over, and goes on once it's handed back). While they have it, a bot step that asks (`whenFree`) waits. They
 *   hand it back, or it goes back when they stop watching. The owner can take it from a member (Bops Cloud says so:
 *   `over`); a member never takes it from anyone.
 * - What the bot is doing with a screen's browser (`activity`: browsing, idle, a sign-in it asked a person for), and
 *   whether a step waits on whoever has control: said to Bops Cloud as it changes, watched or not, so a Watch chip can
 *   say the bot is browsing before anyone watches (nothing is captured for that).
 * - In control, they send CDP input: only BROWSER_METHODS, each with its parameters checked (cleanInput: a page to
 *   go to is http or https only). Anything else is refused here, whatever Bops Cloud passed on.
 * - Its tabs: a captured screen's Chrome's tabs ("tabs": id, title, address, oldest first, and which is in front) go to
 *   its viewers as they change. In control, a person opens a new tab at a page, switches to or closes a tab it listed
 *   (through the DevTools address, never a CDP session on the browser), and handing back puts the tab the bot had in
 *   front when they took over in front again, so the bot carries on where it was.
 * - Where the pointer goes: while captured, the page's own trusted pointer events (moves at most 30 a second, presses,
 *   releases, scrolls) are watched from a world of the relay's own (POINTER_WORLD) that the page's scripts can't see
 *   or reach, and each goes to the viewers labelled with who drove it: the person in control, else the bot. So the bot's
 *   cursor shows however it moves (xdotool on the screen, Playwright over CDP), and so does a person's. Never kept.
 *
 * Its dependencies are `ws`, the protocol and optional safe timing logs; plain Node runs it as well as Next.
 */

export { BOPS_DEVICE_HEADER as DEVICE_HEADER } from "@/cloud/protocol";

/** How long a screen keeps capturing after its last viewer leaves (someone coming back within it sees it at once). */
export const LINGER_MS = 5_000;
/** How often a captured screen looks for another tab in front. */
const FRONT_EVERY_MS = 1_500;
/** Frames waiting to go out past this are dropped (a slow link): the next frame says the same. */
const BACKLOG_BYTES = 4 * 1024 * 1024;
/** A person in control whose socket to Bops Cloud is gone this long has it handed back (nothing would let them hand it back otherwise). */
const LOST_CONTROL_MS = 60_000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * The world the pointer is watched from, and the binding it reports on: an isolated world (Chrome's, as an extension's
 * content script has), so nothing of either is in the page's own: no global, no listener its scripts can find or stop.
 */
export const POINTER_WORLD = "bops-pointer";
export const POINTER_BINDING = "bopsPointer";
/**
 * Run at the start of each document of the tab, in POINTER_WORLD (and once in the one there when capture starts): the
 * top frame's trusted pointer events as "kind,x,y" (CSS pixels of the viewport, as the frame is), moves and scrolls at
 * most every 33 ms with the last always sent, a press or release at once and after any move held back. The binding is
 * looked up at each event, as it's added again after a navigation (Screen.arm). Once a world: a capture started again
 * on the same page finds it watching.
 */
const POINTER_SCRIPT = `(() => {
  if (window !== window.top || globalThis.__bopsPointerOn) return;
  globalThis.__bopsPointerOn = true;
  let last = 0, timer = 0, held = "";
  const say = (s) => { const f = globalThis[${JSON.stringify(POINTER_BINDING)}]; if (typeof f === "function") f(s); };
  const of = (k, e) => k + "," + Math.round(e.clientX * 10) / 10 + "," + Math.round(e.clientY * 10) / 10;
  const flush = () => { clearTimeout(timer); timer = 0; if (!held) return; last = Date.now(); const s = held; held = ""; say(s); };
  const often = (k) => (e) => { if (!e.isTrusted) return; held = of(k, e); const wait = 33 - (Date.now() - last); if (wait <= 0) flush(); else if (!timer) timer = setTimeout(flush, wait); };
  const now = (k) => (e) => { if (!e.isTrusted) return; flush(); say(of(k, e)); };
  const o = { capture: true, passive: true };
  addEventListener("pointermove", often("move"), o);
  addEventListener("wheel", often("wheel"), o);
  addEventListener("pointerdown", now("down"), o);
  addEventListener("pointerup", now("up"), o);
})()`;

/** The bot's chat's line when someone hands its browser back (a runner's, lib/server/browser-runner.ts, and the two-person stand-in's). */
export const handedBack = (person: string, bot: string) => `${person.trim().split(/\s+/)[0] || person} handed back. ${bot} carries on.`;

/** One "kind,x,y" the pointer world said, checked (it's the page's own world's events, never anything a page can send). */
export function pointerOf(payload: unknown): BrowserPointer | null {
  if (typeof payload !== "string" || payload.length > 64) return null;
  const [kind, xs, ys] = payload.split(",");
  const x = Number(xs);
  const y = Number(ys);
  if (!(POINTER_KINDS as readonly string[]).includes(kind) || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 20_000 || Math.abs(y) > 20_000) return null;
  return { kind: kind as BrowserPointer["kind"], x, y };
}

export type RelayScreen = { display: number; port: number };
export type RelayOptions = {
  /** Bops Cloud's address (http or https). */
  url: () => string;
  /** The computer's sign-in for Bops Cloud (Authorization and device), or null while it has none. */
  headers: () => Record<string, string> | null;
  /** The computer's screens and their Chrome's DevTools ports. */
  screens: () => RelayScreen[];
  /** The screen a bot's task holds now (else the one it last used), or null: its first screen. */
  screenFor: (botId: string) => number | null;
  /** A person took control of a screen for a bot (`who`), or handed it back (null); `was`: who had it before. */
  onControl?: (botId: string, display: number, who: BrowserPerson | null, was: BrowserPerson | null) => void;
  log?: (m: string) => void;
  /** Tests: a shorter linger, and a shorter wait before someone cut off with control has it handed back. */
  lingerMs?: number;
  lostMs?: number;
};

export type Relay = {
  /** Resolves once nobody has control of the screen (at once when nobody has). */
  whenFree: (display: number) => Promise<void>;
  /** Who has control of a screen now. */
  heldBy: (display: number) => BrowserPerson | null;
  /**
   * What `bot`'s step is doing with that screen's browser now: browsing or idle, a sign-in it asked a person to do there
   * (the page's address), and `waiting`: work of its waits on whoever has control (a runner's thread paused by a take
   * over; a step waiting in `whenFree` says so by itself).
   */
  activity: (display: number, bot: string, doing: { step: BrowserActivity["step"]; signIn?: string | null; waiting?: boolean }) => void;
  /** What it's doing (the stack's control port, tests). */
  status: () => { connected: boolean; screens: { display: number; capturing: boolean; watchers: string[]; heldBy: BrowserPerson | null; framesSent: number }[] };
  stop: () => Promise<void>;
};

/* ---------------- What a person in control may send ---------------- */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
const int = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) ? num(v, lo, hi) : undefined);
const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);
const MOUSE = ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"];
const BUTTONS = ["none", "left", "middle", "right"];
const KEYS = ["keyDown", "keyUp", "rawKeyDown", "char"];

/**
 * One CDP input a person in control sent, as it's dispatched: only BROWSER_METHODS, only the parameters each needs, each
 * checked (anything else left out); null when it isn't one, or it's out of bounds. A page to go to: http or https only,
 * never javascript:, file:, chrome: or the like.
 */
export function cleanInput(method: string, params: unknown): Record<string, unknown> | null {
  if (!isBrowserMethod(method)) return null;
  const p = isObject(params) ? params : {};
  const keep = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  switch (method) {
    case "Input.dispatchMouseEvent": {
      const x = num(p.x, 0, 20_000);
      const y = num(p.y, 0, 20_000);
      if (!MOUSE.includes(p.type as string) || x === undefined || y === undefined) return null;
      const wheel = p.type === "mouseWheel";
      return keep({
        type: p.type,
        x,
        y,
        button: BUTTONS.includes(p.button as string) ? p.button : "none",
        clickCount: int(p.clickCount, 0, 3) ?? 0,
        modifiers: int(p.modifiers, 0, 15),
        deltaX: wheel ? (num(p.deltaX, -10_000, 10_000) ?? 0) : undefined,
        deltaY: wheel ? (num(p.deltaY, -10_000, 10_000) ?? 0) : undefined,
      });
    }
    case "Input.dispatchKeyEvent": {
      if (!KEYS.includes(p.type as string)) return null;
      return keep({
        type: p.type,
        key: str(p.key, 32),
        code: str(p.code, 32),
        text: str(p.text, 8),
        unmodifiedText: str(p.unmodifiedText, 8),
        windowsVirtualKeyCode: int(p.windowsVirtualKeyCode, 0, 255),
        nativeVirtualKeyCode: int(p.nativeVirtualKeyCode, 0, 255),
        modifiers: int(p.modifiers, 0, 15),
        autoRepeat: typeof p.autoRepeat === "boolean" ? p.autoRepeat : undefined,
        location: int(p.location, 0, 3),
      });
    }
    case "Input.insertText": {
      const text = str(p.text, 10_000);
      return text ? { text } : null;
    }
    case "Page.navigate": {
      const raw = str(p.url, 4096);
      if (!raw) return null;
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        return null;
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      // Never the ports of this computer's own DevTools, Bops or the relay, on any host: a page there acts on the browser
      // past these rules, and too many names reach this computer to tell them apart (localhost., *.localhost, any 127
      // address, an IPv4 in IPv6, a public name pointed here).
      const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
      if (port === 3210 || port === 8897 || (port >= 9200 && port <= 9399)) return null;
      return { url: u.href };
    }
    case "Page.reload":
      return {};
    case "Page.navigateToHistoryEntry": {
      const entryId = int(p.entryId, 0, 2 ** 31 - 1);
      return entryId === undefined ? null : { entryId };
    }
    case "Target.createTarget": {
      const page = cleanInput("Page.navigate", { url: p.url });
      return page ? { url: page.url } : null;
    }
    case "Target.activateTarget":
    case "Target.closeTarget": {
      const targetId = str(p.targetId, 64);
      return targetId && /^[A-Za-z0-9]+$/.test(targetId) ? { targetId } : null;
    }
  }
  return null;
}

/* ---------------- CDP on one tab ---------------- */

type Target = { id: string; type: string; url: string; title: string };
const isTab = (t: Target) => t.type === "page" && !/^(devtools|chrome-extension|chrome):/.test(t.url);

/** The tabs of a screen's Chrome, the one used last first (Chrome's DevTools list puts it first: vm/page-script.cjs front). */
async function tabsOf(port: number): Promise<Target[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) });
  return ((await res.json()) as Target[]).filter(isTab);
}

/** The tabs a screen's browser may have for a person to open another, and that a viewer is told of: at most this many. */
const TABS_MAX = 20;


/** One of Chrome's DevTools address calls on a screen (a new tab, a switch, a close): it said yes, or why not. */
async function devtools(port: number, path: string, method: "GET" | "PUT" = "GET"): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error("The browser didn't do that.");
}

/** A CDP session on one tab: calls answered by id, events by name. */
class Cdp {
  private ws: WebSocket;
  private next = 1;
  private calls = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
  private handlers = new Map<string, (params: Record<string, unknown>) => void>();
  readonly opened: Promise<void>;
  closed = false;
  constructor(url: string, onClose: () => void) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.opened = new Promise((ok, no) => {
      this.ws.once("open", () => ok());
      this.ws.once("error", (e) => no(e));
    });
    this.ws.on("message", (data) => {
      let m: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown> };
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m.id !== undefined) {
        const c = this.calls.get(m.id);
        this.calls.delete(m.id);
        if (m.error) c?.no(new Error(m.error.message ?? "CDP error"));
        else c?.ok(m.result);
      } else if (m.method) this.handlers.get(m.method)?.(m.params ?? {});
    });
    this.ws.on("close", () => {
      this.closed = true;
      for (const c of this.calls.values()) c.no(new Error("The tab closed"));
      this.calls.clear();
      onClose();
    });
    this.ws.on("error", () => {});
  }
  on(event: string, fn: (params: Record<string, unknown>) => void) {
    this.handlers.set(event, fn);
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The tab closed"));
    const id = this.next++;
    return new Promise<T>((ok, no) => {
      this.calls.set(id, { ok: ok as (v: unknown) => void, no });
      this.ws.send(JSON.stringify({ id, method, params }), (e) => e && no(e));
    });
  }
  close() {
    this.closed = true;
    this.ws.terminate();
  }
}

/* ---------------- One screen ---------------- */

class Screen {
  /** The bots watched on this screen, and who watches each. */
  readonly bots = new Map<string, BrowserPerson[]>();
  controller: { who: BrowserPerson; bot: string } | null = null;
  private cdp: Cdp | null = null;
  private tab: string | null = null;
  private front?: ReturnType<typeof setInterval>;
  private linger?: ReturnType<typeof setTimeout>;
  private attaching: Promise<void> | null = null;
  private waiters: (() => void)[] = [];
  /** What the bot is doing with this screen's browser, and which bot (Relay.activity); null till it says. */
  doing: { bot: string; step: BrowserActivity["step"]; signIn: string | null; waiting: boolean } | null = null;
  private said = "";
  last: { frame?: { data: string; meta: BrowserFrameMeta }; page?: { url: string; title: string; back: number | null }; tabs?: { tabs: BrowserTab[]; front: string | null } } = {};
  /** The order tabs were first seen in (a viewer's strip never reorders as the front changes), numbered as they come. */
  private seen = new Map<string, number>();
  private seenNext = 0;
  /** The tab in front when someone took control: in front again once they hand back. */
  private botTab: string | null = null;
  /** Putting the bot's tab in front after a hand back, until done. */
  private restoring: Promise<void> | null = null;
  /** Tab acts one at a time, so two new tabs at once never pass the cap together. */
  private acting: Promise<void> = Promise.resolve();
  framesSent = 0;
  readonly display: number;
  private port: () => number | null;
  private relay: RelayCore;
  constructor(display: number, port: () => number | null, relay: RelayCore) {
    this.display = display;
    this.port = port;
    this.relay = relay;
  }

  get capturing() {
    return !!this.front;
  }
  watchers() {
    return [...this.bots].filter(([, v]) => v.length).map(([bot]) => bot);
  }
  watchedBy(id: string) {
    return [...this.bots.values()].some((v) => v.some((p) => p.id === id));
  }

  /** Someone watches: capture (again), and stop any linger. */
  watch() {
    if (this.linger) clearTimeout(this.linger);
    this.linger = undefined;
    if (this.front) return;
    this.front = setInterval(() => void this.attach(), FRONT_EVERY_MS);
    this.front.unref?.();
    void this.attach();
  }

  /** Nobody watches: the capture stops after the linger, unless someone comes back. */
  unwatched() {
    if (this.watchers().length || this.linger || !this.front) return;
    this.linger = setTimeout(() => this.stopCapture(), this.relay.lingerMs);
    this.linger.unref?.();
  }

  stopCapture() {
    if (this.linger) clearTimeout(this.linger);
    this.linger = undefined;
    if (this.front) clearInterval(this.front);
    this.front = undefined;
    const c = this.cdp;
    this.cdp = null;
    this.tab = null;
    if (c && !c.closed) void c.send("Page.stopScreencast").catch(() => {}).finally(() => c.close());
    this.last = {};
  }

  /** The tab in front, captured: attached again when another comes to the front or this one closes. */
  private attach(): Promise<void> {
    if (this.attaching) return this.attaching;
    const run = async () => {
      const port = this.port();
      if (port === null || !this.front) return;
      const tabs = await tabsOf(port).catch(() => [] as Target[]);
      const top = tabs[0];
      if (!top) return;
      this.sayTabs(tabs);
      if (this.tab === top.id && this.cdp && !this.cdp.closed) {
        const page = this.last.page;
        if (page && page.title !== top.title) this.page({ ...page, title: top.title });
        return;
      }
      this.cdp?.close();
      const cdp = new Cdp(`ws://127.0.0.1:${port}/devtools/page/${top.id}`, () => {
        if (this.cdp === cdp) {
          this.cdp = null;
          this.tab = null;
        }
      });
      this.cdp = cdp;
      this.tab = top.id;
      await cdp.opened;
      cdp.on("Page.screencastFrame", (p) => {
        void cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
        if (this.cdp !== cdp) return;
        const frame = { data: String(p.data ?? ""), meta: p.metadata as BrowserFrameMeta };
        probeTiming("source_frame", { timestamp: frame.meta.timestamp, bytes: Buffer.byteLength(frame.data, "base64") });
        this.last.frame = frame;
        if (this.watchers().length && this.relay.send({ t: "frame", bots: this.watchers(), ...frame }, true)) this.framesSent++;
      });
      const changed = () => void this.readPage(cdp, port);
      // A new document's pointer world needs the binding again (Screen.arm): as it's committed, and again once its
      // scripts have run (the world is made at its start, which can come either side of the first).
      cdp.on("Page.frameNavigated", (p) => {
        if (isObject(p.frame) && p.frame.parentId) return;
        changed();
        this.arm(cdp);
      });
      cdp.on("Page.domContentEventFired", () => this.arm(cdp));
      cdp.on("Page.navigatedWithinDocument", changed);
      cdp.on("Page.loadEventFired", changed);
      cdp.on("Runtime.bindingCalled", (p) => {
        if (p.name !== POINTER_BINDING || this.cdp !== cdp) return;
        const at = pointerOf(p.payload);
        if (at && this.watchers().length) this.relay.send({ t: "pointer", bots: this.watchers(), by: this.controller?.who ?? null, ...at }, at.kind === "move" || at.kind === "wheel");
      });
      await cdp.send("Page.enable");
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: POINTER_SCRIPT, worldName: POINTER_WORLD, runImmediately: true });
      await this.arm(cdp);
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
      await this.readPage(cdp, port);
    };
    this.attaching = run()
      .catch((e: Error) => this.relay.log(`screen ${this.display}: ${e.message}`))
      .finally(() => (this.attaching = null));
    return this.attaching;
  }

  /**
   * The pointer world's binding, in the worlds of that name the tab has now: Chrome adds it only while Runtime is on,
   * so on just for that, never left on (nothing of the page's console comes here). One at a time, so two never interleave.
   */
  private arming: Promise<void> = Promise.resolve();
  private arm(cdp: Cdp): Promise<void> {
    this.arming = this.arming
      .then(async () => {
        if (cdp.closed) return;
        await cdp.send("Runtime.enable");
        try {
          await cdp.send("Runtime.addBinding", { name: POINTER_BINDING, executionContextName: POINTER_WORLD });
        } finally {
          await cdp.send("Runtime.disable");
        }
      })
      .catch(() => {});
    return this.arming;
  }

  /** Where the tab is, its title, and the history entry Back goes to. */
  private async readPage(cdp: Cdp, port: number) {
    const h = await cdp.send<{ currentIndex: number; entries: { id: number; url: string; title: string }[] }>("Page.getNavigationHistory").catch(() => null);
    if (!h || this.cdp !== cdp) return;
    const at = h.entries[h.currentIndex];
    const title = (await tabsOf(port).catch(() => [] as Target[])).find((t) => t.id === this.tab)?.title ?? at?.title ?? "";
    this.page({ url: at?.url ?? "", title, back: h.currentIndex > 0 ? (h.entries[h.currentIndex - 1]?.id ?? null) : null });
  }

  private page(p: { url: string; title: string; back: number | null }) {
    this.last.page = p;
    if (this.watchers().length) this.relay.send({ t: "page", bots: this.watchers(), ...p });
  }

  /** What a viewer who just came sees at once: the latest frame and page, and who has control. */
  catchUp(bots: string[]) {
    if (this.last.page) this.relay.send({ t: "page", bots, ...this.last.page });
    if (this.last.tabs) this.relay.send({ t: "tabs", bots, ...this.last.tabs });
    if (this.last.frame && this.relay.send({ t: "frame", bots, ...this.last.frame }, true)) this.framesSent++;
    this.relay.send({ t: "control", bots, by: this.controller?.who ?? null });
  }

  setController(next: { who: BrowserPerson; bot: string } | null) {
    const was = this.controller;
    this.controller = next;
    if (next && !was) this.botTab = this.last.tabs?.front ?? this.tab;
    if (this.watchers().length) this.relay.send({ t: "control", bots: this.watchers(), by: next?.who ?? null });
    if (next) this.relay.onControl(next.bot, this.display, next.who, was?.who ?? null);
    else if (was) {
      // Handed back: what they'd asked of the tabs done, the bot's own tab in front again, then the bot goes on (its
      // thread, and any step waiting).
      const restoring = this.acting
        .then(() => this.backToBotTab())
        .catch(() => {})
        .finally(() => {
          if (this.restoring === restoring) this.restoring = null;
          if (this.controller) return;
          this.relay.onControl(was.bot, this.display, null, was.who);
          for (const w of this.waiters.splice(0)) w();
          this.sayDoing();
        });
      this.restoring = restoring;
    }
  }

  whenFree(): Promise<void> {
    // Handed back but the bot's own tab not in front yet: once it is.
    if (!this.controller && this.restoring) return this.restoring.then(() => this.whenFree());
    if (!this.controller) return Promise.resolve();
    const freed = new Promise<void>((r) => this.waiters.push(r));
    this.sayDoing();
    return freed;
  }

  /** What the bot is doing here, to Bops Cloud, when it changed (or `again`: a new socket): its viewers hear it, watching or not. */
  sayDoing(again = false) {
    const bot = this.doing?.bot ?? this.controller?.bot;
    if (!bot) return;
    const a: BrowserActivity = { step: this.doing?.step ?? "idle", waiting: this.waiters.length > 0 || !!this.doing?.waiting, signIn: this.doing?.signIn ?? null };
    const key = JSON.stringify([bot, a]);
    if (key === this.said && !again) return;
    if (this.relay.send({ t: "activity", bots: [bot], ...a })) this.said = key;
  }

  input(method: string, params: Record<string, unknown>) {
    if (method.startsWith("Target.")) return this.tabAct(method, params);
    if (!this.cdp || this.cdp.closed) return Promise.reject(new Error("The page isn't there right now."));
    return this.cdp.send(method, params);
  }

  /** The browser's tabs, to its viewers when they change: oldest first (as first seen), at most TABS_MAX, and the one in front. */
  private sayTabs(tabs: Target[]) {
    for (const t of tabs) if (!this.seen.has(t.id)) this.seen.set(t.id, this.seenNext++);
    const open = new Set(tabs.map((t) => t.id));
    for (const id of this.seen.keys()) if (!open.has(id)) this.seen.delete(id);
    const listed = [...tabs].sort((a, b) => this.seen.get(a.id)! - this.seen.get(b.id)!).slice(0, TABS_MAX);
    const next = { tabs: listed.map((t) => ({ id: t.id, title: t.title.slice(0, 200), url: t.url.slice(0, 2048) })), front: tabs[0]?.id ?? null };
    if (JSON.stringify(next) === JSON.stringify(this.last.tabs)) return;
    this.last.tabs = next;
    if (this.watchers().length) this.relay.send({ t: "tabs", bots: this.watchers(), ...next });
  }

  /** A person's tab act: a new tab at a page, or a switch to or close of a tab this screen listed. The capture follows at once. */
  private tabAct(method: string, params: Record<string, unknown>): Promise<void> {
    const run = this.acting.then(() => this.tabActNow(method, params));
    this.acting = run.catch(() => {});
    return run;
  }

  private async tabActNow(method: string, params: Record<string, unknown>) {
    const port = this.port();
    if (port === null) throw new Error("The page isn't there right now.");
    if (method === "Target.createTarget") {
      if ((await tabsOf(port)).length >= TABS_MAX) throw new Error(`${TABS_MAX} tabs are open. Close one first.`);
      await devtools(port, `/json/new?${encodeURIComponent(String(params.url))}`, "PUT");
    }
    else {
      const id = String(params.targetId);
      if (!(await tabsOf(port)).some((t) => t.id === id)) throw new Error("That tab isn't open.");
      await devtools(port, `/json/${method === "Target.activateTarget" ? "activate" : "close"}/${id}`);
    }
    await this.attach();
  }

  /** Hand back: the tab the bot had in front when they took over is in front again (if it's still open). */
  private async backToBotTab() {
    const id = this.botTab;
    this.botTab = null;
    const port = this.port();
    if (!id || port === null) return;
    const tabs = await tabsOf(port).catch(() => [] as Target[]);
    if (tabs[0]?.id === id || !tabs.some((t) => t.id === id)) return;
    await devtools(port, `/json/activate/${id}`).catch(() => {});
    await this.attach();
  }
}

/* ---------------- The relay ---------------- */

class RelayCore {
  readonly lingerMs: number;
  private socket: WebSocket | null = null;
  private screens = new Map<number, Screen>();
  /** Which screen each watched bot is shown on. */
  private botScreen = new Map<string, number>();
  private retry = RECONNECT_MIN_MS;
  private reconnect?: ReturnType<typeof setTimeout>;
  private lost?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private o: RelayOptions;
  constructor(o: RelayOptions) {
    this.o = o;
    this.lingerMs = o.lingerMs ?? LINGER_MS;
    this.connect();
  }

  log(m: string) {
    this.o.log?.(m);
  }
  onControl(bot: string, display: number, who: BrowserPerson | null, was: BrowserPerson | null) {
    try {
      this.o.onControl?.(bot, display, who, was);
    } catch (e) {
      this.log(`control: ${(e as Error).message}`);
    }
  }
  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** To Bops Cloud; a frame (`droppable`) is left out while the link is backed up. Whether it went. */
  send(m: RunnerToBrowser, droppable = false): boolean {
    const s = this.socket;
    if (!s || s.readyState !== WebSocket.OPEN) return false;
    if (droppable && s.bufferedAmount > BACKLOG_BYTES) return false;
    s.send(JSON.stringify(m));
    return true;
  }

  screen(display: number): Screen | null {
    const at = this.o.screens().find((s) => s.display === display);
    if (!at) return null;
    let s = this.screens.get(display);
    if (!s) this.screens.set(display, (s = new Screen(display, () => this.o.screens().find((x) => x.display === display)?.port ?? null, this)));
    return s;
  }
  screenOf(bot: string): Screen | null {
    const d = this.botScreen.get(bot);
    return d === undefined ? null : (this.screens.get(d) ?? null);
  }
  allScreens() {
    return [...this.screens.values()];
  }

  private connect() {
    if (this.stopped) return;
    const headers = this.o.headers();
    if (!headers) return this.later();
    const url = `${this.o.url().replace(/^http/, "ws")}/v1/browser/runner`;
    const s = new WebSocket(url, { headers, perMessageDeflate: false, handshakeTimeout: 10_000 });
    this.socket = s;
    s.on("open", () => {
      this.retry = RECONNECT_MIN_MS;
      this.log("connected to Bops Cloud");
      // Bops Cloud keeps what each bot is doing only while this is connected: said again to a new socket.
      for (const sc of this.screens.values()) sc.sayDoing(true);
    });
    s.on("message", (data) => {
      try {
        this.heard(JSON.parse(String(data)) as BrowserToRunner);
      } catch (e) {
        this.log(`a message from Bops Cloud: ${(e as Error).message}`);
      }
    });
    s.on("unexpected-response", (_req, res) => {
      this.log(`Bops Cloud answered ${res.statusCode}`);
      res.resume();
    });
    s.on("error", () => {});
    s.on("close", () => {
      if (this.socket !== s) return;
      this.socket = null;
      // Nobody is heard watching till it's back (Bops Cloud says who again then); someone in control keeps it a while.
      for (const sc of this.screens.values()) {
        sc.bots.clear();
        sc.unwatched();
      }
      this.botScreen.clear();
      // Back by then and watching again (Bops Cloud said so since), they keep it; else it's handed back. A reconnect
      // alone isn't them back: after a cloud restart nobody may watch again, and the thread would wait for good.
      if (!this.lost && !this.stopped)
        this.lost = setTimeout(() => {
          this.lost = undefined;
          for (const sc of this.screens.values()) if (sc.controller && !sc.watchedBy(sc.controller.who.id)) sc.setController(null);
        }, this.o.lostMs ?? LOST_CONTROL_MS);
      this.lost?.unref?.();
      this.later();
    });
  }

  private later() {
    if (this.stopped) return;
    this.reconnect = setTimeout(() => this.connect(), this.retry);
    this.reconnect.unref?.();
    this.retry = Math.min(RECONNECT_MAX_MS, this.retry * 2);
  }

  private refuse(bot: string, to: string, why: string) {
    this.send({ t: "refused", bots: [bot], to, why });
  }

  private heard(m: BrowserToRunner) {
    if (!m || typeof m !== "object" || typeof m.bot !== "string") return;
    if (m.t === "watch") return this.watch(m.bot, Array.isArray(m.viewers) ? m.viewers : [], m.joined === true);
    const sc = this.screenOf(m.bot);
    if (!sc) return m.who && this.refuse(m.bot, m.who.id, "Its browser isn't open right now.");
    if (m.t === "take") {
      // The owner takes it from whoever has it (Bops Cloud says `over` only for the owner); anyone else waits their turn.
      if (sc.controller && sc.controller.who.id !== m.who.id && !m.over) return this.refuse(m.bot, m.who.id, `${sc.controller.who.name} has control.`);
      if (sc.controller?.who.id !== m.who.id) sc.setController({ who: m.who, bot: m.bot });
      return;
    }
    if (m.t === "release") {
      if (sc.controller?.who.id === m.who.id) sc.setController(null);
      return;
    }
    if (m.t === "input") {
      probeInput("runner_got", m.method, m.params);
      if (!isBrowserMethod(m.method)) return this.refuse(m.bot, m.who.id, "The browser tab can't do that.");
      if (sc.controller?.who.id !== m.who.id) return this.refuse(m.bot, m.who.id, "Take over first.");
      const params = cleanInput(m.method, m.params);
      if (!params) return this.refuse(m.bot, m.who.id, m.method === "Page.navigate" || m.method === "Target.createTarget" ? "Only http and https addresses open here." : "That input isn't allowed.");
      void sc.input(m.method, params).catch((e: Error) => this.refuse(m.bot, m.who.id, e.message));
    }
  }

  /** Who watches a bot's browser now: its screen captured while anyone does; a person in control who left hands it back. */
  private watch(bot: string, viewers: BrowserPerson[], joined: boolean) {
    const had = this.screenOf(bot);
    const want = viewers.length ? this.screen(this.botScreen.get(bot) ?? this.o.screenFor(bot) ?? this.o.screens()[0]?.display ?? -1) : null;
    if (had && had !== want) {
      had.bots.delete(bot);
      this.botScreen.delete(bot);
      if (had.controller?.bot === bot) had.setController(null);
      had.unwatched();
    }
    if (!want) return;
    const before = want.bots.get(bot) ?? [];
    want.bots.set(bot, viewers);
    this.botScreen.set(bot, want.display);
    want.watch();
    if (want.controller && !want.watchedBy(want.controller.who.id)) want.setController(null);
    // Someone new, or a stream just opened (someone already watching, on another Mac or window): they see the screen at
    // once, not at its next paint.
    if (joined || viewers.some((v) => !before.some((b) => b.id === v.id))) want.catchUp([bot]);
  }

  status() {
    return {
      connected: this.connected,
      screens: [...this.screens.values()].map((s) => ({ display: s.display, capturing: s.capturing, watchers: s.watchers(), heldBy: s.controller?.who ?? null, framesSent: s.framesSent })),
    };
  }

  async stop() {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.lost) clearTimeout(this.lost);
    for (const s of this.screens.values()) s.stopCapture();
    this.socket?.close();
    this.socket = null;
  }
}

/** Start relaying the computer's browser (see above). */
export function startRelay(o: RelayOptions): Relay {
  const r = new RelayCore(o);
  return {
    whenFree: (display) => r.screen(display)?.whenFree() ?? Promise.resolve(),
    heldBy: (display) => r.screen(display)?.controller?.who ?? null,
    activity: (display, bot, doing) => {
      const s = r.screen(display);
      if (!s) return;
      // Another bot on this screen now: the one before is idle, else its viewers (and its Watch chip) would see it browsing for good.
      const was = s.doing;
      if (was && was.bot !== bot && (was.step !== "idle" || was.signIn || was.waiting)) r.send({ t: "activity", bots: [was.bot], step: "idle", waiting: false, signIn: null });
      s.doing = { bot, step: doing.step, signIn: doing.signIn ?? null, waiting: !!doing.waiting };
      s.sayDoing();
    },
    status: () => r.status(),
    stop: () => r.stop(),
  };
}
