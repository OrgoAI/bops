"use client";

import { useEffect, useRef, useState } from "react";
import { BLOCKER_LABEL, computerAsleep, computerCheckMs, computerInUse, DISPLAYS, live, streamsLive, workBot, workspaceOf, type AppState, type Bot, type Session } from "@/lib/types";
import { freeComputerOpen, setupShort } from "@/lib/orgo-plans";
import { BotCursor } from "./bot-cursor";
import { LiveDesktop, Waking } from "./live-desktop";
import { LiveScreen, type ScreenInput } from "./live-screen";
import { MirrorScreen, type MirrorTab } from "./mirror-screen";
import { ReaderView } from "./reader-view";
import { useScreenActivity } from "./screen-activity";
import { WatchSheet } from "./watch-sheet";
import { WatchBadge, WatchOverlay } from "./watch-overlay";
import { EmailCard, PaymentCard, SignInCard } from "./screen-cards";
import { Mascot } from "./mascot";
import { PlanNote, usePlan } from "./plan-note";
import { freeHoursOutLine } from "@/lib/plan-includes";
import { AppLogo, botApps } from "./apps";
import { botBezel, botOnInk, botWash, MonitorIcon, post, screenNo } from "./ui";
import { useWindowVisible } from "./window-visible";

/* A bot's computer, shown as the work on it: it runs up to four things at once, one per screen. */

type ComputerInfo = {
  computer: { status: string; cpu: number; ram: number } | null;
  /** The page open on each screen, by display. */
  pages?: Record<string, { url: string; title: string }>;
};

/**
 * The bot's computer as Orgo has it (its status and size, and the page each screen has open), read again
 * every so often (computerCheckMs): not while the window is hidden, and only every minute while the
 * computer is asleep with nothing using it. `computerId`: the computer the bot
 * works on (none: nothing to read). `inUse`: a task or the user is on it (computerInUse), so it's read
 * sooner while it wakes. Read again at once when the window comes to the front, and by `recheck` (one of
 * its screens just failed: it may have fallen asleep).
 */
function useComputer(botId: string, computerId: string | undefined, inUse = false) {
  const enabled = !!computerId;
  const [info, setInfo] = useState<ComputerInfo | null>(null);
  const [again, setAgain] = useState(0);
  const visible = useWindowVisible();
  const every = enabled ? computerCheckMs(info?.computer?.status, { visible, inUse }) : null;
  useEffect(() => {
    if (!enabled || !visible) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await fetch(`/api/computer?bot=${botId}`, { cache: "no-store" });
        // A read that failed (Orgo or the network not there yet, as the laptop wakes) keeps what was last
        // known: an asleep computer shown as unknown would have its views connect, and screenshots wake it.
        if (res.ok) {
          const json = (await res.json()) as ComputerInfo;
          if (!stop) setInfo(json);
        }
      } catch {
        /* retry next tick */
      }
      if (!stop && every !== null) timer = setTimeout(tick, every);
    };
    // Now, then every so often.
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // computerId: another computer (the bot moved on) is read at once, whatever the last one's status was.
  }, [botId, computerId, enabled, visible, every, again]);
  useEffect(() => {
    if (!enabled) return;
    const front = () => setAgain((n) => n + 1);
    window.addEventListener("focus", front);
    return () => window.removeEventListener("focus", front);
  }, [enabled]);
  return { info: enabled ? info : null, recheck: () => setAgain((n) => n + 1) };
}

/** The bots working on the computer `c` is (itself and the bots that share it): whose tasks and takeovers are on it. */
const onComputerOf = (state: AppState, c: Bot) => (botId: string) => {
  const x = state.bots.find((y) => y.id === botId);
  return !!x && workBot(x, state.bots).id === c.id;
};

/** Which screen to show: the one you picked, else where the newest work is, else screen 1. */
export function defaultDisplay(state: AppState, botId: string, picked?: number) {
  if (picked !== undefined) return picked;
  if (state.takeover?.botId === botId && state.takeover.display !== undefined) return state.takeover.display;
  const held = state.sessions.filter((s) => s.botId === botId && s.display !== undefined);
  return held[held.length - 1]?.display ?? DISPLAYS[0];
}

/** Following the action: whether the panel picks the screen for you, and how it switches. */
export type Follow = { on: boolean; auto: (display: number) => void; resume: () => void };

/** An action this recent makes a screen "where the action is". */
const FRESH_MS = 3000;
/** The screen on show has to have been quiet this long before cutting away from it. */
const QUIET_MS = 2500;
/** Every cut stays up at least this long, so two busy helpers never make it flicker. */
const DWELL_MS = 4000;

export function ComputerView({
  state,
  bot: b,
  display,
  onDisplay,
  follow,
  mode,
  onFocus,
  onBack,
  hidden = false,
}: {
  state: AppState;
  bot: Bot;
  display: number;
  onDisplay: (d: number) => void;
  follow?: Follow;
  mode: "panel" | "focus";
  onFocus?: () => void;
  onBack?: () => void;
  /** Kept connected behind another tab: the screens stay live, the director rests. */
  hidden?: boolean;
}) {
  const [showReal, setShowReal] = useState(false);
  const mac = state.host === "mac";
  // The computer it works on: its own, or the main bot's when it shares. Its screens show every
  // bot's work there, since a screen another bot is using isn't free for this one either.
  const c = mac ? b : workBot(b, state.bots);
  const here = (botId: string) => botId === b.id || (!mac && workBot(state.bots.find((x) => x.id === botId) ?? b, state.bots).id === c.id);
  const hasComputer = mac || (!!c.computerId && c.computerStatus === "ready");
  // A task or the user on it wakes it, when it's asleep: nothing streams or reads its screens till then.
  const inUse = !mac && computerInUse(state, here);
  const { info, recheck } = useComputer(b.id, mac ? undefined : c.computerId, inUse);
  const asleep = !mac && computerAsleep(info?.computer?.status);
  // Free's computer with its hours used (10 a month): nothing wakes it till they start over.
  const plan = usePlan(state);
  const time = c.freeComputer ? plan?.bops?.computerTime : undefined;
  const hoursOut = !!time && time.usedSeconds >= time.limitSeconds;
  const holding = new Map(state.sessions.filter((s) => here(s.botId) && s.display !== undefined).map((s) => [s.display!, s]));
  // Screens a thread's helpers are using belong to that thread too.
  for (const s of state.sessions.filter((x) => here(x.botId) && live(x)))
    for (const d of s.helperScreens ?? []) if (!holding.has(d)) holding.set(d, s);
  const helperOn = (d: number) => !!holding.get(d)?.helperScreens?.includes(d);
  /**
   * The helper working a screen: the latest one whose steps mention that screen. Helpers' steps only
   * arrive once they finish, so until then go by order: screens are claimed one per helper, in turn.
   */
  const helperName = (d: number) => {
    const s = holding.get(d);
    const named = [...(s?.steps ?? [])].reverse().find((st) => st.who && st.screen === DISPLAYS.indexOf(d) + 1)?.who;
    if (named || !s?.helperScreens || !s.helperNames) return named;
    const started = s.helperOrder?.indexOf(d) ?? -1;
    if (started >= 0) return s.helperNames[started];
    const order = [...s.helperScreens].sort((x, y) => DISPLAYS.indexOf(x) - DISPLAYS.indexOf(y));
    return order.length === s.helperNames.length ? s.helperNames[order.indexOf(d)] : undefined;
  };
  const yours = (d: number) => state.takeover?.botId === b.id && state.takeover.display === d;
  const onScreen = holding.get(display);
  /** What a screen shows, as read for whichever bot's thread is on it (screen-watch keys reads by that bot). */
  const readOn = (d: number) => state.screens?.[`${holding.get(d)?.botId ?? b.id}:${d}`];
  const read = readOn(display);

  // Following the action. The computer streams when an agent last acted on each screen; threads'
  // recorded steps fill in where it can't (on this Mac). The panel shows the screen being worked on.
  const acted = useScreenActivity(c);
  /** The latest recorded step on a screen: the thread's own on its screen, a helper's on the screen it passed. */
  const stepOn = (d: number) => {
    const s = holding.get(d);
    const n = DISPLAYS.indexOf(d) + 1;
    return [...(s?.steps ?? [])].reverse().find((st) => st.tool !== "note" && st.tool !== "setup" && (st.screen === undefined ? s?.display === d : st.screen === n));
  };
  /** The bot whose thread holds a screen: this one, or another that works on the same computer. */
  const botOn = (d: number) => state.bots.find((x) => x.id === holding.get(d)?.botId) ?? b;
  /** Who's working a screen: the bot on its thread, one of its helpers, or you. */
  const whoOn = (d: number) => (yours(d) ? "You" : helperOn(d) ? (helperName(d) ?? "A helper") : botOn(d).name);
  /** What's being done there, as the task, not the screen it happens on. */
  const doingOn = (d: number) => {
    const s = holding.get(d);
    if (yours(d) && (!s || !live(s))) return "In control";
    if (!s) return "";
    return helperOn(d) ? (s.helperTasks?.[d] ?? stepOn(d)?.detail ?? `Helping with ${s.title}`) : s.title;
  };
  /** What an idle screen has open, by its page title: a standing tab like X or LinkedIn is worth seeing. */
  const pageOn = (d: number) => {
    const w = watchOn(d);
    if (w) return w.site;
    const p = info?.pages?.[d];
    if (!p || /^(chrome:\/\/newtab|chrome-extension:|http:\/\/127\.0\.0\.1:7600)/.test(p.url)) return "Home";
    if (p.url === "about:blank") return "Blank page";
    try {
      return p.title || new URL(p.url).hostname.replace(/^www\./, "");
    } catch {
      return p.title || p.url;
    }
  };
  const tasks = DISPLAYS.filter((d) => holding.has(d) || yours(d));
  const lastAct = (d: number) => Math.max(acted[d] ?? 0, stepOn(d)?.at ?? 0);
  /** A screen showing something only the user can do: a sign-in, a payment, a draft to approve. */
  /** A screen kept on one site that Jev watches for the user (see lib/server/watches.ts). */
  const watchOn = (d: number) => state.watches?.find((w) => here(w.botId) && !w.mac && w.display === d);
  const needsYouOn = (d: number) => {
    const r = readOn(d);
    return !!(r?.blocker || (r?.kind === "email_compose" && r.email) || (holding.get(d)?.blocker && holding.get(d)?.display === d) || (!holding.has(d) && watchOn(d)?.alert));
  };
  const working = DISPLAYS.filter((d) => holding.has(d) && live(holding.get(d)!));
  const [now, setNow] = useState(() => Date.now());
  const [hovering, setHovering] = useState(false);
  // The watch setup card, for the screen it's about.
  const [sheet, setSheet] = useState<number | null>(null);
  const [cut, setCut] = useState<{ display: number; text: string; at: number }>({ display: -1, text: "", at: 0 });
  // The space the frame can fill, so a pair of screens can pick its orientation.
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!stage) return;
    const ro = new ResizeObserver(([e]) => setRoom({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(stage);
    return () => ro.disconnect();
  }, [stage]);
  // Every screen streams live: over the tailnet, or through Orgo when it streams them all (AppState.screenStream).
  const everyLive = DISPLAYS.every((d) => streamsLive(c, d, state.screenStream));
  // How many screens are busy sets the layout: one big screen, two side by side, or all four two by
  // two. A screen that needs you gets the whole frame (its card needs the room); a screen you
  // picked stays on its own until you say Follow.
  const auto = mode === "panel" && !!follow?.on && state.takeover?.botId !== b.id;
  const tiles = auto && !mac && !asleep && everyLive && !DISPLAYS.some(needsYouOn) ? (working.length >= 3 ? DISPLAYS : working.length === 2 ? working : []) : [];
  const grid = tiles.length > 1;
  const following = auto && !grid;
  const acting = (d: number) => working.includes(d) && now - lastAct(d) < FRESH_MS;
  const cutLabel = (d: number) => {
    const w = watchOn(d);
    if (w?.alert && !holding.has(d)) return `${w.site}: ${w.alert.text}`;
    if (needsYouOn(d)) return `${botOn(d).name} needs you`;
    const doing = helperOn(d) ? stepOn(d)?.detail : holding.get(d)?.activity;
    return `Now: ${whoOn(d)} · ${doing ?? doingOn(d)}`;
  };
  /** Where to cut to, if anywhere: a screen that needs you at once; else, calmly, where the action is. */
  const pickCut = (t: number) => {
    if (!following) return null;
    const urgent = DISPLAYS.find(needsYouOn);
    if (urgent !== undefined) return urgent === display ? null : urgent;
    if (hovering || t - cut.at < DWELL_MS) return null;
    const [top] = [...working].sort((x, y) => lastAct(y) - lastAct(x));
    return top !== undefined && top !== display && t - lastAct(top) < FRESH_MS && t - lastAct(display) > QUIET_MS ? top : null;
  };
  // The director ticks twice a second, always with this render's view of the screens.
  const tick = useRef<() => void>(() => {});
  useEffect(() => {
    tick.current = () => {
      if (hidden) return;
      const t = Date.now();
      setNow(t);
      const to = pickCut(t);
      if (to === null) return;
      setCut({ display: to, text: cutLabel(to), at: t });
      follow?.auto(to);
    };
  });
  useEffect(() => {
    const t = setInterval(() => tick.current(), 500);
    return () => clearInterval(t);
  }, []);
  const cutNote = cut.display === display && now - cut.at < 2600 ? cut.text : null;
  /** Private pages stay sharp only when you're looking straight at them. */
  const blurred = (d: number) => !!readOn(d)?.sensitive;
  const takeover = state.takeover?.botId === b.id && state.takeover.display === display ? state.takeover : undefined;
  // This screen's control session, kept a moment after it ends so the notch can slide away, and the
  // pill that says who's driving now. Switching screens just moves on, without the animation.
  const [held, setHeld] = useState<{ since: number; display: number; leaving?: boolean } | null>(null);
  const [handoff, setHandoff] = useState<{ to: "you" | "bot"; key: string } | null>(null);
  const [mountedAt] = useState(() => Date.now());
  if (takeover && (held?.since !== takeover.since || held.display !== display || held.leaving)) {
    setHeld({ since: takeover.since, display });
    // Not when Bops opens on a screen you already had.
    if (held?.since !== takeover.since && takeover.since > mountedAt - 3000) setHandoff({ to: "you", key: `in-${takeover.since}` });
  } else if (!takeover && held && !held.leaving) {
    if (held.display !== display) setHeld(null);
    else {
      setHeld({ ...held, leaving: true });
      setHandoff({ to: "bot", key: `out-${held.since}` });
    }
  }
  useEffect(() => {
    if (!held?.leaving) return;
    const t = setTimeout(() => setHeld(null), 400);
    return () => clearTimeout(t);
  }, [held]);
  useEffect(() => {
    if (!handoff) return;
    const t = setTimeout(() => setHandoff(null), 1900);
    return () => clearTimeout(t);
  }, [handoff]);
  const leaving = !takeover && !!held?.leaving;
  // Esc hands control back. It's caught before the live screen gets it (so it doesn't also reach the
  // bot's computer), except while typing in Bops itself (the chat, the address bar), where Esc is Esc.
  useEffect(() => {
    if (!takeover) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void post("/api/takeover", {}, "DELETE");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [takeover]);
  // The screen's frame size, for drawing the bezel.
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!frameEl) return;
    // Exact (fractional) size: rounding it left a hairline of the frame showing between the bezel and the chin.
    const ro = new ResizeObserver(() => {
      const r = frameEl.getBoundingClientRect();
      setFrameSize((x) => (x.w === r.width && x.h === r.height ? x : { w: r.width, h: r.height }));
    });
    ro.observe(frameEl);
    return () => ro.disconnect();
  }, [frameEl]);
  const busy = !!onScreen || !!takeover;
  const lastStep = onScreen?.steps.filter((x) => x.tool !== "setup").at(-1);
  const watchedHere = !onScreen ? watchOn(display) : undefined;

  const sendInput = (action: ScreenInput) => void post("/api/input", { botId: b.id, display, ...action });
  // How a screen is shown. Orgo computers show their real desktop live where it streams; the mirror
  // (just the bot's page, as live DOM) is the Mac's view and an option on Orgo; video is the fallback.
  // How a screen is shown is decided for you: the real desktop live on Orgo, the bot's page on this
  // Mac (no desktop there), screenshots only if a live view can't connect. Reader is the one choice,
  // offered while the bot is reading something long.
  const [fallback, setFallback] = useState<Record<string, View>>({});
  // Nothing connects to a computer that's asleep, so a view that gave up then (before the app knew it was
  // asleep) is tried again once it wakes.
  const [wasAsleep, setWasAsleep] = useState(asleep);
  if (wasAsleep !== asleep) {
    setWasAsleep(asleep);
    if (asleep) setFallback({});
  }
  const [readerFor, setReaderFor] = useState<string | null>(null);
  const [tabs, setTabs] = useState<{ key: string; tabs: MirrorTab[] }>({ key: "", tabs: [] });
  const viewKey = `${b.id}-${display}`;
  // Its screens' Chrome is reachable (the mirror, page reads, the address bar): on this Mac, or over the tailnet.
  const reachable = mac || !!c.tailnet;
  /**
   * A screen whose real desktop streams live: Orgo's own screen always (WebRTC, else VNC), every screen
   * over the tailnet, or through Orgo's VNC when it streams them all.
   */
  const canDesktop = (d: number) => !mac && streamsLive(c, d, state.screenStream) && !fallback[`${b.id}-${d}`];
  /** A screen's live desktop didn't connect, or Orgo can't stream it: it's shown another way from now on. */
  const showOtherwise = (d: number) => setFallback((x) => ({ ...x, [`${b.id}-${d}`]: reachable ? "page" : "video" }));
  /** An idle screen showing a site can become a watched one. */
  const watchable = (d: number) => reachable && !holding.has(d) && !yours(d) && !watchOn(d) && pageOn(d) !== "Home" && pageOn(d) !== "Blank page";
  const canWatchHere = watchable(display);
  const live_: View = fallback[viewKey] ?? (canDesktop(display) ? "desktop" : reachable ? "page" : "video");
  const readable = reachable && (read?.kind === "article" || readerFor === viewKey);
  const view: View = readerFor === viewKey && readable ? "reader" : live_;
  const fallBackTo = (v: View) => setFallback((x) => ({ ...x, [viewKey]: v }));
  // The real screen's shape (4:3 on new computers, 16:9 on older ones), learned from the stream.
  const [aspect, setAspect] = useState<Record<string, number>>({});
  const ratio = aspect[b.id] ?? 4 / 3;
  // A pair goes side by side or stacked, whichever gives each screen more room in the space there is.
  const stacked = tiles.length === 2 && room.w > 0 && Math.min(room.w, (room.h / 2) * ratio) > Math.min(room.w / 2, room.h * ratio);
  const frameRatio = tiles.length === 2 ? (stacked ? ratio / 2 : ratio * 2) : ratio;
  const mirrored = view === "page";
  const desktop = view === "desktop";
  /** In the side panel, the computer is a button: clicking in opens it full size and takes control. */
  const clickable = !takeover && mode === "panel";
  const shownTabs = tabs.key === viewKey ? tabs.tabs : [];
  // A sign-in or code the bot is stuck on gets a native card over the page (until the user says "not now").
  const [dismissed, setDismissed] = useState<string | null>(null);
  const cardKey = `${viewKey}|${read?.url}|${read?.blocker}`;
  // One card at a time: what's blocking the bot first, then a draft waiting for the user's OK.
  const card: "signin" | "payment" | "email" | null =
    dismissed === cardKey || !read
      ? null
      : read.blocker === "payment" && read.payment
        ? "payment"
        : read.form && (read.blocker === "sign_in" || read.blocker === "two_factor")
          ? "signin"
          : read.kind === "email_compose" && read.email
            ? "email"
            : null;

  if (!hasComputer) return <NoComputer state={state} bot={b} host={c} />;

  // The panel centers the screen with what's under it: thumbnails, the follow line, the status.
  const centered = mode === "panel" && desktop;
  const followRow = working.length > 1 || (!!follow && !follow.on);
  const reserve = 84 + (takeover ? 0 : 44) + 24 + (followRow ? 28 : 0) + 4;

  // Live desktops stay connected for every screen being worked on, stacked, so a cut is a crossfade
  // instead of a reconnect; the pair and the grid lay the same connections out side by side.
  // None while it's asleep: a stream that can't connect would give up on the screen for good.
  const warm = asleep ? [] : DISPLAYS.filter((d) => canDesktop(d) && (grid ? tiles.includes(d) : d === display || (follow?.on && working.includes(d))));
  const desktops = (interactive: boolean) => (
    <div className={grid ? `grid h-full w-full gap-[3px] ${tiles.length > 2 ? "grid-cols-2 grid-rows-2" : stacked ? "grid-rows-2" : "grid-cols-2"}` : "relative h-full w-full"}>
      {warm.map((d) => {
        const on = d === display;
        const s = holding.get(d);
        return (
          <div
            key={d}
            onClick={
              grid
                ? (e) => {
                    e.stopPropagation();
                    onDisplay(d);
                  }
                : undefined
            }
            title={grid ? "Watch this up close" : undefined}
            className={grid ? `group/tile relative min-h-0 cursor-pointer overflow-hidden ${s ? "" : "opacity-75"}` : `absolute inset-0 transition-opacity duration-300 ${on ? "z-[1] opacity-100" : "pointer-events-none opacity-0"}`}
          >
            <LiveDesktop
              // Its own per bot: a stream, and whether it was ever live, aren't carried over to another bot's screen.
              key={`${b.id}-${d}`}
              botId={b.id}
              bot={b}
              display={d}
              interactive={interactive && on && !grid}
              onFail={() => showOtherwise(d)}
              onSize={(w, h) => setAspect((x) => (x[b.id] === w / h ? x : { ...x, [b.id]: w / h }))}
              className="h-full w-full"
            />
            {s && live(s) && !yours(d) && (grid || on) && (
              <BotCursor bot={botOn(d)} ip={c.tailnet?.ip} display={d} caption={helperOn(d) ? undefined : s.activity} helper={helperOn(d) ? (helperName(d) ?? "") : undefined} />
            )}
            {grid && (
              <>
                <div
                  className="pointer-events-none absolute inset-0 z-20 transition-shadow duration-300"
                  style={{ boxShadow: acting(d) ? `inset 0 0 0 3px ${botBezel(b)}` : undefined }}
                />
                <div className="pointer-events-none absolute inset-0 z-20 opacity-0 transition-opacity duration-200 group-hover/tile:opacity-100" style={{ boxShadow: "inset 0 0 0 2px #0A0A0A" }} />
                <span className="absolute bottom-1.5 left-1.5 z-20 flex max-w-[85%] items-center gap-1 rounded-full bg-white/95 py-[2px] pl-1 pr-2 text-[11px] leading-[14px] shadow-[0_0_0_1px_#0000000F]">
                  {s ? (
                    <>
                      <Mascot botId={b.id} color={b.color} size={13} antenna={false} />
                      <span className="shrink-0 font-semibold">{whoOn(d)}</span>
                      <span className="truncate text-[#3A3A38]">{doingOn(d)}</span>
                    </>
                  ) : (
                    <span className="truncate pl-1 text-[#6B6B6B]">{pageOn(d)}</span>
                  )}
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );

  const real = (interactive: boolean) =>
    view === "desktop" ? (
      desktops(interactive)
    ) : view === "reader" ? (
      <ReaderView key={`${viewKey}-r`} botId={b.id} display={display} className="h-full w-full" />
    ) : mirrored ? (
      <MirrorScreen
        key={`${viewKey}-m${interactive}`}
        botId={b.id}
        display={display}
        interactive={interactive}
        onInput={sendInput}
        onFail={() => fallBackTo("video")}
        onTabs={(t) => setTabs({ key: viewKey, tabs: t })}
        className="h-full w-full"
      />
    ) : (
      <LiveScreen key={`${viewKey}-v${interactive}`} bot={b} botId={b.id} display={display} interactive={interactive} onInput={sendInput} onFail={recheck} className="h-full w-full" />
    );
  // A real desktop is the computer itself, so it always shows; elsewhere a free screen shows the bot's home screen.
  const showingReal = view === "desktop" || view === "reader" || !!takeover || busy || showReal || !!read?.blocker || card === "email";
  const screen = asleep ? <AsleepScreen bot={b} host={c} waking={inUse} hoursOut={hoursOut && time ? freeHoursOutLine(time) : undefined} /> : takeover ? real(true) : showingReal ? real(false) : <HomeScreen state={state} bot={b} />;

  return (
    <div
      data-screen={screenNo(display)}
      data-tiles={tiles.length || 1}
      className={`flex min-h-0 flex-1 flex-col gap-3 ${mode === "focus" ? "px-5 pb-4 pt-3.5" : ""}`}
      // In the panel, the screen, its thumbnails and the status sit together in the middle.
      style={centered ? { containerType: "size", justifyContent: "center" } : undefined}
    >
      {mode === "focus" ? (
        <div className="flex items-center gap-2.5">
          <button onClick={onBack} className="flex items-center gap-1.5 rounded-full py-1.5 pl-2 pr-3 shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
            <svg width="12" height="12" viewBox="0 0 14 14">
              <path d="M9 2.5L4.5 7 9 11.5" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <Mascot botId={b.id} color={b.color} size={18} />
            <span className="text-[13px] font-medium leading-4">Back to {b.name}</span>
          </button>
          <span className="text-[15px] font-semibold leading-5">{b.name}&apos;s computer</span>
          <span className="flex-1" />
          <div className="flex gap-1">
            {DISPLAYS.map((d) => {
              const on = d === display;
              const busy = tasks.includes(d);
              return (
                <button
                  key={d}
                  onClick={() => onDisplay(d)}
                  className={`flex items-center gap-1.5 rounded-[9px] py-[5px] ${busy ? "pl-1.5" : "pl-2.5"} pr-2.5 ${on ? "bg-ink" : busy ? "bg-[#F2F2F0]" : "shadow-[inset_0_0_0_1.2px_#D9D9D6]"}`}
                >
                  {busy && <Mascot botId={b.id} color={b.color} size={14} antenna={false} />}
                  {busy && <span className={`text-[12px] font-medium leading-4 ${on ? "text-white" : "text-ink"}`}>{whoOn(d)}</span>}
                  <span className={`max-w-[120px] truncate text-[12px] leading-4 ${on ? "text-white/70" : "text-[#6B6B6B]"}`}>{busy ? doingOn(d) : pageOn(d)}</span>
                </button>
              );
            })}
          </div>
          {readable && (
            <button
              onClick={() => setReaderFor(readerFor === viewKey ? null : viewKey)}
              className={`flex shrink-0 items-center gap-1.5 rounded-full py-1 pl-2 pr-2.5 text-[12px] font-medium leading-4 ${readerFor === viewKey ? "bg-ink text-white" : "bg-white text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]"}`}
              title={readerFor === viewKey ? "Back to the computer" : "What the bot is reading, as a clean page you can skim"}
            >
              <svg width="12" height="12" viewBox="0 0 16 16">
                <path d="M2 3.5h4.5A1.5 1.5 0 0 1 8 5v8a1.5 1.5 0 0 0-1.5-1.5H2zM14 3.5H9.5A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5H14z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
              {readerFor === viewKey ? "Back to computer" : "Read along"}
            </button>
          )}
        </div>
      ) : null}

      {/* The real desktop is the frame itself, edge to edge in the panel's rounded corners, like
          Dots; other views sit as a screen on the bot's wash. */}
      <div
        ref={setStage}
        // The room for the take-control chin (--chin) grows and shrinks with the chin itself.
        className={`flex min-h-0 flex-1 flex-col items-center ${takeover ? "animate-[chin-room_420ms_cubic-bezier(.2,.9,.3,1)_both]" : leaving ? "animate-[chin-room-out_260ms_ease-in_both]" : ""}`}
        style={
          desktop
            ? {
                containerType: "size",
                justifyContent: "center",
                // As tall as the screen's shape needs, leaving room for the thumbnails and status.
                ...(centered ? { flex: "none", height: `min(calc(100cqh - ${reserve}px), calc(100cqw / ${frameRatio} + var(--chin)))` } : {}),
              }
            : undefined
        }
      >
        <div
          ref={setFrameEl}
          // The screen makes room for the chin at once (the chin's own opening is what animates), so the two never overlap the thumbnails.
          className={`relative flex min-h-0 flex-col overflow-hidden rounded-[22px] transition-[box-shadow,padding] duration-300 ease-out ${desktop ? "" : "w-full flex-1 p-3"}`}
          style={{
            backgroundImage: botWash(b),
            ...(desktop
              ? // Sized to the desktop's shape, leaving room for the "You have control" tab under it.
                { width: `min(100cqw, calc((100cqh - var(--chin)) * ${frameRatio}))`, aspectRatio: `${frameRatio}`, flex: "none" }
              : { boxShadow: takeover ? `inset 0 0 0 10px ${botBezel(b)}` : undefined, padding: takeover ? 18 : undefined }),
          }}
        >
          {desktop && (takeover || leaving) && frameSize.w > 0 && (
            // The bezel grows out of the chin: from the bottom middle, up both sides, meeting at the top
            // (and retracts back into it), so the chin is never cut off from the screen.
            <svg key={`ring-${held?.since}-${leaving}`} className="pointer-events-none absolute inset-0 z-20 h-full w-full" aria-hidden>
              {bezelPaths(frameSize.w, frameSize.h).map((d, i) => (
                <path
                  // By side, not by shape: the screen resizes while the line draws, and a new key would restart it.
                  key={i}
                  d={d}
                  fill="none"
                  stroke={botBezel(b)}
                  // A little past the frame's edge (clipped there), so no sliver of it shows.
                  strokeWidth="10"
                  pathLength={1}
                  strokeDasharray="1 1"
                  className={takeover ? "animate-[ring-draw_620ms_cubic-bezier(.45,0,.2,1)_both]" : "animate-[ring-retract_340ms_ease-in_both]"}
                />
              ))}
            </svg>
          )}
          <div
            onMouseEnter={() => setHovering(true)}
            onMouseLeave={() => setHovering(false)}
            // Clicking in takes control right here (the "You have control" notch drops down); full screen is its own button.
            // Not while it's asleep: waking it costs Free's hours, so that's the Take control button's alone.
            onClick={() => !takeover && !grid && clickable && !asleep && post("/api/takeover", { botId: b.id, display })}
            className={`group/screen relative flex min-h-0 flex-1 flex-col overflow-hidden ${desktop ? "" : "rounded-xl bg-white shadow-[0_18px_40px_-16px_#28320073,0_0_0_1px_#0000000F]"} ${clickable && !asleep ? "cursor-pointer" : ""}`}
          >
            {/* Hovering a computer you can click into: a soft ring in the bot's color and a small pill, instead of a zoom cursor. */}
            {clickable && !asleep && !grid && sheet !== display && (
              <div className="pointer-events-none absolute inset-0 z-30 opacity-0 transition-opacity duration-200 group-hover/screen:opacity-100">
                <div className={`absolute inset-0 ${desktop ? "rounded-[22px]" : "rounded-xl"}`} style={{ boxShadow: `inset 0 0 0 2.5px ${botBezel(b)}` }} />

              </div>
            )}
            {handoff && (
              <div
                key={handoff.key}
                className="pointer-events-none absolute left-1/2 top-3 z-40 flex animate-[handoff_1900ms_ease-in-out_both] items-center gap-2 rounded-full bg-white/95 py-1 pl-1 pr-3 shadow-[0_0_0_1px_#0000000F,0_10px_24px_-10px_#00000066] backdrop-blur"
              >
                {handoff.to === "you" ? (
                  <span className="flex size-6 items-center justify-center rounded-full" style={{ background: botBezel(b) }}>
                    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                      <path d="M4 2.5l8.5 5-3.6.9-1.8 3.6z" fill="#0A0A0A" stroke="#0A0A0A" strokeWidth="1.2" strokeLinejoin="round" />
                    </svg>
                  </span>
                ) : (
                  <Mascot botId={b.id} color={b.color} size={24} antenna={false} />
                )}
                <span className="whitespace-nowrap text-[12.5px] font-medium leading-4 text-ink">
                  {handoff.to === "you" ? (
                    <>
                      {b.name} paused <span className="font-normal text-[#6B6B6B]">· you&rsquo;re driving</span>
                    </>
                  ) : (
                    <>Back to {b.name}</>
                  )}
                </span>
              </div>
            )}
            {/* Pointing at the screen brings up its controls, like a video player's: watch it, take control, reset it. */}
            {!grid && !takeover && sheet !== display && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute bottom-3 left-1/2 z-40 flex -translate-x-1/2 translate-y-1 items-center gap-1 rounded-full bg-white/95 p-1 opacity-0 shadow-[0_0_0_1px_#0000000F,0_10px_24px_-10px_#00000066] backdrop-blur transition duration-200 group-hover/screen:translate-y-0 group-hover/screen:opacity-100 has-[[data-open=true]]:translate-y-0 has-[[data-open=true]]:opacity-100"
              >
                <button
                  onClick={() => (watchedHere || canWatchHere) && setSheet(display)}
                  disabled={!watchedHere && !canWatchHere}
                  title={
                    watchedHere
                      ? `Change what ${watchedHere.site} is watched for`
                      : canWatchHere
                        ? `Keep this screen on ${pageOn(display)} and get a heads-up when something needs you`
                        : holding.has(display)
                          ? `${b.name} is using this screen`
                          : yours(display)
                            ? "You're driving this screen"
                            : "Open a site on this screen to watch it"
                  }
                  className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium leading-4 text-ink hover:bg-[#F2F2F0] disabled:cursor-default disabled:text-[#B0B0AD] disabled:hover:bg-transparent"
                >
                  <EyeIcon />
                  {watchedHere ? "Edit" : "Watch"}
                </button>
                <button
                  onClick={() => void post("/api/takeover", { botId: b.id, display })}
                  disabled={asleep && hoursOut}
                  title={asleep && hoursOut ? "Your Bops computer has used its free hours" : asleep ? "Wake the computer and drive this screen yourself" : "Pause the bot here and drive the screen yourself"}
                  className="flex items-center gap-1.5 rounded-full bg-ink py-1.5 pl-2 pr-3.5 text-[13px] font-semibold leading-4 text-white disabled:cursor-default disabled:bg-[#B0B0AD]"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                    <path d="M4 2.5l8.5 5-3.6.9-1.8 3.6z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                  </svg>
                  Take control
                </button>
                {mode === "panel" && onFocus && (
                  <button onClick={onFocus} title="Full screen" aria-label="Full screen" className="flex size-[30px] items-center justify-center rounded-full text-[#6B6B6B] hover:bg-[#F2F2F0] hover:text-ink">
                    <ExpandIcon />
                  </button>
                )}
                {!mac && c.computerId && (
                  <ResetMenu
                    state={state}
                    bot={b}
                    screen={DISPLAYS.indexOf(display) + 1}
                    busy={onScreen && live(onScreen) ? { why: `${botOn(display).name} is working on it`, task: true } : yours(display) ? { why: "You're driving it" } : watchedHere ? { why: `Watching ${watchedHere.site} here` } : null}
                  />
                )}
              </div>
            )}
            {/* Reading something long: a clean copy to skim, offered on the screen itself. */}
            {mode === "panel" && readable && !grid && !takeover && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setReaderFor(readerFor === viewKey ? null : viewKey);
                }}
                title={readerFor === viewKey ? "Back to the computer" : "What the bot is reading, as a clean page you can skim"}
                className={`absolute right-3 top-3 z-40 flex items-center gap-1.5 rounded-full py-1 pl-2 pr-2.5 text-[12px] font-medium leading-4 shadow-[0_0_0_1px_#0000001A,0_6px_16px_-8px_#00000059] ${readerFor === viewKey ? "bg-ink text-white" : "bg-white/95 text-ink hover:bg-white"}`}
              >
                <svg width="12" height="12" viewBox="0 0 16 16">
                  <path d="M2 3.5h4.5A1.5 1.5 0 0 1 8 5v8a1.5 1.5 0 0 0-1.5-1.5H2zM14 3.5H9.5A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5H14z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                </svg>
                {readerFor === viewKey ? "Back to computer" : "Read along"}
              </button>
            )}
            {/* A watched screen says so: ring, corner pill, a sweep each time Jev reads it. */}
            {watchedHere && !grid && !takeover && sheet !== display && <WatchOverlay watch={watchedHere} rounded={desktop ? "rounded-[22px]" : "rounded-xl"} />}
            {showingReal && mirrored && shownTabs.length > 0 && <WindowBar bot={b} tabs={shownTabs} compact={mode === "panel"} />}
            <div className="relative min-h-0 flex-1">
              {view === "desktop" ? screen : <div key={display} className="h-full w-full animate-[screen-in_300ms_ease-out]">{screen}</div>}
              {/* Why the view just cut here: who's working and on what. */}
              {cutNote && !grid && (
                <span
                  key={cut.at}
                  className="pointer-events-none absolute left-1/2 top-3 z-20 max-w-[90%] -translate-x-1/2 animate-[cut-note_2600ms_ease-in-out_forwards] truncate rounded-full bg-ink/85 px-3 py-1 text-[12px] font-medium leading-4 text-white shadow-[0_6px_16px_-8px_#00000080] backdrop-blur"
                >
                  {cutNote}
                </span>
              )}
              {sheet === display && !grid && !takeover && (
                <WatchSheet key={display} bot={b} display={display} page={info?.pages?.[display]} watch={watchOn(display)} onClose={() => setSheet(null)} />
              )}
              {card && !takeover && !grid && view !== "reader" && (() => {
                const props = {
                  bot: b,
                  display,
                  read: read!,
                  compact: mode === "panel",
                  onTakeOver: () => void post("/api/takeover", { botId: b.id, display }),
                  onDismiss: () => setDismissed(cardKey),
                };
                return card === "payment" ? (
                  <PaymentCard key={cardKey} {...props} />
                ) : card === "email" ? (
                  <EmailCard key={cardKey} {...props} />
                ) : (
                  <SignInCard key={cardKey} {...props} vault={state.vault ?? []} />
                );
              })()}
            </div>
            {onScreen && !takeover && view !== "desktop" && (
              <span className="absolute bottom-3 left-3 rounded-full bg-highlighter px-2 py-[3px] text-[11px] font-semibold leading-[14px] shadow-[0_0_0_1px_#0000001F]">
                {b.name}
              </span>
            )}
            {!busy && !asleep && view !== "desktop" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowReal(!showReal);
                }}
                className="absolute right-3 top-3 rounded-full bg-white/85 px-2.5 py-1 text-[11px] font-medium text-[#3A3A38] shadow-[0_0_0_1px_#0000000F] hover:bg-white"
              >
                {showReal ? "Home screen" : "Real screen"}
              </button>
            )}
          </div>
        </div>
        {(takeover || leaving) && (
          // Its room opens as it slides out from under the screen, so there's never an empty strip.
          <div
            key={`chin-${held?.since}-${leaving}`}
            // Up a pixel, over the screen's edge, so there's no seam between them.
            className={`relative -mt-px grid ${takeover ? "animate-[chin-open_420ms_cubic-bezier(.2,.9,.3,1)_both]" : "animate-[chin-close_260ms_ease-in_both]"}`}
          >
            <div className="min-h-0 overflow-hidden">
            <div
              className={`flex h-[52px] items-center gap-3 rounded-b-[22px] pl-5 pr-2 ${takeover ? "animate-[notch-in_460ms_cubic-bezier(.2,1.25,.35,1)_both]" : "animate-[notch-out_260ms_ease-in_both]"}`}
              style={{ background: botBezel(b) }}
            >
              <span className="relative flex size-2.5 shrink-0" aria-hidden>
                <span className="absolute inset-0 animate-ping rounded-full bg-ink/30" />
                <span className="relative size-2.5 rounded-full bg-ink" />
              </span>
              <span className="whitespace-nowrap text-[15px] leading-5 text-ink">You&rsquo;re driving</span>
              {reachable && view !== "desktop" && <AddressBar botId={b.id} display={display} />}
              {mode === "panel" && onFocus && (
                <button onClick={onFocus} title="Full screen" aria-label="Full screen" className="flex size-9 shrink-0 items-center justify-center rounded-full text-ink hover:bg-black/[0.08]">
                  <ExpandIcon />
                </button>
              )}
              <button
                onClick={() => void post("/api/takeover", {}, "DELETE")}
                title={`${b.name} picks up from here (Esc)`}
                className="flex shrink-0 items-center gap-2 rounded-full bg-ink py-1.5 pl-1.5 pr-4 text-[14px] font-semibold leading-[18px] transition-transform active:scale-[0.97]"
                style={{ color: botOnInk(b) }}
              >
                <Mascot botId={b.id} color={b.color} size={22} antenna={false} />
                Hand back to {b.name}
                <kbd className="rounded-[5px] bg-white/15 px-1.5 py-px font-sans text-[11px] font-medium leading-4 text-white/70">esc</kbd>
              </button>
            </div>
            </div>
          </div>
        )}
      </div>

      {mode === "panel" && (working.length > 1 || (follow && !follow.on)) && (
        <div className="-mb-1 flex items-center gap-2">
          {follow?.on ? (
            <span className="flex items-center gap-1.5 text-[12px] leading-4 text-[#6B6B6B]" title="Bops shows the screens being worked on. Pick one to stay on it.">
              <span className="size-1.5 animate-pulse rounded-full" style={{ background: botBezel(b) }} />
              {grid ? `Watching ${working.length} things at once` : "Following the action"}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[12px] leading-4 text-[#6B6B6B]">
              Staying {onScreen ? `on ${helperOn(display) ? whoOn(display) : onScreen.title}` : "here"}
              {follow && (
                <button onClick={follow.resume} className="rounded-full bg-white px-2 py-[2px] font-medium text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]">
                  Follow
                </button>
              )}
            </span>
          )}
        </div>
      )}

      {mode === "panel" && (
        <div className="flex gap-2.5">
          {DISPLAYS.map((d) => {
            const s = holding.get(d);
            const inView = d === display && !grid;
            const w = watchOn(d);
            const alert = !s && w?.alert;
            // An idle screen with a site open can be watched; a watched one can be let go.
            const canWatch = watchable(d);
            return (
              <button
                key={d}
                onClick={() => {
                  onDisplay(d);
                  if (w?.alert) void post("/api/watches", { id: w.id, action: "seen" }, "PATCH");
                }}
                title={tasks.includes(d) ? `${whoOn(d)} · ${doingOn(d)}` : w ? `Watching ${w.site} for ${w.lookFor}` : pageOn(d)}
                // A screen being worked on right now glows in the bot's color, even when it isn't the one on show;
                // a watched screen with something waiting for the user gets the "needs you" yellow.
                style={
                  alert
                    ? { boxShadow: "0 0 0 2px #0A0A0A, 0 0 0 4px #E8FF3A" }
                    : !inView && acting(d)
                      ? { boxShadow: `0 0 0 2px ${botBezel(b)}, 0 0 14px -2px ${botBezel(b)}` }
                      : undefined
                }
                className={`group/thumb relative flex min-w-0 flex-1 basis-0 flex-col gap-1.5 rounded-xl p-1.5 text-left transition-shadow duration-300 ${inView ? "bg-white shadow-[0_0_0_2px_#0A0A0A]" : tasks.includes(d) || w ? "bg-[#F7F7F6]" : "shadow-[inset_0_0_0_1.5px_#E2E2DF]"}`}
              >
                {(canWatch || w) && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDisplay(d);
                      setSheet(d);
                    }}
                    title={w ? `Change what ${w.site} is watched for` : `Keep this screen on ${pageOn(d)} and tell me when something needs me`}
                    className="absolute left-2.5 top-2.5 z-10 flex items-center gap-1 rounded-full bg-white/95 py-[2px] pl-1.5 pr-2 text-[10.5px] font-medium leading-[14px] text-ink opacity-0 shadow-[0_0_0_1px_#0000001A,0_4px_10px_-4px_#00000040] transition-opacity group-hover/thumb:opacity-100"
                  >
                    <EyeIcon />
                    {w ? "Edit" : "Watch"}
                  </span>
                )}
                <div className="relative h-[52px] shrink-0 overflow-hidden rounded-[7px]" style={{ backgroundImage: botWash(b) }}>
                  {w && !s && <WatchBadge watch={w} />}
                  {!asleep && (s || (!mac && everyLive)) ? (
                    canDesktop(d) ? (
                      <LiveDesktop
                        key={`${b.id}-${d}-t`}
                        botId={b.id}
                        bot={b}
                        display={d}
                        interactive={false}
                        thumbnail
                        // Only Orgo saying the screen can't stream moves it to screenshots; a thumbnail that
                        // just didn't connect leaves the big view to try for itself.
                        onFail={(noStream) => noStream && showOtherwise(d)}
                        className={`h-full w-full ${blurred(d) ? "blur-[3px]" : ""}`}
                      />
                    ) : (
                      <LiveScreen key={`${b.id}-${d}-t`} bot={b} botId={b.id} display={d} intervalMs={5000} scale={0.3} onFail={recheck} className={`absolute inset-x-2 bottom-0 top-2 rounded-t-sm ${blurred(d) ? "blur-[3px]" : ""}`} />
                    )
                  ) : (
                    <div className="absolute inset-x-2.5 bottom-0 top-2 flex items-center justify-center rounded-t-sm bg-white/90">
                      <Mascot botId={b.id} color={b.color} size={18} />
                    </div>
                  )}
                  {s && live(s) && <span className={`absolute right-1 top-1 size-[9px] rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A] ${acting(d) ? "animate-pulse" : ""}`} />}
                </div>
                <div className="flex min-w-0 items-center gap-[5px] text-[11px] leading-[14px]">
                  {tasks.includes(d) ? (
                    <>
                      <Mascot botId={b.id} color={b.color} size={14} antenna={false} />
                      <span className="shrink-0 font-semibold">{whoOn(d)}</span>
                      <span className={`truncate ${inView ? "text-ink" : "text-[#6B6B6B]"}`}>{doingOn(d)}</span>
                    </>
                  ) : w ? (
                    <>
                      <EyeIcon />
                      <span className="shrink-0 font-semibold">{w.site}</span>
                      {alert && <span className="truncate rounded-[4px] bg-highlighter px-1 text-ink">{w.alert!.text}</span>}
                    </>
                  ) : (
                    <span className="truncate pl-0.5 text-[#9A9A98]">{pageOn(d)}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Under the screen, only when something's going on: a bot at work, something waiting on you, news. Its controls are on the screen. */}
      {!takeover && (grid || onScreen || read?.blocker || watchedHere?.alert) && (
        <div className={`flex max-w-full items-center gap-3 self-center rounded-full bg-white py-1.5 pl-3.5 ${watchedHere?.alert && !grid ? "pr-1.5" : "pr-3.5"} shadow-[0_0_0_1px_#ECECEA,0_6px_18px_-10px_#00000040]`}>
          <span className={`size-2 shrink-0 rounded-full ${grid ? "bg-[#2BB673]" : onScreen?.blocker || read?.blocker || watchedHere?.alert ? "bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]" : "bg-[#2BB673]"}`} />
          <span className="min-w-0 truncate text-[13px] leading-4">
            {grid
              ? `${b.name} is working on ${working.length} things · pick one to watch it up close`
              : onScreen?.blocker || read?.blocker
                ? `${botOn(display).name} needs you: ${BLOCKER_LABEL[(onScreen?.blocker ?? read?.blocker)!]}${read?.url ? ` on ${new URL(read.url).hostname}` : ""}`
                : onScreen
                  ? `${whoOn(display)} · ${(helperOn(display) ? stepOn(display)?.detail : lastStep?.detail) ?? onScreen.title}`
                  : `New on ${watchedHere!.site}: ${watchedHere!.alert!.text}`}
          </span>
          {!grid && watchedHere?.alert && (
            <button
              onClick={() => void post("/api/watches", { id: watchedHere.id, action: "draft" }, "PATCH")}
              title={`${b.name} writes a reply on ${watchedHere.site} for you to read and send`}
              className="shrink-0 rounded-full bg-highlighter px-3.5 py-1.5 text-[13px] font-semibold leading-4 text-ink shadow-[0_0_0_1px_#0000001F]"
            >
              Draft a reply
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Put screens back the way a new computer starts: one Chrome window on the home screen, nothing
 * else open (logins stay). This screen, all of this bot's, or every bot's on the team. Screens in
 * use are skipped (this one can stop its task first). Each choice asks once more before it runs.
 */
function ResetMenu({ state, bot: b, screen, busy }: { state: AppState; bot: Bot; screen: number; busy: { why: string; task?: boolean } | null }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirm(null);
      }
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(t);
  }, [note]);
  const team = state.bots.filter((x) => workspaceOf(x) === workspaceOf(b) && x.computerId);
  type Result = { name: string; reset: number[]; skipped: { screen: number; why: string }[]; error?: string };
  const run = async (key: string, body: Record<string, unknown>) => {
    if (confirm !== key) return setConfirm(key);
    setOpen(false);
    setConfirm(null);
    setRunning(true);
    setNote("Resetting…");
    const j = (await (await post("/api/computer/reset", { botId: b.id, ...body })).json()) as { results?: Result[]; error?: string };
    setRunning(false);
    const rs = j.results ?? [];
    const done = rs.reduce((n, r) => n + r.reset.length, 0);
    const skipped = rs.flatMap((r) => r.skipped.map((x) => `${rs.length > 1 ? `${r.name}'s ` : ""}screen ${x.screen} (${x.why.charAt(0).toLowerCase()}${x.why.slice(1)})`));
    const failed = rs.filter((r) => r.error).map((r) => `${r.name}: ${r.error}`);
    setNote(j.error ?? [done ? `Reset ${done} screen${done === 1 ? "" : "s"}` : "Nothing reset", skipped.length ? `skipped ${skipped.join(", ")}` : "", ...failed].filter(Boolean).join(" · "));
  };
  const item = (key: string, title: string, detail: string, body: Record<string, unknown>, disabled = false) => (
    <button
      key={key}
      disabled={disabled}
      onClick={() => void run(key, body)}
      className={`flex flex-col items-start gap-0.5 rounded-[10px] px-3 py-2 text-left disabled:opacity-40 ${confirm === key ? "bg-[#FBEAEA]" : "hover:bg-[#F7F7F6]"}`}
    >
      <span className={`text-[13.5px] font-medium leading-[18px] ${confirm === key ? "text-[#B42318]" : ""}`}>{confirm === key ? `${title}? Click again` : title}</span>
      <span className="text-[12px] leading-4 text-[#9A9A98]">{detail}</span>
    </button>
  );
  return (
    <div ref={box} data-open={open || !!note} className="relative shrink-0">
      <button
        onClick={() => {
          setOpen((o) => !o);
          setConfirm(null);
        }}
        disabled={running}
        title="Reset screens"
        aria-label="Reset screens"
        className={`flex size-[30px] items-center justify-center rounded-full text-[#6B6B6B] hover:bg-[#F2F2F0] hover:text-ink ${open ? "bg-[#F2F2F0] text-ink" : ""} ${running ? "animate-spin" : ""}`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.8 8a5.2 5.2 0 109.2-3.3M12.6 1.8v3.2H9.4" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-[calc(100%+10px)] right-0 z-40 flex w-[290px] flex-col rounded-[14px] bg-white p-1.5 shadow-[0_0_0_1px_#E6E6E3,0_12px_32px_rgba(0,0,0,0.14)]">
          <div className="px-3 pb-1 pt-1.5 text-[12px] leading-4 text-[#9A9A98]">Back to the home screen, with nothing else open. Logins stay.</div>
          {busy
            ? busy.task
              ? item("one", `Stop and reset screen ${screen}`, `${busy.why}; its task stops`, { screen, force: true })
              : item("one", `Reset screen ${screen}`, busy.why, { screen }, true)
            : item("one", `Reset screen ${screen}`, "Just this screen", { screen })}
          {item("bot", `Reset all of ${b.name}'s screens`, "Screens in use are left alone", {})}
          {team.length > 1 && item("team", "Reset every bot's screens", `${team.length} computers · screens in use are left alone`, { team: true })}
        </div>
      )}
      {note && !open && (
        <div className="absolute bottom-[calc(100%+10px)] right-0 z-40 w-max max-w-[340px] rounded-[12px] bg-ink px-3 py-2 text-[12.5px] leading-[17px] text-white shadow-[0_10px_24px_-10px_#00000080]">{note}</div>
      )}
    </div>
  );
}

type View = "desktop" | "page" | "reader" | "video";

/**
 * The bezel as two lines, each from the bottom middle of the screen (where the chin is) up one side
 * to the top middle, following the frame's rounded corners 4 px in (an 8 px stroke fills the edge).
 */
function bezelPaths(w: number, h: number) {
  const i = 4;
  const r = 18;
  const [x0, y0, x1, y1, cx] = [i, i, w - i, h - i, w / 2];
  return [
    `M${cx} ${y1}H${x0 + r}A${r} ${r} 0 0 1 ${x0} ${y1 - r}V${y0 + r}A${r} ${r} 0 0 1 ${x0 + r} ${y0}H${cx}`,
    `M${cx} ${y1}H${x1 - r}A${r} ${r} 0 0 0 ${x1} ${y1 - r}V${y0 + r}A${r} ${r} 0 0 0 ${x1 - r} ${y0}H${cx}`,
  ];
}

function ExpandIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1.5 5V1.5H5M9 1.5h3.5V5M12.5 9v3.5H9M5 12.5H1.5V9" />
    </svg>
  );
}

export function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" className="shrink-0">
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="#0A0A0A" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" fill="#0A0A0A" />
    </svg>
  );
}

/** The mirrored screen drawn as a window: the bot's open tabs, the one it's on highlighted. */
function WindowBar({ bot: b, tabs, compact }: { bot: Bot; tabs: MirrorTab[]; compact: boolean }) {
  const host = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };
  const active = tabs.find((t) => t.active);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#EFEFED] bg-[#FAFAF9] px-3">
      <span className="flex shrink-0 gap-1.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-[9px] rounded-full" style={{ background: i === 0 ? b.color : "#E2E2DF" }} />
        ))}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {tabs.slice(-(compact ? 3 : 6)).map((t) => (
          <span
            key={t.id}
            title={t.url}
            className={`flex min-w-0 max-w-[200px] items-center gap-1.5 rounded-lg px-2 py-[3px] text-[12px] leading-4 ${t.active ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F,0_2px_6px_-3px_#00000026]" : "text-[#9A9A98]"}`}
          >
            {t.active && <Mascot botId={b.id} color={b.color} size={13} />}
            <span className="truncate">{t.title || host(t.url)}</span>
          </span>
        ))}
      </div>
      {active && !compact && <span className="shrink-0 truncate font-mono text-[11px] text-[#9A9A98]">{host(active.url)}</span>}
    </div>
  );
}

/**
 * The computer asleep (computerAsleep): nothing streams or reads its screens, which would wake it. A task
 * on it wakes it, and so does Take control; `waking` while one of those does. `hoursOut`: Free's hours this
 * week are used (the line Settings shows), so neither can. Why the last Take control couldn't wake it
 * (Bot.wakeFailed, cleared once a takeover or a task gets it up).
 */
function AsleepScreen({ bot: b, host, waking, hoursOut }: { bot: Bot; /** The bot whose computer it is. */ host: Bot; waking: boolean; hoursOut?: string }) {
  const failed = host.wakeFailed?.why;
  const line = hoursOut ?? (failed ? `It couldn't wake up just now. ${failed}` : "It wakes up when a task starts on it, or when you take control.");
  return (
    <div className="relative h-full w-full overflow-hidden" style={{ backgroundImage: botWash(b) }} data-asleep={waking ? "waking" : "asleep"}>
      {waking ? (
        <Waking thumbnail={false} bot={b} text={`Waking ${host.name}'s computer…`} />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-6 text-center">
          <Mascot botId={b.id} color={b.color} size={40} />
          <span className="rounded-full bg-white/85 px-3 py-1 text-[12.5px] font-medium leading-4 text-[#3A3A38] shadow-[0_0_0_1px_#0000000D,0_6px_16px_-8px_#00000033]">
            {`${host.name}'s computer is asleep`}
          </span>
          <span className="max-w-[300px] text-[12px] leading-4 text-[#6B6B6B]">{line}</span>
        </div>
      )}
    </div>
  );
}

/** The bot's own home screen, shown on a free screen instead of a blank browser. */
function HomeScreen({ state, bot: b }: { state: AppState; bot: Bot }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);
  const apps = botApps(state, b).slice(0, 6);
  const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M/, "");
  const ampm = now.getHours() < 12 ? "AM" : "PM";
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-[#FDFFF6] px-6">
      <div className="max-w-[210px] rounded-xl bg-white px-3 py-2 text-[11.5px] leading-[15px] text-[#3A3A38] shadow-[0_0_0_1px_#0000000F,0_6px_16px_-8px_#00000014]">
        This is my computer. Watch me work, or take over when you need to.
      </div>
      <Mascot botId={b.id} color={b.color} size={52} />
      <div className="flex items-end gap-1">
        <span className="text-[40px] font-medium leading-[42px] tracking-[-0.04em] text-[#2E3300]">{time}</span>
        <span className="pb-1 text-[11px] text-[#6B6B6B]">{ampm}</span>
      </div>
      <span className="text-[14px] leading-5 text-[#3A3A38]">Welcome back, {b.name}</span>
      {apps.length > 0 && (
        <div className="flex gap-3 pt-2.5">
          {apps.map((x) => (
            <div key={x.app} className="flex w-[52px] flex-col items-center gap-1">
              <AppLogo app={x.app} name={x.appName} size={34} />
              <span className="w-full truncate text-center text-[10px] leading-[13px] text-[#3A3A38]">{x.appName.replace("Google ", "")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NoComputer({ state, bot: b, host }: { state: AppState; bot: Bot; /** The bot whose computer it works on (itself, unless it shares the main bot's). */ host: Bot }) {
  const plan = usePlan(state);
  // Whether the user's Orgo plan has room to make it: the main bot's, or a copy of it for a bot of its own.
  // One made already whose setup didn't finish takes no more room: Set up finishes it (POST /api/computer).
  // The main bot's takes none when it's the user's free Bops computer (or shares it): no note then.
  const noRoom = plan ? setupShort(plan.plan, state.bots, host) : null;
  const free = host.isMain && freeComputerOpen(plan?.plan);
  // Being made: the same ghost a connecting screen shows, since it's the same kind of wait.
  if (host.computerStatus === "cloning")
    return (
      <div className="relative aspect-[16/10] w-full overflow-hidden rounded-[20px]" style={{ backgroundImage: botWash(b) }}>
        <Waking thumbnail={false} bot={b} text={`Setting up ${host.name}'s computer… about a minute`} />
      </div>
    );
  return (
    <div className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-3 rounded-[20px] px-8 text-center" style={{ backgroundImage: botWash(b) }}>
      <Mascot botId={b.id} color={b.color} size={44} />
      <span className="max-w-[300px] text-[14px] leading-5">
        {b.isMain
          ? `${b.name} doesn't have a computer yet. ${free ? `Your free Bops computer starts the first time ${b.name} needs it` : `It starts the first time ${b.name} needs one`}, or set it up now. The bots you add work on it too, unless you give one its own.`
          : host.id !== b.id
            ? `${b.name} works on ${host.name}'s computer, which isn't set up yet. It starts the first time either of them needs it.`
            : plan?.plan?.bops
              ? `${b.name} doesn't have a computer yet. It gets a Bops computer of its own, fresh from the Bops template.`
              : `${b.name} doesn't have a computer yet. It gets a copy of the main bot's computer: apps, logins and open screens.`}
      </span>
      {plan && noRoom ? (
        <PlanNote
          info={plan}
          short={noRoom.short}
          className="max-w-[320px]"
          text={
            noRoom.short === "none"
              ? `${noRoom.text} Until then, your bots can work on this Mac (Settings, Where your bots work).`
              : host.isMain
                ? noRoom.text
                : `${b.name} will work on the main bot's computer instead. ${noRoom.text}`
          }
        />
      ) : (
        <button onClick={() => void post("/api/computer", { botId: b.id })} className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold leading-4 text-white">
          {`Set up ${host.name}'s computer`}
        </button>
      )}
    </div>
  );
}

/** The computer itself, for the bot's Details: where it came from and how it's running. */
export function ComputerSummary({ state, bot: b, className = "", onOpen }: { state: AppState; bot: Bot; className?: string; onOpen?: () => void }) {
  const mac = state.host === "mac";
  const c = mac ? b : workBot(b, state.bots);
  const { info } = useComputer(b.id, mac ? undefined : c.computerId, !mac && computerInUse(state, onComputerOf(state, c)));
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      aria-label={`Open ${b.name}'s computer`}
      className={`group/pc flex items-center gap-3 rounded-2xl px-4 py-3 text-left transition-[filter] enabled:hover:brightness-[0.98] ${className}`}
    >
      <MonitorIcon size={16} color="#0A0A0A" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] font-semibold leading-4">Computer</span>
        <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">
          {mac
            ? "Browsers on this Mac"
            : b.isMain
              ? `${b.name}'s cloud computer`
              : c.id !== b.id
                ? `Works on ${c.name}'s cloud computer`
                : b.computerId
                  ? "Its own cloud computer, set up like the main bot's"
                  : "Its own, set up on its first task"}
        </span>
      </div>
      {info?.computer && <span className="shrink-0 font-mono text-[12px] leading-4 text-[#6B6B6B]">{`${info.computer.status === "suspended" ? "asleep" : info.computer.status} · ${info.computer.cpu} CPU`}</span>}
      {onOpen && (
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden className="shrink-0 text-[#9A9A98] transition-transform group-hover/pc:translate-x-0.5 group-hover/pc:text-ink">
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

/** With the right panel collapsed: a round button, like the call button, that reopens the bot's computer. */
export function ComputerPeek({ state, bot: b, onOpen }: { state: AppState; bot: Bot; onOpen: () => void }) {
  const running = state.sessions.filter((s: Session) => s.botId === b.id && live(s));
  const needsYou = running.some((s) => s.blocker) || !!state.watches?.some((w) => w.botId === b.id && w.alert);
  const label = `${b.name}'s computer · ${needsYou ? "needs you" : running.length ? `working on ${running.length} thing${running.length === 1 ? "" : "s"}` : "nothing running"}`;
  return (
    <button
      onClick={onOpen}
      aria-label={label}
      title={label}
      className="relative flex size-11 items-center justify-center rounded-full bg-white shadow-[0_0_0_1px_#E6E6E3,0_8px_20px_-10px_#00000040] hover:shadow-[0_0_0_1px_#C9C9C6,0_8px_20px_-10px_#00000040]"
    >
      <MonitorIcon size={18} color="#0A0A0A" />
      {(needsYou || running.length > 0) && (
        <span
          className={`absolute right-[7px] top-[7px] size-[9px] rounded-full shadow-[0_0_0_2px_#FFFFFF] ${needsYou ? "bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]" : "animate-pulse bg-[#2BB673]"}`}
        />
      )}
    </button>
  );
}

/** Headless Mac screens have no address bar of their own, so taking over adds one. */
function AddressBar({ botId, display }: { botId: string; display: number }) {
  const [url, setUrl] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (url.trim()) void post("/api/input", { botId, display, kind: "navigate", url: url.trim() });
        setUrl("");
      }}
    >
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Go to an address"
        className="w-[220px] rounded-full bg-white/70 px-3.5 py-1.5 text-[13px] leading-[18px] text-ink outline-none placeholder:text-[#6B6B6B] focus:bg-white"
      />
    </form>
  );
}
