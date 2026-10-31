"use client";

import { createElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { captureRect, fixAsk, goBackTo, MAX_PICKS, OFF_SCRIPT, pickAnswerOf, pickCode, pickLine, PLACE_NAMES, PLACES, placesOf, readWidth, SELECT_SCRIPT, WIDTHS, writeWidth, type LocalFacts, type PageAnswer, type Place, type Width } from "@/lib/app-preview";
import { localsOf, type LocalAnswer, type LocalSite } from "@/lib/hosted-apps";
import { screenNo } from "@/lib/screens";
import { deployState, localAct, localState, useLocal } from "./app-envs";
import { useComposerBridge } from "./composer-bridge";
import { useHostedApps } from "./hosted-apps";
import { previewPartition } from "./panel-tabs";
import { composite, DrawLayer, type Shape } from "./preview-draw";
import { FixPanel } from "./preview-fix";
import { PreviewLock, usePreviewTabPassword } from "./preview-password";
import { Spinner } from "./mascot";
import { post } from "./ui";

/*
 * An app's site beside its bot's chat, as Lovable shows the app being built. Its Local first: its dev server on the
 * bot's computer (of that bot's own copy of the app, when it works on it in one: `copy`), seen at http://localhost:<its port> on this Mac (lib/server/local-preview.ts forwards it there over
 * the tailnet), so a Google sign in set up for localhost works here. Hot reload shows each save as the bot works; a
 * plain site with none reloads once each time a task on the app ends (`stamp`). In a session of its own
 * (previewPartition), which its Preview link and Published (its own domain) load in too, picked in the bar (a place
 * the site doesn't have yet greyed, with why), so a sign in there stays.
 *
 * The bar, two rows (one would leave its address no room in a panel of 600 to 800 points): Back, Forward, Reload, how
 * the place shown is, its address (a long one gives way in its middle), Open in browser (its Local once it runs),
 * and On its screen (its Local in its bot's Chrome, on the screen the server picks, which it then says); under it,
 * the place, Select and Draw, and the width it's seen at (Full, Tablet or Phone, kept per app on this Mac).
 *
 * When its Local stopped by itself, or its page answers 5xx, a panel over the page says what stopped and offers Fix
 * it (preview-fix.tsx). Select (S) outlines what's under the pointer and, clicked, puts a picture of it and a line
 * saying what it is in the bot's message box, unsent (Cmd click adds more); Draw (D) marks the page up and puts a
 * picture of it there. Esc leaves either. S, D and Esc are heard only while the preview (its bar or its page) has
 * focus, never while typing, and never when the page took the key itself. Those and Fix it are the owner's, in the
 * Mac app only.
 */

type PageImage = { toDataURL: () => string; isEmpty: () => boolean };
type WebviewElement = HTMLElement & {
  reload: () => void;
  goBack: () => void;
  goForward: () => void;
  getURL: () => string;
  loadURL: (u: string) => Promise<void>;
  capturePage: (rect?: { x: number; y: number; width: number; height: number }) => Promise<PageImage>;
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
};

const BUTTON = "flex size-7 shrink-0 items-center justify-center rounded-lg text-[#3A3A38] hover:bg-[#F2F2F0] disabled:opacity-30 disabled:hover:bg-transparent";
const PILL = "shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 text-[#3A3A38] hover:bg-[#F2F2F0] disabled:opacity-50";
const TOGGLE = `${BUTTON} aria-pressed:bg-ink aria-pressed:text-white aria-pressed:hover:bg-ink`;
/** An address longer than this many characters keeps its last TAIL in sight, giving way in its middle. */
const TAIL_AFTER = 24;
const TAIL = 12;

/** A page's path (its own address's), for what's said of it. */
const pathOf = (url: string) => {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
};

/** A PNG data URL as a file (decoded here, never fetched). Null when it isn't one. */
function fileOf(dataUrl: string, name: string): File | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: "image/png" });
}

/** A picture of what the page shows (`rect` of it, or all of it), as a PNG data URL; null when it can't be taken. */
async function shotOf(view: WebviewElement, rect?: { x: number; y: number; width: number; height: number } | null): Promise<string | null> {
  try {
    const img = await (rect ? view.capturePage(rect) : view.capturePage());
    return img.isEmpty() ? null : img.toDataURL();
  } catch {
    return null;
  }
}

export function PreviewTab({
  ws,
  name,
  site,
  url,
  user,
  hidden,
  stamp,
  apps,
  bot,
  copy,
  own,
  onScreen,
}: {
  ws: string;
  name: string;
  site?: string;
  url: string;
  user?: string;
  hidden: boolean;
  /** Changes when a task on the app ends: the page reloads once (a plain site has no hot reload). */
  stamp?: string;
  /** What of the workspace's apps changes as one deploys (hosted-apps.tsx appsStamp): its links are read again. */
  apps?: string;
  /** Its bot: Fix it asks in its chat, and Select and Draw put what they picked in its message box. */
  bot?: { name: string; chatId: string };
  /** The bot whose copy of the app its Local is (lib/hosted-apps.ts copyBotOf; none: the app's own folder's). */
  copy?: string;
  /** The owner's own workspace (not one shared with them): Fix it, Select and Draw are theirs only. */
  own: boolean;
  /** Its Local opened on its bot's screen: show that screen (`display`, the one it opened on, when the server said). */
  onScreen: (display?: number) => void;
}) {
  const local = useLocal(ws, name);
  const mine = site ?? name;
  // (Its bot's copy's Local, when it's of one.)
  const x = localsOf(local.answer, copy)?.[mine] as (LocalSite & LocalFacts) | undefined;
  const partition = previewPartition(user, ws, name, site, copy);
  const whose = { ...(site ? { site } : {}), ...(copy ? { bot: copy } : {}) };
  const list = useHostedApps(ws, apps);
  const app = list.answer?.apps.find((a) => a.name === name);
  const shown = site && site !== name ? app?.sites?.find((y) => y.name === site) : app;
  // Its Local's address at its port now (one started again elsewhere: the forward here moved with it), else the tab's.
  const localUrl = x?.port ? `http://localhost:${x.port}/` : url;
  const places = placesOf(localUrl, list.answer ? (shown ?? { preview: undefined, domain: null, serving: null, live: null }) : undefined);
  const [picked, setPicked] = useState<Place>("local");
  // A place it had and lost (its link turned off, say) shows Local again.
  const place: Place = places[picked].url ? picked : "local";
  const src = places[place].url ?? localUrl;
  const s = place === "local" ? localState(x, local.answer) : deployState(place === "preview" ? shown?.preview : shown);
  const up = x?.state === "running";
  const [view, setView] = useState<WebviewElement | null>(null);
  const [at, setAt] = useState(localUrl);
  // Its Preview's password (preview-password.tsx): its cookie in this tab's session first, the page loaded again when it changes.
  const pass = usePreviewTabPassword(ws, name, site, shown?.preview, partition, () => place === "preview" && view?.reload());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const native = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
  // Once it answered, the page stays loaded (a restart that's starting again shows its words over it).
  const [loaded, setLoaded] = useState(false);
  if (up && !loaded) setLoaded(true);
  const showView = native && (place !== "local" || loaded);

  // The width it's seen at, as the owner left it for this app on this Mac.
  const [width, setWidthNow] = useState<Width>(() => readWidth(user, ws, name));
  const setWidth = (w: Width) => {
    setWidthNow(w);
    writeWidth(user, ws, name, w);
  };
  const px = WIDTHS.find((w) => w.id === width)?.px ?? null;

  // What its main frame last answered (a 5xx is a Local to fix), and the one whose panel was hidden.
  const [page, setPage] = useState<PageAnswer | null>(null);
  const [hid, setHid] = useState<PageAnswer | null>(null);
  // Its Local moved to another port: its address with it (the page loads it as its src changes).
  const [was, setWas] = useState(localUrl);
  if (was !== localUrl) {
    setWas(localUrl);
    if (place === "local") {
      setAt(localUrl);
      setPage(null);
    }
  }
  // On its screen: opening, which screen it opened on, or why not.
  const [screen, setScreen] = useState<{ busy?: true; said?: string; error?: string } | null>(null);

  // Select and Draw: the owner's, in the Mac app, with a chat to put what they pick in.
  const bridge = useComposerBridge();
  const [tool, setTool] = useState<"select" | "draw" | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);
  const tools = native && own && !!bridge && !!bot;
  const asleep = !!local.answer?.asleep;
  const stopped = !!local.answer && (!x || x.state === "stopped");
  const words =
    place !== "local"
      ? null
      : x?.state === "starting" && !x.mismatch
        ? `Starting ${name}. A first start installs what it needs.`
        : asleep
          ? "Its computer is asleep."
          : stopped
            ? `${name}'s Local is stopped.`
            : null;
  const action = asleep || stopped ? "Start" : null;
  const ask = fixAsk(mine, place, x, page);
  // (A dev server on a port of its own, `mismatch`, never answers on its: its panel covers the page too.)
  const failed = !!ask && (x?.state === "failed" || !!x?.mismatch);
  const pointable = tools && showView && !words && !failed;
  if ((hidden || !pointable) && tool) setTool(null);

  // Kept current for the listeners below.
  const now = useRef({ tool, pointable });
  const pick = useRef<(gen: number) => Promise<void>>(async () => {});
  const gen = useRef(0);
  const picks = useRef(0);
  useLayoutEffect(() => {
    now.current = { tool, pointable };
    /*
     * One pick: Select's script waits in the page for a click (lib/app-preview.ts SELECT_SCRIPT), then what it
     * answers is read as data, capped, never run (pickAnswerOf). Its picture is taken here, of its box and a little
     * around it, and both go to the bot's message box, its line in plain words (where it is in the page's code goes
     * along out of sight, for the bot). Cmd click waits for another. A pick whose `gen` isn't the newest was turned
     * off, or its page moved on (Select runs again on the new one).
     */
    pick.current = async (me) => {
      const el = view;
      if (!el || !bot || !bridge) return;
      const raw = await el.executeJavaScript(SELECT_SCRIPT).catch(() => undefined);
      if (me !== gen.current || raw === undefined) return;
      const answer = pickAnswerOf(raw);
      if (!answer || "esc" in answer) return setTool(null);
      // (The outline is off the page by now; a moment for it to paint without it.)
      await new Promise((r) => setTimeout(r, 80));
      const shot = await shotOf(el, captureRect(answer.pick.box, { w: el.clientWidth, h: el.clientHeight }));
      const file = shot && fileOf(shot, "picked.png");
      bridge.attach(bot.chatId, file ? [file] : [], pickLine(answer.pick), pickCode(answer.pick));
      picks.current++;
      if (me !== gen.current) return;
      if (answer.add && picks.current < MAX_PICKS) void pick.current(me);
      else setTool(null);
    };
  });

  useEffect(() => {
    const el = view;
    if (!el || !native) return;
    const moved = () => setAt(el.getURL());
    const navigated = (e: Event) => {
      const { url: u, httpResponseCode } = e as Event & { url: string; httpResponseCode: number };
      setAt(u);
      setPage({ status: httpResponseCode, path: pathOf(u) });
      // A new page (or the same one reloaded): Select's script runs again there.
      if (now.current.tool === "select") void pick.current(++gen.current);
    };
    el.addEventListener("did-navigate", navigated);
    el.addEventListener("did-navigate-in-page", moved);
    return () => {
      el.removeEventListener("did-navigate", navigated);
      el.removeEventListener("did-navigate-in-page", moved);
    };
  }, [view, native]);

  // Select on: its script waits in the page; off, it's taken out.
  useEffect(() => {
    if (tool !== "select" || !view) return;
    const g = gen;
    picks.current = 0;
    void pick.current(++g.current);
    return () => {
      // (Any pick still waiting is stale from here.)
      g.current++;
      void view.executeJavaScript(OFF_SCRIPT).catch(() => {});
    };
  }, [tool, view]);

  // S and D, and Esc to leave either, only while the preview has focus (its bar, or the page's frame around it:
  // never the chat's message box or anything else of the window), and never where something's being typed. Pressed
  // in the page itself (its own process, which has the keys once it's clicked), desktop/preview-frame-preload.cjs
  // hears them by the same rules and says which key it was, nothing more.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hidden || !tools) return;
    /** A key for the preview ("escape", "s" or "d"): whether it did something. */
    const press = (key: string) => {
      if (key === "escape") {
        if (!now.current.tool) return false;
        setTool(null);
        return true;
      }
      const k = key === "s" ? "select" : key === "d" ? "draw" : null;
      if (!k || !now.current.pointable || document.querySelector('[role="dialog"]')) return false;
      setToolError(null);
      setTool((t) => (t === k ? null : k));
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      const box = root.current;
      const inside = (n: unknown) => !!box && n instanceof Node && box.contains(n);
      if (!inside(e.target) && !inside(document.activeElement)) return;
      if (e.key === "Escape") {
        if (!press("escape")) return;
        e.preventDefault();
        return e.stopPropagation();
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.defaultPrevented) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (press(e.key.toLowerCase())) e.preventDefault();
    };
    // (Only its key's name is read: anything else from the page does nothing.)
    const fromPage = (e: Event) => {
      const { channel, args } = e as Event & { channel?: string; args?: unknown[] };
      if (channel === "bops-preview-key" && typeof args?.[0] === "string") press(args[0]);
    };
    window.addEventListener("keydown", onKey, true);
    view?.addEventListener("ipc-message", fromPage);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      view?.removeEventListener("ipc-message", fromPage);
    };
  }, [hidden, tools, view]);

  // A task on it ended: reload once (not on the first look).
  const seen = useRef(stamp);
  useEffect(() => {
    if (seen.current === stamp) return;
    seen.current = stamp;
    try {
      view?.reload();
    } catch {
      // (Not attached yet: it loads fresh anyway.)
    }
  }, [stamp, view]);

  const start = async () => {
    setBusy(true);
    setError(null);
    const r = await localAct(ws, name, { action: "start", ...whose });
    setBusy(false);
    if (r.ok) {
      local.put(r.ok);
      // (The forward follows its Local's port; asked again so it's open for this start.)
      void post(`/api/hosted-apps/${encodeURIComponent(name)}/local`, { ws, action: "preview", ...whose }).catch(() => null);
    } else setError(r.error ?? null);
  };

  const toPlace = async (p: Place) => {
    const to = places[p].url;
    if (!to || p === place) return;
    if (p === "preview") await pass.ready();
    setPicked(p);
    setAt(to);
    setPage(null);
    setScreen(null);
  };

  const toScreen = async () => {
    setScreen({ busy: true });
    const r = await localAct(ws, name, { action: "open", ...whose });
    if (!r.ok) return setScreen({ error: r.error ?? "Couldn't open it there. Try again." });
    local.put(r.ok);
    // The screen it opened on: the server picks it (its bot's thread's, else a free one) and says which.
    const d = (r.ok as LocalAnswer & { display?: unknown }).display;
    const display = typeof d === "number" && Number.isInteger(d) ? d : undefined;
    const n = display === undefined ? 0 : screenNo(display);
    setScreen({ said: n ? `On screen ${n}` : "On its screen" });
    onScreen(display);
  };

  /** Draw's Done: a picture of the page with the marks on it, in the bot's message box. */
  const drawn = async (shapes: Shape[], css: { w: number; h: number }) => {
    if (!view || !bot || !bridge) return;
    const shot = await shotOf(view);
    const file = shot ? await composite(shot, shapes, css) : null;
    if (!file) return setToolError("Couldn't take a picture of the page. Try again.");
    bridge.attach(bot.chatId, [file]);
    setTool(null);
  };

  const path = (() => {
    try {
      const u = new URL(at);
      return `${u.host}${u.pathname === "/" ? "/" : u.pathname}${u.search}`;
    } catch {
      return at.replace(/^https?:\/\//, "");
    }
  })();
  // A long address gives way in its middle: its host's start and its path's end stay in sight.
  const [head, tail] = path.length > TAIL_AFTER ? [path.slice(0, -TAIL), path.slice(-TAIL)] : [path, ""];
  // Open in browser: its Local only once it runs (nothing answers at its address before), with why until then.
  const unopened = place === "local" && !up ? (x?.state === "starting" && !x.mismatch ? "Wait for it to start." : "Start it first.") : undefined;
  const panel = ask && (
    <FixPanel
      ws={ws}
      name={name}
      site={site}
      copy={copy}
      ask={ask}
      back={goBackTo(x)}
      own={own}
      bot={bot}
      onLocal={local.put}
      onStart={failed ? () => void start() : undefined}
      starting={busy}
      onHide={failed ? undefined : () => setHid(page)}
    />
  );

  return (
    // (Focusable itself, so a click on its bar or around the page gives it the focus S, D and Esc listen for.)
    <div ref={root} tabIndex={-1} data-preview-tab={`${ws}/${name}`} className={`@container min-h-0 flex-1 flex-col outline-none ${hidden ? "hidden" : "flex"}`}>
      <div className="flex h-10 shrink-0 items-center gap-1 px-2.5">
        {native && (
          <>
            <button className={BUTTON} aria-label="Back" disabled={!showView} onClick={() => view?.goBack()}>
              <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
                <path d="M9 2.5L4.5 7 9 11.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button className={BUTTON} aria-label="Forward" disabled={!showView} onClick={() => view?.goForward()}>
              <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
                <path d="M5 2.5L9.5 7 5 11.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button className={BUTTON} aria-label="Reload" disabled={!showView} onClick={() => view?.reload()}>
              <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
                <path d="M11.5 7A4.5 4.5 0 1 1 10 3.6M10.5 1.5v2.6H7.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </>
        )}
        {/* How it is: a dot and a word (in a narrow panel the dot alone, the word on hover). */}
        <span data-tip={s.tip ?? s.word} className="ml-1 flex shrink-0 items-center gap-1.5">
          <span className={`size-1.5 shrink-0 rounded-full ${s.dot}`} />
          <span data-preview-state className="text-[12px] leading-4 text-[#6B6B6B] @max-md:sr-only">
            {s.word}
          </span>
        </span>
        <span data-preview-address data-tip={at} className="mx-1.5 flex min-w-0 flex-1 overflow-hidden rounded-full bg-[#F2F2F0] px-3 py-1 font-mono text-[11.5px] leading-4 text-[#6B6B6B]">
          <span className="min-w-0 truncate">{head}</span>
          {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
        </span>
        {place === "preview" && pass.on && <PreviewLock pass={pass} at={at} />}
        <span data-tip={unopened} className="flex shrink-0">
          <button data-preview-browser aria-label="Open in browser" disabled={!!unopened} onClick={() => (place === "preview" && pass.on ? pass.setPopover("browser") : window.open(at, "_blank"))} className={BUTTON}>
            <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden>
              <path d="M8.5 2h3.5v3.5M12 2L7 7M10.5 8.5v2.75c0 .41-.34.75-.75.75h-7c-.41 0-.75-.34-.75-.75v-7c0-.41.34-.75.75-.75H5.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </span>
        {place === "local" && (
          <span data-tip={screen?.error ?? (screen?.said ? undefined : "Open it on its computer's screen")} className="flex shrink-0">
            <button data-preview-screen disabled={!!screen?.busy} onClick={() => void toScreen()} className={`${PILL} ${screen?.error ? "text-[#B42318]" : ""}`}>
              {screen?.busy ? "Opening…" : (screen?.said ?? "On its screen")}
            </button>
          </span>
        )}
      </div>
      {/* (Which one, then its tools and widths at the end: together on a line of their own under it in a narrow panel, never over it or past the edge.) */}
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-[#F0F0EE] px-2.5 py-1">
        <div role="group" aria-label="Which one to show" data-preview-places className="flex shrink-0 items-center rounded-full bg-[#F2F2F0] p-0.5">
          {PLACES.map((p) => (
            <span key={p} data-tip={places[p].why} className="flex">
              <button
                data-preview-place={p}
                aria-pressed={place === p}
                disabled={!places[p].url}
                onClick={() => void toPlace(p)}
                className="rounded-full px-2.5 py-0.5 text-[12px] font-medium leading-4 text-[#6B6B6B] hover:text-ink disabled:text-[#ADADAA] disabled:hover:text-[#ADADAA] aria-pressed:bg-white aria-pressed:text-ink aria-pressed:shadow-[0_0_0_1px_#E6E6E3]"
              >
                {PLACE_NAMES[p]}
              </button>
            </span>
          ))}
        </div>
        <span data-preview-tools className="ml-auto flex shrink-0 items-center gap-1">
          {tools && (
            <>
              <button
                data-preview-tool="select"
                aria-label="Select"
                data-tip="Select a part of the page (S)"
                aria-pressed={tool === "select"}
                disabled={!pointable}
                onClick={() => (setToolError(null), setTool(tool === "select" ? null : "select"))}
                className={TOGGLE}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                  <path d="M2.5 5V3.5a1 1 0 0 1 1-1H5M9 2.5h1.5M2.5 9v1.5M13.5 5V3.5a1 1 0 0 0-1-1H11M5 13.5H3.5a1 1 0 0 1-1-1V11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  <path d="M8 7.5l6 2.3-2.6 1-1 2.7L8 7.5z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                data-preview-tool="draw"
                aria-label="Draw"
                data-tip="Draw on the page (D)"
                aria-pressed={tool === "draw"}
                disabled={!pointable}
                onClick={() => (setToolError(null), setTool(tool === "draw" ? null : "draw"))}
                className={TOGGLE}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                  <path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2 7.6-7.6z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
              </button>
              <span className="mx-1 h-4 w-px bg-[#E6E6E3]" />
            </>
          )}
          <div role="group" aria-label="Width" className="flex shrink-0 items-center gap-0.5">
            {WIDTHS.map((w) => (
              <button key={w.id} data-preview-width={w.id} aria-label={w.name} aria-pressed={width === w.id} onClick={() => setWidth(w.id)} className={`${BUTTON} aria-pressed:bg-[#F2F2F0] aria-pressed:text-ink`}>
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                  {w.id === "full" ? (
                    <path d="M2 3.5h12v8H2zM6 14h4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
                  ) : w.id === "tablet" ? (
                    <path d="M3.5 2h9v12h-9zM7 12h2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
                  ) : (
                    <path d="M5 2h6v12H5zM7.25 12h1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
                  )}
                </svg>
              </button>
            ))}
          </div>
        </span>
      </div>
      <div className={`relative flex min-h-0 flex-1 justify-center ${px ? "bg-[#F7F7F6] p-3" : ""}`}>
        <div data-preview-frame={width} className={`relative flex min-h-0 w-full flex-col ${px ? "overflow-hidden rounded-xl bg-white shadow-[0_0_0_1px_#E6E6E3]" : ""}`} style={px ? { maxWidth: px } : undefined}>
          {/* (Only in the Mac app: a plain browser opens it in a tab of its own, never a frame on Bops' own origin.) */}
          {showView && createElement("webview", { ref: setView, src, partition, allowpopups: "true", className: "min-h-0 flex-1" })}
          {words && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/95 px-8 text-center">
              {x?.state === "starting" && <Spinner size={16} color="#9A9A98" />}
              <span data-preview-words className="max-w-[420px] text-[13px] leading-5 text-[#6B6B6B]">
                {words}
              </span>
              {action && (
                <button data-preview-start disabled={busy} onClick={() => void start()} className="rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-semibold leading-4 text-white disabled:bg-[#E6E6E3] disabled:text-[#9A9A98]">
                  {busy ? "Starting…" : action}
                </button>
              )}
              {error && (
                <span role="alert" className="max-w-[420px] text-[12px] leading-4 text-[#B42318]">
                  {error}
                </span>
              )}
            </div>
          )}
          {/* Its Local stopped by itself: over the page, what stopped and Fix it. */}
          {failed && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/95 px-6">
              {panel}
              {error && (
                <span role="alert" className="max-w-[420px] text-[12px] leading-4 text-[#B42318]">
                  {error}
                </span>
              )}
            </div>
          )}
          {/* Its page answered 5xx: the page stays readable, the panel at its foot. */}
          {ask && !failed && hid !== page && <div className="absolute inset-x-3 bottom-3 flex justify-center">{panel}</div>}
          {tool === "select" && (
            <span data-preview-hint className="pointer-events-none absolute left-1/2 top-3 w-max max-w-[calc(100%-24px)] -translate-x-1/2 rounded-full bg-ink px-3 py-1.5 text-center text-[12px] leading-4 text-white shadow-[0_8px_24px_-12px_#00000080]">
              Click what you mean. Cmd click adds more. Esc to stop.
            </span>
          )}
          {tool === "draw" && <DrawLayer onDone={drawn} onCancel={() => setTool(null)} error={toolError} />}
        </div>
      </div>
    </div>
  );
}
