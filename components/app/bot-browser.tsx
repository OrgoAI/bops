"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { BrowserActivity, BrowserEvent, BrowserFrameMeta, BrowserMethod, BrowserPerson, BrowserTab } from "@/cloud/protocol";
import type { Bot } from "@/lib/types";
import { initialsFrom } from "./account";
import { BrowserCursors, cursorFeed } from "./browser-cursor";
import { Mascot } from "./mascot";
import { BrowserGoTo, hostOf, toAddress } from "./panel-tabs";

/*
 * The bot's browser, beside the chat: the page in front of the Chrome of the screen its task holds, live, for the owner
 * and for a teammate the owner gave Write on the bot and Use its computer (cloud/browser.ts says who may). Watching is
 * all it does until someone takes over: then their clicks, scrolls and typing go to that page (and only that page:
 * lib/browser-relay.ts BROWSER_METHODS), the bot's work on that screen waits, and Hand back lets it carry on. A sign-in
 * typed here stays in that screen's Chrome, as one the owner types on the screen does; it never goes to the chat.
 *
 * Its stream is open only while the tab shows: the bot's computer stops capturing 5 seconds after the last viewer goes.
 *
 * Who is driving is said by form, and the status line leads with the driver's face (lookOf): the bot browsing (its face
 * breathing, a slow light along the frame's edge), you (a solid ink edge, Hand back), someone else (their face and
 * cursor), idle (a hairline), out of reach (what happened, what's kept, Try again). Highlighter marks only the one state
 * that needs the viewer: the bot waits on them (to sign in, or to have control handed back), with the action that
 * frees it. Pressing the page while the bot has it takes over at once; that press never reaches the page.
 *
 * A link opened here (BrowserGoTo: one in the bot's message, a web tab's "Open in Boppy's browser") goes there in the
 * viewer's control at once, unless a bot step is using the browser right then: then it asks first, over the page. It
 * opens in a new tab, the bot's own page left as it was (a sign in the bot asked for opens on its own page instead),
 * where the computer's runner and Bops Cloud know tabs (the stream says "tabs"); else in the tab in front, as before.
 *
 * The browser's tabs show as a strip once it has two or more, oldest first, so none moves as the front changes; the one
 * in front is raised (form, not colour). Pressing another switches to it, taking over first when nobody has control (as
 * pressing the page does); in control, each can be closed. Hand back puts the bot's own tab in front again (the runner).
 */

type Page = { url: string; title: string; back: number | null };
type Refused = { why: string; code?: string };

export type Look = "unreachable" | "needs" | "you" | "other" | "browsing" | "idle";
type Action = { label: string; act: "take" | "release"; title: string; disabled?: boolean } | null;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * What the tab says and offers now: its look, the status line, and the one action (at the line's end, the same place
 * whatever the state, so nothing moves under the pointer). `owner`: the viewer owns the bot (their take goes over a
 * member's control; a member's never does).
 */
export function lookOf(o: { bot: string; control: { by: BrowserPerson | null; you: boolean }; activity: BrowserActivity | null; owner: boolean; reachable: boolean }): { look: Look; line: string; action: Action } {
  const { bot, control, activity, owner } = o;
  const them = control.by && !control.you ? firstName(control.by.name) : null;
  const handBack: Action = { label: "Hand back", act: "release", title: `${bot} carries on from here` };
  if (!o.reachable) return { look: "unreachable", line: `${bot}'s browser can't be reached`, action: null };
  if (activity?.signIn && !them)
    return control.you
      ? { look: "needs", line: `${bot} needs you to sign in`, action: { ...handBack, title: `Once you've signed in, ${bot} carries on` } }
      : { look: "needs", line: `${bot} needs you to sign in`, action: { label: "Sign in", act: "take", title: `Use ${bot}'s browser to sign in` } };
  if (activity?.waiting && control.you) return { look: "needs", line: `${bot} is waiting for you to hand back`, action: handBack };
  if (activity?.waiting && them && owner) return { look: "needs", line: `${bot} is waiting for ${them} to hand back`, action: { label: `Take over from ${them}`, act: "take", title: `Take ${bot}'s browser from ${them}` } };
  if (control.you) return { look: "you", line: `You have control. ${bot} waits.`, action: handBack };
  if (them)
    return {
      look: "other",
      line: activity?.waiting ? `${bot} is waiting for ${them} to hand back` : `${them} has control`,
      action: owner ? { label: `Take over from ${them}`, act: "take", title: `Take ${bot}'s browser from ${them}` } : { label: "Take over", act: "take", title: `${them} has control`, disabled: true },
    };
  const take: Action = { label: "Take over", act: "take", title: `Pause ${bot} here and use its browser yourself` };
  return activity?.step === "browsing" ? { look: "browsing", line: `${bot} is browsing`, action: take } : { look: "idle", line: `${bot}'s browser`, action: take };
}

/** CDP's modifier bits for a key or mouse event. */
const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
/** Keys that aren't text, as Chrome's key codes. Enter carries its "\r" so a form submits. */
const KEY_CODES: Record<string, number> = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
const BUTTON = ["left", "middle", "right"] as const;
/**
 * Moves and scrolls go at most this often (about 60 a second): the last move always (where the pointer stopped), scrolls
 * added up. Inputs reach Bops Cloud on one socket now (lib/server/browser-view.ts), and a move still waiting is replaced
 * by the next (act), so this many never queue up, even by POST to a Bops Cloud from before the socket.
 */
const MOVE_MS = 16;

type ActBody = { act: "take" | "release" | "input"; method?: BrowserMethod; params?: unknown };
/** An act waiting to be sent, for the bot and workspace it was made in; `sent` settles once Bops answered it. */
type Queued = { body: ActBody; bot: string; project: string; sent: Promise<void>; done: () => void };
type Wheel = { x: number; y: number; deltaX: number; deltaY: number };
/** A move or a scroll: one still waiting is replaced by a later one of its kind. Anything else is never replaced. */
const laterWins = (b: ActBody): "move" | "wheel" | null => {
  const type = b.act === "input" && b.method === "Input.dispatchMouseEvent" ? (b.params as { type?: string } | undefined)?.type : null;
  return type === "mouseMoved" ? "move" : type === "mouseWheel" ? "wheel" : null;
};
/** Two scrolls as one: where the later one is, by both their distances. */
const addWheel = (was: unknown, next: unknown) => {
  const a = was as Wheel;
  const b = next as Wheel;
  return { ...b, deltaX: a.deltaX + b.deltaX, deltaY: a.deltaY + b.deltaY };
};

/**
 * `project`: the shared workspace the window shows (its Orgo id; none: the user's own), sent with the stream and every
 * act, so neither ever reaches another workspace's bot of the same id (the server refuses a mismatch); key the
 * component by it too, so a switch starts it afresh. `inset`: shown in a computer tab, whose padding it runs edge to
 * edge over (its bar is the tab's, as a web tab's is).
 */
export function BotBrowser({ bot, project = "", hidden = false, inset = false }: { bot: Bot; project?: string; hidden?: boolean; inset?: boolean }) {
  const [frame, setFrame] = useState<{ meta: BrowserFrameMeta } | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [control, setControl] = useState<{ by: BrowserPerson | null; you: boolean }>({ by: null, you: false });
  const [refused, setRefused] = useState<Refused | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [activity, setActivity] = useState<BrowserActivity | null>(null);
  // The browser's tabs, once the stream says them (null: a runner or Bops Cloud from before tabs; links open in place).
  const [tabs, setTabs] = useState<{ tabs: BrowserTab[]; front: string | null } | null>(null);
  // The stream cut (Bops not answering): said in place of the page, with Try again (a new stream: `attempt`).
  const [cut, setCut] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  // Pointer events go straight to the cursors (browser-cursor.tsx), never through a render here.
  const [feed] = useState(cursorFeed);
  const [typing, setTyping] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const shot = useRef<HTMLCanvasElement | null>(null);
  // The newest frame, decoded, drawn on one canvas drawn in software (willReadFrequently), and the one before it freed.
  // Each frame as a new image (an <img> given a new data URL, or a canvas drawn on the GPU) left a new texture in the
  // graphics process each time: it held about 300 MB more while the browser streamed.
  const last = useRef<ImageBitmap | null>(null);
  const frames = useRef(0);
  const paint = useCallback(() => {
    const c = shot.current;
    const b = last.current;
    if (!c || !b) return;
    if (c.width !== b.width) c.width = b.width;
    if (c.height !== b.height) c.height = b.height;
    c.getContext("2d", { willReadFrequently: true })?.drawImage(b, 0, 0);
    c.dataset.drawn = "";
  }, []);
  const canvas = useCallback(
    (c: HTMLCanvasElement | null) => {
      shot.current = c;
      paint();
    },
    [paint],
  );
  useEffect(
    () => () => {
      last.current?.close();
      last.current = null;
    },
    [],
  );
  const surface = useRef<HTMLDivElement>(null);
  // Acts not sent yet, oldest first, and whether one is on its way (they go one at a time, in order).
  const queue = useRef<Queued[]>([]);
  const sending = useRef(false);
  const probePending = useRef(0);
  const lastMove = useRef(0);
  const held = useRef<{ move?: Record<string, unknown>; wheel?: { x: number; y: number; deltaX: number; deltaY: number }; timer?: ReturnType<typeof setTimeout> }>({});
  const meta = useRef<BrowserFrameMeta | null>(null);
  // A press that took over: it, and the moves and release after it, never reach the page.
  const swallow = useRef(false);
  // Who has control is known (the stream said, as it does on arriving): a link waits for that before it opens.
  const [known, setKnown] = useState(false);
  // A link to open here, from BrowserGoTo, until it's opened or let go; taken once (the ask is dropped then).
  const goTo = useContext(BrowserGoTo);
  const asked = goTo?.go ?? null;
  const [link, setLink] = useState<{ url: string; here: boolean } | null>(null);
  const [linkAt, setLinkAt] = useState(0);
  if (asked && asked.botId === bot.id && asked.at !== linkAt && !hidden) {
    setLinkAt(asked.at);
    setLink({ url: asked.url, here: !!asked.here });
  }
  useEffect(() => {
    if (asked && asked.botId === bot.id && !hidden) goTo?.took(asked.at);
  }, [asked, bot.id, hidden, goTo]);

  // Watching: only while the tab shows.
  useEffect(() => {
    if (hidden) return;
    const decoding = frames;
    const es = new EventSource(`/api/browser?${new URLSearchParams({ bot: bot.id, ...(project ? { project } : {}) })}`);
    const on = <T extends BrowserEvent["t"]>(t: T, f: (e: Extract<BrowserEvent, { t: T }>) => void) =>
      es.addEventListener(t, (m) => {
        setCut(false);
        try {
          f(JSON.parse((m as MessageEvent<string>).data));
        } catch {}
      });
    es.onerror = () => setCut(true);
    on("frame", (e) => {
      meta.current = e.meta;
      setFrame({ meta: e.meta });
      const n = ++frames.current;
      void createImageBitmap(new Blob([Uint8Array.from(atob(e.data), (ch) => ch.charCodeAt(0))], { type: "image/jpeg" })).then(
        (b) => {
          // A newer frame came while this one decoded: it's drawn instead.
          if (n !== frames.current) return b.close();
          last.current?.close();
          last.current = b;
          paint();
        },
        () => {},
      );
    });
    on("page", (e) => setPage({ url: e.url, title: e.title, back: e.back }));
    on("tabs", (e) => setTabs({ tabs: e.tabs, front: e.front }));
    on("control", (e) => {
      setControl({ by: e.by, you: e.you });
      setKnown(true);
    });
    on("computer", (e) => {
      setConnected(e.connected);
      if (e.connected) setRefused(null);
    });
    on("pointer", (e) => feed.emit(e));
    on("activity", (e) => setActivity({ step: e.step, waiting: e.waiting, signIn: e.signIn }));
    es.addEventListener("refused", (m) => {
      let e: Refused & { retry?: boolean };
      try {
        e = JSON.parse((m as MessageEvent<string>).data);
      } catch {
        return;
      }
      // One of their inputs refused (no code): said for a moment. The stream refused (a code): said in place of the
      // page, and not asked again, unless it's something passing (Bops Cloud out of reach), which is.
      if (!e.code) return setNote(e.why);
      setCut(false);
      setRefused({ why: e.why, code: e.code });
      if (!e.retry) es.close();
    });
    return () => {
      es.close();
      // A frame still decoding is stale now: it frees itself when it's done.
      decoding.current++;
      clearTimeout(held.current.timer);
      held.current = {};
      setControl({ by: null, you: false });
      setKnown(false);
      setTabs(null);
    };
  }, [bot.id, project, hidden, feed, attempt, paint]);

  // A note (an input refused) goes after a while.
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  /** Opt-in latency probe (docs/BROWSER-SPEED.md): a mouse act's queued, sent and settled times. Silent otherwise. */
  const timing = (q: Queued, phase: "queued" | "sent" | "settled") => {
    if (process.env.BOPS_BROWSER_PROBE !== "1" || q.body.method !== "Input.dispatchMouseEvent") return;
    if (phase === "queued") probePending.current++;
    const p = q.body.params as { type?: string; x?: number; y?: number } | undefined;
    window.dispatchEvent(new CustomEvent("bops-browser-probe", { detail: { phase, at: performance.timeOrigin + performance.now(), depth: probePending.current - 1, type: p?.type, x: p?.x, y: p?.y } }));
    if (phase === "settled") probePending.current--;
  };
  /** The acts waiting, sent one at a time in order, each when the one before it is answered. */
  const pump = async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      for (let q; (q = queue.current.shift()); ) {
        timing(q, "sent");
        try {
          const res = await fetch("/api/browser", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bot: q.bot, ...(q.project ? { project: q.project } : {}), ...q.body }) }).catch(() => null);
          if (!res) setNote("Couldn't reach Bops. Try again.");
          else if (!res.ok) setNote(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "That didn't go through.");
        } finally {
          timing(q, "settled");
          q.done();
        }
      }
    } finally {
      sending.current = false;
    }
  };
  /**
   * One act, after the ones before it: presses, releases, keys and pages in order, never dropped. A move or a scroll still
   * waiting, with only moves and scrolls after it, is replaced by the newer one of its kind (latest wins; scrolls added
   * up), so at most one of each waits there and moving never queues up ahead of a press.
   */
  const act = (body: ActBody): Promise<void> => {
    const kind = laterWins(body);
    let i = queue.current.length - 1;
    if (kind) while (i >= 0 && laterWins(queue.current[i].body) && laterWins(queue.current[i].body) !== kind) i--;
    const was = i >= 0 ? queue.current[i] : null;
    const same = kind && was && laterWins(was.body) === kind && was.bot === bot.id && was.project === project ? was : null;
    if (same) {
      timing(same, "settled");
      same.body = kind === "wheel" ? { ...body, params: addWheel(same.body.params, body.params) } : body;
      timing(same, "queued");
      return same.sent;
    }
    let done = () => {};
    const sent = new Promise<void>((r) => (done = r));
    const q: Queued = { body, bot: bot.id, project, sent, done };
    timing(q, "queued");
    queue.current.push(q);
    void pump();
    return sent;
  };
  const input = (method: BrowserMethod, params: unknown) => (control.you ? void act({ act: "input", method, params }) : undefined);

  /** Where a pointer is on the page, in its CSS pixels. */
  const at = (e: { clientX: number; clientY: number }) => {
    const r = shot.current?.getBoundingClientRect();
    const m = meta.current;
    if (!r || !m || !r.width || !r.height) return null;
    return { x: Math.max(0, ((e.clientX - r.left) / r.width) * m.deviceWidth), y: Math.max(0, ((e.clientY - r.top) / r.height) * m.deviceHeight) };
  };
  const mouse = (type: "mousePressed" | "mouseReleased" | "mouseMoved", e: React.MouseEvent) => {
    if (swallow.current) {
      if (type === "mouseReleased") swallow.current = false;
      return;
    }
    const p = at(e);
    if (!p) return;
    const params = { type, ...p, button: type === "mouseMoved" ? (e.buttons & 1 ? "left" : "none") : (BUTTON[e.button] ?? "left"), clickCount: type === "mouseMoved" ? 0 : Math.min(3, e.detail || 1), modifiers: mods(e) };
    if (type === "mouseMoved") return often({ move: params });
    // Their own press rings at once where they pressed, rather than once the page's answer comes back.
    if (type === "mousePressed") feed.ring(p);
    // A press or release lands after the move held back for it, where the pointer is.
    flushHeld();
    input("Input.dispatchMouseEvent", params);
  };
  /** What's held back sent now: the latest move, then the scrolls since added up. */
  const flushHeld = () => {
    const h = held.current;
    if (h.timer) clearTimeout(h.timer);
    held.current = {};
    if (!h.move && !h.wheel) return;
    lastMove.current = Date.now();
    if (h.move) input("Input.dispatchMouseEvent", h.move);
    if (h.wheel) input("Input.dispatchMouseEvent", { type: "mouseWheel", ...h.wheel });
  };
  /** A move or a scroll, sent at most every MOVE_MS: held till then, the last move kept and scrolls added up. */
  const often = (next: { move?: Record<string, unknown>; wheel?: { x: number; y: number; deltaX: number; deltaY: number } }) => {
    if (!control.you) return;
    const h = held.current;
    if (next.move) h.move = next.move;
    if (next.wheel) h.wheel = h.wheel ? { ...next.wheel, deltaX: h.wheel.deltaX + next.wheel.deltaX, deltaY: h.wheel.deltaY + next.wheel.deltaY } : next.wheel;
    const wait = MOVE_MS - (Date.now() - lastMove.current);
    if (wait <= 0) flushHeld();
    else if (!h.timer) h.timer = setTimeout(flushHeld, wait);
  };

  const take = async () => {
    setAsking(true);
    await act({ act: "take" });
    setAsking(false);
    surface.current?.focus();
  };
  const handBack = () => void act({ act: "release" });
  /**
   * A link opens: in a new tab (or, `here`, the tab in front), taking over first unless the viewer has it (acts go in
   * order, so it lands in their control). Without tabs from the stream, in the tab in front.
   */
  const openHere = async (url: string, here = false) => {
    setLink(null);
    if (!control.you) await take();
    if (tabs && !here) await act({ act: "input", method: "Target.createTarget", params: { url } });
    else await act({ act: "input", method: "Page.navigate", params: { url } });
  };

  // Out of reach: the computer isn't connected, the stream is cut, or Bops Cloud can't be reached (it comes back by itself).
  const away = connected === false ? "computer" : cut || refused?.code === "unreachable" ? "cut" : null;
  const { look, line, action } = lookOf({ bot: bot.name, control, activity, owner: !project, reachable: !away });
  // Nobody has it and the page is there: pressing the page takes over.
  const pressTakes = !control.by && !away && !!frame && !asking;
  /** Another tab to the front: taking over first when nobody has control (as pressing the page does). */
  const switchTo = async (id: string) => {
    if (id === tabs?.front) return;
    if (!control.you) {
      if (!pressTakes) return;
      await take();
    }
    await act({ act: "input", method: "Target.activateTarget", params: { targetId: id } });
  };
  // A link to open: at once when the viewer has control, or nobody has and no bot step is using it; else asked first.
  const them = control.by && !control.you ? firstName(control.by.name) : null;
  const linkWaits = !!link && known && !away && !control.you && (!!them || activity?.step === "browsing");
  useEffect(() => {
    if (!link || !known || away || !frame || linkWaits || asking) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- an act in answer to the stream (it said who has control), once each link
    void openHere(link.url, link.here);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once each link, when the browser is ready for it
  }, [link, known, away, frame, linkWaits, asking]);
  const button = "flex size-7 items-center justify-center rounded-lg text-[#3A3A38] hover:bg-[#F2F2F0] disabled:opacity-30 disabled:hover:bg-transparent";
  const tryAgain = () => {
    setCut(false);
    setRefused(null);
    setAttempt((n) => n + 1);
  };

  if (refused && refused.code !== "unreachable")
    return (
      <div className={`min-h-0 flex-1 flex-col ${inset ? "" : "px-5 pt-4"} ${hidden ? "hidden" : "flex"}`}>
        <p className="px-1 py-2 text-[14px] leading-5 text-[#6B6B6B]" data-browser-refused={refused.code ?? ""}>
          {refused.why}
        </p>
      </div>
    );

  return (
    <div className={`min-h-0 flex-1 flex-col ${inset ? "-mx-5 -mb-4 -mt-4" : ""} ${hidden ? "hidden" : "flex"}`} aria-label={`${bot.name}'s browser`} data-bot-browser={bot.id} data-browser-look={look}>
      {tabs && tabs.tabs.length > 1 && (
        <BrowserTabs
          bot={bot.name}
          tabs={tabs}
          you={control.you}
          mayTake={pressTakes}
          busy={them ? `${them} has control` : `${bot.name} is using its browser`}
          onSwitch={(id) => void switchTo(id)}
          onClose={(id) => void act({ act: "input", method: "Target.closeTarget", params: { targetId: id } })}
        />
      )}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[#F0F0EE] px-2.5">
        <button className={button} aria-label="Back" title={control.you ? "Back" : "Take over to go back"} disabled={!control.you || page?.back == null} onClick={() => page?.back != null && input("Page.navigateToHistoryEntry", { entryId: page.back })}>
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
            <path d="M9 2.5L4.5 7 9 11.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button className={button} aria-label="Reload" title={control.you ? "Reload" : "Take over to reload"} disabled={!control.you} onClick={() => input("Page.reload", {})}>
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
            <path d="M11.5 7A4.5 4.5 0 1 1 10 3.6M10.5 1.5v2.6H7.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (control.you && typing?.trim()) input("Page.navigate", { url: toAddress(typing) });
            setTyping(null);
            surface.current?.focus();
          }}
          className="mx-1.5 flex min-w-0 flex-1"
        >
          <input
            value={typing ?? page?.url ?? ""}
            readOnly={!control.you}
            onChange={(e) => setTyping(e.target.value)}
            onFocus={(e) => control.you && e.currentTarget.select()}
            onBlur={() => setTyping(null)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              setTyping(null);
              e.currentTarget.blur();
            }}
            spellCheck={false}
            aria-label="Address"
            title={control.you ? page?.title : `${page?.title ? `${page.title} · ` : ""}Take over to go somewhere else`}
            className="min-w-0 flex-1 truncate rounded-full bg-[#F2F2F0] px-3 py-1 font-mono text-[11.5px] leading-4 text-[#6B6B6B] outline-none read-only:cursor-default focus:bg-white focus:text-ink focus:shadow-[0_0_0_1.5px_#0A0A0A] read-only:focus:bg-[#F2F2F0] read-only:focus:text-[#6B6B6B] read-only:focus:shadow-none"
          />
        </form>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-5 pb-4 pt-3">
        <div className="flex h-8 min-w-0 items-center gap-2 text-[13px] leading-4">
          <DriverFace look={look} bot={bot} by={control.by} you={control.you} />
          <span
            role="status"
            data-browser-line
            className={`shrink-0 font-medium text-ink ${look === "needs" ? "rounded-full bg-highlighter px-2.5 py-1 shadow-[0_0_0_1px_#0A0A0A]" : ""}`}
          >
            {line}
          </span>
          <span className="min-w-0 flex-1 truncate text-[#6B6B6B]">{look === "unreachable" ? "" : page?.title}</span>
          {action && (
            <button
              onClick={() => (action.act === "take" ? void take() : handBack())}
              disabled={action.disabled || asking || (action.act === "take" && !frame)}
              title={action.title}
              className="min-w-[92px] shrink-0 rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-semibold leading-4 text-white disabled:cursor-default disabled:bg-[#B0B0AD]"
            >
              {action.label}
            </button>
          )}
        </div>
        <div
          ref={surface}
          tabIndex={0}
          aria-label={control.you ? `${bot.name}'s page: you have control` : pressTakes ? `${bot.name}'s page: press to take over` : `${bot.name}'s page`}
          onMouseDown={(e) => {
            if (!control.you) {
              // The first press while the bot has it takes over; it goes nowhere on the page (nothing clicked by accident).
              if (!pressTakes || e.button !== 0) return;
              e.preventDefault();
              swallow.current = true;
              void take();
              return;
            }
            e.preventDefault();
            surface.current?.focus();
            mouse("mousePressed", e);
          }}
          onMouseUp={(e) => mouse("mouseReleased", e)}
          onMouseMove={(e) => control.you && mouse("mouseMoved", e)}
          onWheel={(e) => {
            const p = at(e);
            if (control.you && p) often({ wheel: { ...p, deltaX: e.deltaX, deltaY: e.deltaY } });
          }}
          onContextMenu={(e) => control.you && e.preventDefault()}
          onKeyDown={(e) => {
            if (!control.you) return;
            // Paste goes in as text (onPaste); every other shortcut stays the app's.
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
            if (e.metaKey) return;
            const code = KEY_CODES[e.key];
            if (code !== undefined) {
              e.preventDefault();
              input("Input.dispatchKeyEvent", { type: e.key === "Enter" ? "keyDown" : "rawKeyDown", key: e.key, code: e.code, windowsVirtualKeyCode: code, modifiers: mods(e), ...(e.key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
            } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              input("Input.insertText", { text: e.key });
            }
          }}
          onKeyUp={(e) => {
            const code = KEY_CODES[e.key];
            if (control.you && code !== undefined) input("Input.dispatchKeyEvent", { type: "keyUp", key: e.key, code: e.code, windowsVirtualKeyCode: code, modifiers: mods(e) });
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text/plain");
            if (!control.you || !text) return;
            e.preventDefault();
            input("Input.insertText", { text: text.slice(0, 10_000) });
          }}
          className={`relative w-full overflow-hidden rounded-[14px] bg-[#F7F7F6] outline-none ${control.you ? "cursor-default shadow-[0_0_0_2px_#0A0A0A]" : look === "browsing" ? "shadow-[0_0_0_2px_rgb(10_10_10_/_0.16)]" : "shadow-[0_0_0_1px_#ECECEA]"}`}
          style={{ aspectRatio: frame ? `${frame.meta.deviceWidth} / ${frame.meta.deviceHeight}` : "16 / 10" }}
        >
          {away ? (
            // What happened, what's kept, and the one way back.
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-8 text-center" data-browser-away={away}>
              <p className="text-[14px] font-medium leading-5 text-ink">{away === "computer" ? `${bot.name}'s computer isn't connected right now.` : `Lost the connection to ${bot.name}'s browser.`}</p>
              <p className="text-[13px] leading-5 text-[#6B6B6B]">Its work still shows in the chat.</p>
              <button onClick={tryAgain} className="mt-2 rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-semibold leading-4 text-white">
                Try again
              </button>
            </div>
          ) : frame ? (
            <canvas ref={canvas} role="img" aria-label={page?.title ? `${bot.name}'s browser: ${page.title}` : `${bot.name}'s browser`} data-browser-frame className="block h-full w-full select-none" />
          ) : (
            <div className="flex h-full w-full items-center justify-center px-8 text-center text-[13px] leading-5 text-[#6B6B6B]">{`Opening ${bot.name}'s browser…`}</div>
          )}
          {frame && !away && <BrowserCursors bot={bot} feed={feed} page={{ width: frame.meta.deviceWidth, height: frame.meta.deviceHeight }} driver={control.by} idle={look === "idle"} />}
          {look === "browsing" && <span aria-hidden className="browser-sweep" data-browser-sweep />}
          {linkWaits && (
            // Over the page, so nothing under the pointer moves when it goes.
            <div
              role="alertdialog"
              aria-label="Open the link?"
              data-browser-ask
              onMouseDown={(e) => e.stopPropagation()}
              className="absolute inset-x-3 top-3 flex items-center gap-2 rounded-[12px] bg-white py-2 pl-3.5 pr-2 text-[13px] leading-5 text-ink shadow-[0_0_0_1px_#E2E2DF,0_10px_24px_-12px_rgb(10_10_10_/_0.35)] motion-safe:animate-[rise-in_240ms_cubic-bezier(0.2,0.8,0.2,1)]"
            >
              <span className="min-w-0 flex-1">
                {them ? `${them} has control. The link opens here once they hand back, or open it in a web tab.` : `${bot.name} is using its browser. Open the link now? ${bot.name} waits until you hand back.`}
              </span>
              {!them && (
                <button onClick={() => void openHere(link.url, link.here)} className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-[13px] font-semibold leading-4 text-white">
                  Take over and open
                </button>
              )}
              <button onClick={() => setLink(null)} className="shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium leading-4 text-[#3A3A38] hover:bg-[#F2F2F0]">
                Not now
              </button>
            </div>
          )}
        </div>
        {note && (
          <p role="status" className="text-[13px] leading-4 text-[#6B6B6B]">
            {note}
          </p>
        )}
        {control.you && <p className="text-[13px] leading-4 text-[#6B6B6B]">{`What you type here stays in ${bot.name}'s browser and never goes to the chat.`}</p>}
      </div>
    </div>
  );
}

/**
 * The browser's tabs, oldest first, the one in front raised (form, not colour). `you`: the viewer has control (each tab
 * switches, and closes); `mayTake`: nobody has, so pressing one takes over and switches; else they're read only, saying
 * who has it (`busy`).
 */
function BrowserTabs({ bot, tabs, you, mayTake, busy, onSwitch, onClose }: { bot: string; tabs: { tabs: BrowserTab[]; front: string | null }; you: boolean; mayTake: boolean; busy: string; onSwitch: (id: string) => void; onClose: (id: string) => void }) {
  return (
    <div role="tablist" aria-label={`${bot}'s tabs`} data-browser-tabs className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-[#F0F0EE] px-2.5">
      {tabs.tabs.map((t) => {
        const front = t.id === tabs.front;
        const name = t.title.trim() || hostOf(t.url) || "New tab";
        const may = front || you || mayTake;
        return (
          <div key={t.id} className={`group/btab flex h-7 min-w-0 max-w-[200px] shrink items-center rounded-[9px] ${front ? "bg-white shadow-[0_0_0_1px_#E2E2DF,0_1px_2px_rgb(10_10_10_/_0.06)]" : may ? "hover:bg-[#F2F2F0]" : ""}`}>
            <button
              role="tab"
              aria-selected={front}
              data-browser-tab={t.id}
              disabled={!may}
              title={front ? t.url : you ? `Switch to ${name}` : may ? `Take over and switch to ${name}` : `${name} · ${busy}`}
              onClick={() => !front && onSwitch(t.id)}
              className={`flex min-w-0 flex-1 items-center py-1 pl-2.5 ${you ? "pr-1" : "pr-2.5"} text-left text-[13px] leading-4 disabled:cursor-default ${front ? "font-medium text-ink" : "text-[#6B6B6B]"}`}
            >
              <span className="min-w-0 truncate">{name}</span>
            </button>
            {you && (
              <button
                aria-label={`Close ${name}`}
                title={`Close ${name}`}
                onClick={() => onClose(t.id)}
                className={`mr-1 flex size-5 shrink-0 items-center justify-center rounded-md text-[#9A9A98] hover:bg-[#EEEEEC] hover:text-ink focus:opacity-100 ${front ? "" : "opacity-0 group-hover/btab:opacity-100"}`}
              >
                <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
                  <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Who is driving, at the head of the status line: the bot's face (breathing while it browses; still otherwise), or the
 * person in control's initials (yours in ink, someone else's on grey). Form, not colour, tells them apart.
 */
function DriverFace({ look, bot, by, you }: { look: Look; bot: Bot; by: BrowserPerson | null; you: boolean }) {
  if (by && look !== "unreachable")
    return (
      <span aria-hidden className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${you ? "bg-ink text-white" : "bg-[#EEEEEC] text-[#3A3A38]"}`} data-driver-face={you ? "you" : "person"}>
        {initialsFrom(by.name)}
      </span>
    );
  return (
    <span aria-hidden className={`relative flex size-6 shrink-0 items-center justify-center ${look === "unreachable" ? "opacity-40" : ""}`} data-driver-face="bot">
      {look === "browsing" && <span className="absolute -inset-[3px] rounded-full border-[1.5px] border-ink animate-[breathe_2400ms_ease-in-out_infinite] motion-reduce:animate-none motion-reduce:opacity-50" data-breathing />}
      <Mascot botId={bot.id} color={bot.color} size={22} antenna={false} />
    </span>
  );
}

/**
 * What a bot is doing with its browser, while `on` (a Watch chip's, bops-app.tsx): Bops Cloud's activity-only stream,
 * which isn't watching (its computer captures nothing for it). Null while off, or before it says.
 */
export function useBrowserActivity(botId: string | null, project: string, on: boolean): BrowserActivity | null {
  const [activity, setActivity] = useState<BrowserActivity | null>(null);
  useEffect(() => {
    if (!on || !botId) return;
    const es = new EventSource(`/api/browser?${new URLSearchParams({ bot: botId, ...(project ? { project } : {}), only: "activity" })}`);
    es.addEventListener("activity", (m) => {
      try {
        const e = JSON.parse((m as MessageEvent<string>).data) as BrowserActivity;
        setActivity({ step: e.step, waiting: e.waiting, signIn: e.signIn });
      } catch {}
    });
    es.addEventListener("computer", (m) => {
      if (!(JSON.parse((m as MessageEvent<string>).data) as { connected: boolean }).connected) setActivity(null);
    });
    es.addEventListener("refused", (m) => {
      if (!(JSON.parse((m as MessageEvent<string>).data) as { retry?: boolean }).retry) es.close();
    });
    return () => {
      es.close();
      setActivity(null);
    };
  }, [botId, project, on]);
  return on ? activity : null;
}

/**
 * "Boppy is browsing · Watch", over the message box while the chat's bot browses and its browser isn't in sight
 * (bops-app.tsx); it opens the browser, and goes when that shows or the browsing stops.
 */
export function WatchChip({ bot, project, onWatch }: { bot: Bot; project: string; onWatch: () => void }) {
  const activity = useBrowserActivity(bot.id, project, true);
  if (activity?.step !== "browsing") return null;
  return (
    <button
      onClick={onWatch}
      data-watch-chip
      className="mx-3 mb-2 flex items-center gap-2 self-start rounded-full bg-white py-1 pl-1.5 pr-3 text-[13px] leading-5 text-ink shadow-[0_0_0_1px_#E2E2DF,0_6px_16px_-10px_rgb(10_10_10_/_0.35)] hover:bg-[#F7F7F6] motion-safe:animate-[rise-in_240ms_cubic-bezier(0.2,0.8,0.2,1)]"
    >
      <Mascot botId={bot.id} color={bot.color} size={20} antenna={false} />
      <span>{`${bot.name} is browsing`}</span>
      <span aria-hidden className="text-[#9A9A98]">·</span>
      <span className="font-semibold">Watch</span>
    </button>
  );
}
