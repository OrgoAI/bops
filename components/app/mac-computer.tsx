"use client";

import { useEffect, useRef, useState } from "react";
import { live, type AppState, type Bot, type Session, type Watch } from "@/lib/types";
import { ApprovalCard, MacIcon, MacSettings } from "./mac-tab";
import { MacStream, useAppWindows, useMacApp, useMacScreens } from "./mac-screens";
import { WatchBadge, WatchEye, WatchOverlay, type Spot } from "./watch-overlay";
import { Mascot } from "./mascot";
import { botBezel, post } from "./ui";

/**
 * Your Mac, shown like a bot's computer (computer.tsx): one big live screen in a frame, a row of
 * everything there is to see under it, and a status pill. The "screens" are the windows bots are
 * working in (live as video, by window) and each display. It follows the work the same way: it cuts
 * to the window a bot is acting in, holds each cut a few seconds, and never cuts away while you're
 * pointing at it; two or more bots at work show as a grid; an approval a bot is waiting on jumps to
 * the front, on the screen itself. Pick a tile to stay on it; Follow goes back.
 */

/** An action this recent makes a window "where the action is". Mac steps arrive slower than screen events. */
const FRESH_MS = 8000;
/** The window on show has to have been quiet this long before cutting away from it. */
const QUIET_MS = 4000;
/** Every cut stays up at least this long. */
const DWELL_MS = 5000;

/** The wash behind your Mac's screen: neutral, so the bots' colors stay theirs. */
const MAC_WASH = "linear-gradient(160deg, #F4F4F2 0%, #ECECE9 55%, #E2E2DE 100%)";

type Item = {
  key: string;
  sourceId: string;
  kind: "window" | "display";
  /** "Notes", or "Display 1". */
  label: string;
  /** "Built-in Retina Display", or the window's title. */
  sub: string;
  session?: Session;
  bot?: Bot;
  aspect?: number;
  /** The display Bops itself is on. */
  bops?: boolean;
  /** Jev is watching this window for the user. */
  watch?: Watch;
  app?: string;
  windowId?: number;
};

export function MacComputer({
  state,
  mode,
  onFocus,
  onBack,
  onOpenThread,
  hidden = false,
}: {
  state: AppState;
  mode: "panel" | "focus";
  onFocus?: () => void;
  onBack?: () => void;
  onOpenThread: (s: Session) => void;
  /** Kept capturing behind another tab: the view stays live, the director rests. */
  hidden?: boolean;
}) {
  const inApp = useMacApp();
  const screens = useMacScreens();
  // A tile you picked, and when: it stays until a new task starts on the Mac (then the view follows that).
  const [pin, setPin] = useState<{ key: string; at: number } | null>(null);
  const [settings, setSettings] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [shown, setShown] = useState<string | null>(null);
  const [cut, setCut] = useState<{ key: string; text: string; at: number }>({ key: "", text: "", at: 0 });
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const frame = useRef<HTMLDivElement>(null);

  // The windows bots use: each Mac thread's latest app, while it works and for two minutes after.
  const threads = state.sessions.filter((s) => s.runsOn === "mac" && (s.macApps?.length || s.macWindow) && (live(s) || (s.endedAt && now - s.endedAt < 120_000)));
  const macWatches = (state.watches ?? []).filter((w) => w.mac);
  const apps = [...new Set([...threads.map((s) => s.macApps!.at(-1)!), ...macWatches.map((w) => w.mac!.app)])];
  const granted = screens?.access === "granted";
  const windows = useAppWindows(granted ? apps : []);

  const sources = new Set(screens?.sources.map((s) => s.id) ?? []);
  const items: Item[] = [];
  // Newest work first, so the busiest window sits leftmost. Each task gets the window it's about
  // (an app can have several: one Messages window per conversation), else the app's frontmost.
  const ordered = [...threads].sort((a, b) => lastAct(b) - lastAct(a));
  for (const s of ordered) {
    const app = s.macApps?.at(-1) ?? "";
    // The exact window the task's tools named, when it's still open; else its app's best match.
    const exact = s.macWindow && sources.has(`window:${s.macWindow.windowId}:0`) && !items.some((i) => i.sourceId === `window:${s.macWindow!.windowId}:0`)
      ? { windowId: s.macWindow.windowId, title: screens?.sources.find((x) => x.id === `window:${s.macWindow!.windowId}:0`)?.name ?? app }
      : undefined;
    const open = (windows[app]?.windows ?? []).filter((w) => sources.has(`window:${w.windowId}:0`) && !items.some((i) => i.sourceId === `window:${w.windowId}:0`));
    const w = exact ?? windowFor(s, open) ?? open[0];
    if (!w) continue;
    const sourceId = `window:${w.windowId}:0`;
    items.push({ key: sourceId, sourceId, kind: "window", label: w.title && w.title !== app ? w.title : app, sub: app, session: s, bot: state.bots.find((b) => b.id === s.botId), app, windowId: w.windowId });
  }
  // Watched windows always have a tile (and the ones above learn they're watched).
  for (const wt of macWatches) {
    const m = wt.mac!;
    const w = (windows[m.app]?.windows ?? []).find((x) => x.windowId === m.windowId) ?? (windows[m.app]?.windows ?? []).find((x) => x.title === m.title);
    const sourceId = w ? `window:${w.windowId}:0` : "";
    if (!sourceId || !sources.has(sourceId)) continue;
    const have = items.find((i) => i.sourceId === sourceId);
    if (have) have.watch = wt;
    else items.push({ key: sourceId, sourceId, kind: "window", label: m.title, sub: m.app, watch: wt, app: m.app, windowId: w!.windowId });
  }
  // The apps' other windows too (up to four windows in all, so the displays keep their tiles).
  for (const app of apps)
    for (const w of windows[app]?.windows ?? []) {
      const sourceId = `window:${w.windowId}:0`;
      if (items.length >= 4 || !sources.has(sourceId) || items.some((i) => i.sourceId === sourceId)) continue;
      items.push({ key: sourceId, sourceId, kind: "window", label: w.title || app, sub: app, app, windowId: w.windowId });
    }
  const displays = [...(screens?.displays ?? [])].sort((a, b) => Number(b.primary) - Number(a.primary));
  displays.forEach((d, i) => {
    const src = screens?.sources.find((s) => s.displayId === d.id) ?? (displays.length === 1 ? screens?.sources.find((s) => s.id.startsWith("screen:")) : undefined);
    if (src) items.push({ key: src.id, sourceId: src.id, kind: "display", label: displays.length > 1 ? `Display ${i + 1}` : "Your screen", sub: d.label, aspect: d.width / d.height, bops: d.id === screens?.bopsOn });
  });

  // Where macOS marks a streamed window as shared (its purple capsule), as a spot on the picture: as
  // measured, else where it sits on macOS 26 windows (16 pt in from the corner, 66 by 20).
  const markerOf = (i: Item): Spot | undefined => {
    const w = i.app && i.windowId !== undefined ? windows[i.app]?.windows?.find((x) => x.windowId === i.windowId) : undefined;
    if (!w?.size?.w || !w.size.h) return undefined;
    const m = w.marker ?? { x: 16, y: 16, w: 66, h: 20 };
    return { left: m.x / w.size.w, top: m.y / w.size.h, width: m.w / w.size.w, height: m.h / w.size.h };
  };
  const approvals = state.mac?.approvals ?? [];
  // Needs you: an approval a bot waits on, or something new in a watched window.
  const waitingOn = (i: Item) => (!!i.session && approvals.some((a) => a.sessionId === i.session!.id)) || !!i.watch?.alert;
  const working = items.filter((i) => i.session && live(i.session));
  const acting = (i: Item) => !!i.session && live(i.session) && now - lastAct(i.session) < FRESH_MS;

  // The newest Mac task ever started (finishing one doesn't bring an old pin back).
  const newestTask = Math.max(0, ...state.sessions.filter((s) => s.runsOn === "mac").map((s) => s.createdAt));
  const pinned = pin && newestTask === pin.at ? pin.key : null;
  const following = !pinned;
  const grid = following && working.length >= 2 && !items.some(waitingOn) ? working.slice(0, 4) : [];
  // With nothing running: the window a bot just finished in, else a display (not the one Bops is on, if there's another).
  const fallbackKey = (working[0] ?? items.find((i) => i.kind === "window") ?? items.find((i) => i.kind === "display" && !i.bops) ?? items.find((i) => i.kind === "display"))?.key ?? null;
  const current = items.find((i) => i.key === (pinned ?? shown)) ?? items.find((i) => i.key === fallbackKey);

  /** Where to cut to: a window waiting on you at once; else, calmly, where a bot just acted. */
  const pickCut = (t: number) => {
    if (!following) return null;
    // A bot waiting on an approval holds the view. A heads-up from a watched window gets one cut;
    // after that the view follows the bots' work again (the window keeps its yellow ring).
    const urgent = items.find((i) => (!!i.session && approvals.some((a) => a.sessionId === i.session!.id)) || (!!i.watch?.alert && !shownAlerts.has(i.watch.alert.at)));
    if (urgent && urgent.key !== current?.key) return urgent;
    // Already showing it: that counts as shown.
    if (urgent?.watch?.alert) shownAlerts.add(urgent.watch.alert.at);
    if (urgent && !urgent.watch?.alert) return null;
    if (hovering || t - cut.at < DWELL_MS) return null;
    const [top] = [...working].sort((a, b) => lastAct(b.session!) - lastAct(a.session!));
    if (!top || top.key === current?.key) return current ? null : (items.find((i) => i.key === fallbackKey) ?? null);
    const quiet = !current?.session || !live(current.session) || t - lastAct(current.session) > QUIET_MS;
    return t - lastAct(top.session!) < FRESH_MS && quiet ? top : null;
  };
  // Heads-ups the view already cut to, by when they came in.
  const [shownAlerts] = useState(() => new Set<number>());
  const tick = useRef<() => void>(() => {});
  useEffect(() => {
    tick.current = () => {
      if (hidden) return;
      const t = Date.now();
      setNow(t);
      const to = pickCut(t);
      if (!to) return;
      setShown(to.key);
      if (to.watch?.alert) shownAlerts.add(to.watch.alert.at);
      setCut({ key: to.key, text: to.watch?.alert ? `New in ${to.label}` : waitingOn(to) ? `${to.bot?.name ?? "A bot"} needs you` : `Now: ${to.bot?.name ?? "A bot"} · ${to.label}`, at: t });
    };
  });
  useEffect(() => {
    const t = setInterval(() => tick.current(), 500);
    return () => clearInterval(t);
  }, []);
  const cutNote = current && cut.key === current.key && now - cut.at < 2600 ? cut.text : null;

  const pick = (i: Item) => {
    // Remember the newest task as of now: a newer one releases the pin.
    setPin({ key: i.key, at: newestTask });
    if (i.watch?.alert) void post("/api/watches", { id: i.watch.id, action: "seen" }, "PATCH");
  };
  // The watch setup sheet: for a window (new or watched), or a picker of every window when null.
  const [watchSheet, setWatchSheet] = useState<{ app?: string; title?: string; windowId?: number; watch?: Watch } | null | false>(false);
  const fullscreen = () => void frame.current?.requestFullscreen().catch(() => {});
  const ratio = (current && (aspects[current.key] ?? current.aspect)) || 16 / 10;
  const learn = (key: string) => (w: number, h: number) => setAspects((x) => (x[key] === w / h ? x : { ...x, [key]: w / h }));
  const approval = current?.session ? approvals.find((a) => a.sessionId === current.session!.id) : undefined;
  const lastStep = current?.session?.steps.filter((x) => x.tool !== "setup").at(-1);
  const followRow = working.length > 1 || !following;

  const header =
    mode === "focus" ? (
      <div className="flex items-center gap-2.5">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-full py-1.5 pl-2 pr-3 shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
          <svg width="12" height="12" viewBox="0 0 14 14">
            <path d="M9 2.5L4.5 7 9 11.5" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[13px] font-medium leading-4">Back</span>
        </button>
        <span className="text-[15px] font-semibold leading-5">Your Mac</span>
        <span className="flex-1" />
        <div className="flex gap-1">
          {items.map((i) => {
            const on = i.key === current?.key && !grid.length;
            return (
              <button
                key={i.key}
                onClick={() => pick(i)}
                className={`flex items-center gap-1.5 rounded-[9px] py-[5px] ${i.bot ? "pl-1.5" : "pl-2.5"} pr-2.5 ${on ? "bg-ink" : i.session ? "bg-[#F2F2F0]" : "shadow-[inset_0_0_0_1.2px_#D9D9D6]"}`}
              >
                {i.bot && <Mascot botId={i.bot.id} color={i.bot.color} size={14} antenna={false} />}
                {i.bot && <span className={`text-[12px] font-medium leading-4 ${on ? "text-white" : "text-ink"}`}>{i.bot.name}</span>}
                <span className={`max-w-[120px] truncate text-[12px] leading-4 ${on ? "text-white/70" : "text-[#6B6B6B]"}`}>{i.label}</span>
              </button>
            );
          })}
        </div>
        <SettingsButton onClick={() => setSettings(true)} />
      </div>
    ) : null;

  // The bar under the screen shows only when something's going on: a task, an approval, news.
  const showBar = !!grid.length || !!approval || !!current?.watch?.alert || !!current?.session || working.length > 0;
  // Before there's anything to stream: not in the app, no permission yet, or still looking.
  const blocked = !inApp ? "app" : !screens ? "loading" : !granted ? "permission" : !current ? "nothing" : null;

  return (
    <div className={`relative flex min-h-0 flex-1 flex-col gap-3 ${mode === "focus" ? "px-5 pb-4 pt-3.5" : ""}`} style={mode === "panel" ? { containerType: "size", justifyContent: "center" } : undefined}>
      {header}
      {/* In the panel the screen, its tiles and the status sit together in the middle, like a bot's computer. */}
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center"
        style={{
          containerType: "size",
          ...(mode === "panel" && !blocked ? { flex: "none", height: `min(calc(100cqh - ${84 + 44 + 24 + (followRow ? 28 : 0) + 4}px), calc(100cqw / ${grid.length === 2 ? ratio * 2 : ratio}))` } : {}),
        }}
      >
        <div
          ref={frame}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
          onClick={() => !blocked && !grid.length && !approval && (mode === "panel" ? onFocus?.() : fullscreen())}
          className={`group/screen relative flex flex-none flex-col overflow-hidden rounded-[22px] bg-[#111111] ${!blocked && !grid.length && !approval ? "cursor-pointer" : ""}`}
          style={{
            backgroundImage: blocked ? MAC_WASH : undefined,
            width: `min(100cqw, calc(100cqh * ${grid.length === 2 ? ratio * 2 : ratio}))`,
            aspectRatio: `${grid.length === 2 ? ratio * 2 : ratio}`,
          }}
        >
          {blocked ? (
            <Blocked why={blocked} />
          ) : grid.length ? (
            <div className={`grid h-full w-full gap-[3px] ${grid.length > 2 ? "grid-cols-2 grid-rows-2" : "grid-cols-2"}`}>
              {grid.map((i) => (
                <button key={i.key} onClick={() => pick(i)} title="Watch this up close" className="group/tile relative min-h-0 overflow-hidden">
                  <MacStream sourceId={i.sourceId} fps={15} maxWidth={1280} className="h-full w-full" onSize={learn(i.key)} />
                  <div className="pointer-events-none absolute inset-0 transition-shadow duration-300" style={{ boxShadow: acting(i) && i.bot ? `inset 0 0 0 3px ${botBezel(i.bot)}` : undefined }} />
                  <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover/tile:opacity-100" style={{ boxShadow: "inset 0 0 0 2px #FFFFFF" }} />
                  <WhoPill item={i} />
                </button>
              ))}
            </div>
          ) : (
            current && (
              <>
                <MacStream key={current.sourceId} sourceId={current.sourceId} className="h-full w-full animate-[screen-in_300ms_ease-out]" onSize={learn(current.key)} />
                {current.watch && !approval && <WatchOverlay watch={current.watch} anchor={markerOf(current)} />}
                {/* Hovering: a soft ring and a pill, like a bot's computer. */}
                {!approval && (
                  <div className="pointer-events-none absolute inset-0 z-30 opacity-0 transition-opacity duration-200 group-hover/screen:opacity-100">
                    <div className="absolute inset-0 rounded-[22px] shadow-[inset_0_0_0_2.5px_#0A0A0A]" />

                  </div>
                )}
                {/* Pointing at the screen brings up its controls, like a bot's computer: watch it, see it bigger, settings. */}
                {!approval && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute bottom-3 left-1/2 z-40 flex -translate-x-1/2 translate-y-1 items-center gap-1 rounded-full bg-white/95 p-1 opacity-0 shadow-[0_0_0_1px_#0000000F,0_10px_24px_-10px_#00000066] backdrop-blur transition duration-200 group-hover/screen:translate-y-0 group-hover/screen:opacity-100"
                  >
                    {!current.watch?.alert && (
                      <button
                        onClick={() => setWatchSheet(current.kind === "window" ? { app: current.app, title: current.label, windowId: current.windowId, watch: current.watch } : null)}
                        title={current.watch ? `Change what ${current.label} is watched for` : "Keep an eye on a window and tell me when something needs me"}
                        className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium leading-4 text-ink hover:bg-[#F2F2F0]"
                      >
                        <WatchEye size={13} />
                        {current.watch ? "Edit" : "Watch"}
                      </button>
                    )}
                    <button
                      onClick={() => (mode === "panel" ? onFocus?.() : fullscreen())}
                      className="flex items-center gap-1.5 rounded-full bg-ink py-1.5 pl-2.5 pr-3.5 text-[13px] font-semibold leading-4 text-white"
                    >
                      <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M1.5 5V1.5H5M9 1.5h3.5V5M12.5 9v3.5H9M5 12.5H1.5V9" />
                      </svg>
                      {mode === "panel" ? "See it bigger" : "Full screen"}
                    </button>
                    {mode === "panel" && <SettingsButton onClick={() => setSettings(true)} />}
                  </div>
                )}
                {/* Why the view just cut here. */}
                {cutNote && (
                  <span
                    key={cut.at}
                    className="pointer-events-none absolute left-1/2 top-3 z-20 max-w-[90%] -translate-x-1/2 animate-[cut-note_2600ms_ease-in-out_forwards] truncate rounded-full bg-ink/85 px-3 py-1 text-[12px] font-medium leading-4 text-white shadow-[0_6px_16px_-8px_#00000080] backdrop-blur"
                  >
                    {cutNote}
                  </span>
                )}
                {/* What the bot is waiting on, on the screen it's about. */}
                {approval && (
                  <div onClick={(e) => e.stopPropagation()} className="absolute inset-x-3 bottom-3 z-40">
                    <ApprovalCard state={state} approval={approval} compact />
                  </div>
                )}
              </>
            )
          )}
        </div>
      </div>

      {mode === "panel" && !blocked && followRow && (
        <div className="-mb-1 flex items-center gap-2">
          {following ? (
            <span className="flex items-center gap-1.5 text-[12px] leading-4 text-[#6B6B6B]" title="Bops shows the window being worked on. Pick one to stay on it.">
              <span className="size-1.5 animate-pulse rounded-full bg-[#2BB673]" />
              {grid.length ? `Watching ${grid.length} windows at once` : "Following the action"}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[12px] leading-4 text-[#6B6B6B]">
              Staying on {current?.label ?? "this"}
              <button onClick={() => setPin(null)} className="rounded-full bg-white px-2 py-[2px] font-medium text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]">
                Follow
              </button>
            </span>
          )}
        </div>
      )}

      {/* One tile that's already on the big screen says nothing; a few keep a bot computer's quarter-width slots. */}
      {mode === "panel" && !blocked && (items.length > 1 || (items.length === 1 && (items[0].key !== current?.key || !!grid.length))) && (
        <div className="flex justify-center gap-2.5">
          {items.slice(0, 6).map((i) => {
            const inView = i.key === current?.key && !grid.length;
            return (
              <button
                key={i.key}
                onClick={() => pick(i)}
                title={i.session ? `${i.bot?.name} · ${i.session.title}` : i.sub}
                style={
                  waitingOn(i)
                    ? { boxShadow: "0 0 0 2px #0A0A0A, 0 0 0 4px #E8FF3A" }
                    : !inView && acting(i) && i.bot
                      ? { boxShadow: `0 0 0 2px ${botBezel(i.bot)}, 0 0 14px -2px ${botBezel(i.bot)}` }
                      : undefined
                }
                className={`relative flex min-w-0 flex-col gap-1.5 rounded-xl p-1.5 text-left transition-shadow duration-300 ${items.length >= 4 ? "flex-1 basis-0" : "w-[calc((100%-30px)/4)] flex-none"} ${inView ? "bg-white shadow-[0_0_0_2px_#0A0A0A]" : i.session ? "bg-[#F7F7F6]" : "shadow-[inset_0_0_0_1.5px_#E2E2DF]"}`}
              >
                <div className="relative h-[52px] shrink-0 overflow-hidden rounded-[7px] bg-[#111111]">
                  <MacStream key={`${i.sourceId}-t`} sourceId={i.sourceId} fps={2} maxWidth={400} fit="cover" className="h-full w-full" />
                  {i.watch && <WatchBadge watch={i.watch} />}
                  {i.session && live(i.session) && <span className={`absolute right-1 top-1 size-[9px] rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A] ${acting(i) ? "animate-pulse" : ""}`} />}
                </div>
                <div className="flex min-w-0 items-center gap-[5px] text-[11px] leading-[14px]">
                  {i.bot ? (
                    <>
                      <Mascot botId={i.bot.id} color={i.bot.color} size={14} antenna={false} />
                      <span className="shrink-0 font-semibold">{i.bot.name}</span>
                      <span className={`truncate ${inView ? "text-ink" : "text-[#6B6B6B]"}`}>{i.label}</span>
                    </>
                  ) : i.watch ? (
                    <span className="truncate pl-0.5 font-semibold">{i.label}</span>
                  ) : (
                    <span className="truncate pl-0.5 text-[#9A9A98]">{i.label}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Under the screen, only when something's going on: a task, an approval, news. Its controls are on the screen. */}
      {!blocked && showBar && (
        <div className={`flex max-w-full items-center gap-3 self-center rounded-full bg-white py-1.5 pl-3.5 pr-1.5 shadow-[0_0_0_1px_#ECECEA,0_6px_18px_-10px_#00000040]`}>
          <span className={`size-2 shrink-0 rounded-full ${approval || items.some(waitingOn) ? "bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]" : working.length ? "bg-[#2BB673]" : "bg-[#C9C9C6]"}`} />
          <span className="min-w-0 truncate text-[13px] leading-4">
            {grid.length
              ? `${grid.length} bots are working on your Mac · pick one to watch it up close`
              : approval
                ? `${current?.bot?.name ?? "A bot"} needs you: ${approval.app ? `allow ${approval.app}` : approval.message}`
                : current?.watch?.alert
                  ? `New in ${current.label}: ${current.watch.alert.text}`
                  : current?.watch && !(current.session && live(current.session))
                    ? current.watch.away
                      ? `Paused · ${current.watch.mac?.title ?? current.label} isn't showing here right now`
                      : `Watching ${current.watch.mac?.title ?? current.label} · ${current.watch.lookFor}`
                : current?.session && live(current.session)
                  ? `${current.bot?.name ?? "A bot"} · ${lastStep?.detail ?? current.session.activity ?? current.session.title}`
                  : working.length
                    ? `${working.length} working on your Mac`
                    : `Nothing running · ${current?.label ?? "your screen"}${current?.kind === "display" ? ` (${current.sub})` : ""}`}
          </span>
          {current?.session && !grid.length && (
            <button
              onClick={() => onOpenThread(current.session!)}
              className="shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]"
            >
              Open thread
            </button>
          )}
          {current?.session && live(current.session) && !grid.length && (
            <button
              onClick={() => void post("/api/sessions", { sessionId: current.session!.id }, "DELETE")}
              title="Stop this task on your Mac"
              className="shrink-0 rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-semibold leading-4 text-white"
            >
              Stop
            </button>
          )}
          {!grid.length && current?.watch?.alert && (
            <button
              onClick={() => void post("/api/watches", { id: current.watch!.id, action: "draft" }, "PATCH")}
              title={`${state.bots.find((b) => b.id === current.watch!.botId)?.name ?? "A bot"} writes a reply in the window for you to read and send`}
              className="shrink-0 rounded-full bg-highlighter px-3.5 py-1.5 text-[13px] font-semibold leading-4 text-ink shadow-[0_0_0_1px_#0000001F]"
            >
              Draft a reply
            </button>
          )}

        </div>
      )}
      {blocked && mode === "panel" && (
        <div className="flex justify-center">
          <SettingsButton onClick={() => setSettings(true)} label />
        </div>
      )}

      {settings && <MacSettingsSheet state={state} onClose={() => setSettings(false)} />}
      {watchSheet !== false && <MacWatchSheet target={watchSheet} onClose={() => setWatchSheet(false)} />}
    </div>
  );
}

/** The window a task is about: the one whose title (a conversation, a document) its words mention. */
function windowFor(s: Session, open: { windowId: number; title: string }[]) {
  const said = [s.title, s.goal, s.answer ?? "", ...s.steps.slice(-6).map((x) => x.detail)].join(" ").toLowerCase();
  const words = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 3);
  let best: { w: (typeof open)[number]; score: number } | undefined;
  for (const w of open) {
    const score = words(w.title).filter((x) => said.includes(x)).length;
    if (score > 0 && (!best || score > best.score)) best = { w, score };
  }
  return best?.w;
}

/** When a step last happened in a thread (its start, before any). */
function lastAct(s: Session) {
  return s.steps.at(-1)?.at ?? s.startedAt ?? s.createdAt;
}

/** Who's working this window, and on what: the pill in its corner. */
function WhoPill({ item: i }: { item: Item }) {
  if (!i.session) return null;
  return (
    <span className="pointer-events-none absolute bottom-2 left-2 z-20 flex max-w-[85%] items-center gap-1 rounded-full bg-white/95 py-[2px] pl-1 pr-2 text-[11px] leading-[14px] shadow-[0_0_0_1px_#0000000F]">
      {i.bot && <Mascot botId={i.bot.id} color={i.bot.color} size={13} antenna={false} />}
      <span className="shrink-0 font-semibold">{i.bot?.name ?? "A bot"}</span>
      <span className="truncate text-[#3A3A38]">
        {i.label} · {i.session.title}
      </span>
    </span>
  );
}

function Blocked({ why }: { why: "app" | "loading" | "permission" | "nothing" }) {
  if (why === "loading") return <div className="h-full w-full animate-pulse" />;
  const [title, body] =
    why === "app"
      ? ["Open the Bops app to watch your Mac", "A browser tab can't see your screen. In the Bops app, your displays and the windows bots use show here live."]
      : why === "permission"
        ? ["Let Bops see your screen", "macOS asks once: turn on Bops under Screen Recording, then quit and reopen Bops."]
        : ["Nothing to show yet", "Bops can't find a display to show."];
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-8 text-center">
      <span className="flex size-11 items-center justify-center rounded-2xl bg-ink text-highlighter">
        <MacIcon size={20} />
      </span>
      <span className="text-[15px] font-semibold leading-5 text-ink">{title}</span>
      <span className="max-w-[340px] text-[12.5px] leading-[18px] text-[#6B6B6B]">{body}</span>
      {why === "permission" && (
        <button onClick={() => void window.bopsMac?.openScreenSettings()} className="mt-1 rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-white">
          Open Screen Recording settings
        </button>
      )}
    </div>
  );
}

function SettingsButton({ onClick, label }: { onClick: () => void; label?: boolean }) {
  return (
    <button
      onClick={onClick}
      title="Your Mac settings: apps bots may use, words that mean your Mac"
      aria-label="Your Mac settings"
      className={`flex shrink-0 items-center justify-center gap-1.5 rounded-full text-[12.5px] font-medium text-[#3A3A38] hover:bg-[#F2F2F0] ${label ? "px-3 py-1.5 shadow-[0_0_0_1px_#E2E2DF]" : "size-8"}`}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
        <circle cx="10" cy="4.5" r="1.5" />
        <circle cx="6" cy="11.5" r="1.5" />
      </svg>
      {label && "Your Mac settings"}
    </button>
  );
}

/** The settings, out of the way of the screen: a sheet over the tab. Click outside to close. */
function MacSettingsSheet({ state, onClose }: { state: AppState; onClose: () => void }) {
  return (
    <div onClick={onClose} className="absolute inset-0 z-50 flex items-start justify-center bg-black/10 p-4 backdrop-blur-[2px]">
      <div onClick={(e) => e.stopPropagation()} className="relative flex max-h-full w-full max-w-[520px] flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_0_0_1px_#0000000F,0_24px_60px_-20px_#00000066]">
        <button onClick={onClose} aria-label="Close" className="absolute right-3 top-3 z-10 flex size-8 items-center justify-center rounded-full text-[#6B6B6B] hover:bg-[#F2F2F0]">
          <svg width="11" height="11" viewBox="0 0 12 12">
            <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <MacSettings state={state} />
      </div>
    </div>
  );
}

/** Quick picks for what to watch a window for, by app. */
function watchPicks(app: string, title: string) {
  if (/messages|whatsapp|telegram|signal|discord|slack/i.test(app)) return [`New messages from ${title}`, "Anything I haven't answered", "When someone asks me a question"];
  if (/mail|outlook|superhuman|spark/i.test(app)) return ["New emails that need me", "Emails from customers", "Anything marked urgent"];
  if (/calendar/i.test(app)) return ["New invites", "Changes to today's meetings"];
  return ["Anything new that needs me", "Errors or warnings"];
}

/**
 * Watch a window on your Mac: pick the window (when it isn't the one on screen), say what's worth
 * a heads-up, done. Jev reads the window's text when it changes; the main bot tells you in its chat.
 */
function MacWatchSheet({ target, onClose }: { target: { app?: string; title?: string; windowId?: number; watch?: Watch } | null; onClose: () => void }) {
  const [windows, setWindows] = useState<{ app: string; title: string; windowId: number }[] | null>(null);
  const [picked, setPicked] = useState(target?.app && target.windowId !== undefined ? target : null);
  const [lookFor, setLookFor] = useState(target?.watch?.lookFor ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (picked) return;
    let gone = false;
    void fetch("/api/mac/windows?all=1", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { windows: { app: string; title: string; windowId: number }[] }) => !gone && setWindows(j.windows))
      .catch(() => !gone && setWindows([]));
    return () => {
      gone = true;
    };
  }, [picked]);

  const save = async (what: string) => {
    if (!picked?.app || picked.windowId === undefined) return;
    setBusy(true);
    setError(null);
    const res = picked.watch
      ? await post("/api/watches", { id: picked.watch.id, action: "edit", lookFor: what }, "PATCH")
      : await post("/api/watches", { mac: { app: picked.app, windowId: picked.windowId, title: picked.title }, lookFor: what });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (j.error) return setError(j.error);
    onClose();
  };
  const stop = async () => {
    if (!picked?.watch) return;
    await fetch(`/api/watches?id=${encodeURIComponent(picked.watch.id)}`, { method: "DELETE" });
    onClose();
  };

  return (
    <div onClick={onClose} className="absolute inset-0 z-50 flex items-start justify-center bg-black/10 p-4 backdrop-blur-[2px]">
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-full w-full max-w-[440px] flex-col gap-3 overflow-y-auto rounded-[20px] bg-white p-5 shadow-[0_0_0_1px_#0000000F,0_24px_60px_-20px_#00000066]">
        <div className="flex items-center gap-2">
          <WatchEye size={13} />
          <span className="text-[15px] font-semibold leading-5">{picked ? `Watch ${picked.title}` : "Watch a window on your Mac"}</span>
        </div>
        {!picked ? (
          <>
            <span className="text-[12.5px] leading-[17px] text-[#6B6B6B]">Pick the window. Bops reads its text when it changes (no screenshots, nothing clicked) and tells you when something needs you.</span>
            <div className="flex max-h-[300px] flex-col overflow-y-auto rounded-xl shadow-[0_0_0_1px_#ECECEA]">
              {windows === null ? (
                <span className="px-3 py-3 text-[12.5px] text-[#9A9A98]">Looking at your windows…</span>
              ) : windows.length === 0 ? (
                <span className="px-3 py-3 text-[12.5px] text-[#9A9A98]">No windows to watch right now.</span>
              ) : (
                windows.map((w) => (
                  <button
                    key={w.windowId}
                    onClick={() => setPicked(w)}
                    className="flex items-center gap-2 border-b border-[#F0F0EE] px-3 py-2 text-left last:border-0 hover:bg-[#FCFCFB]"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{w.title}</span>
                    <span className="shrink-0 text-[12px] text-[#9A9A98]">{w.app}</span>
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <span className="text-[12.5px] leading-[17px] text-[#6B6B6B]">Tell me when there&rsquo;s:</span>
            <div className="flex flex-wrap gap-1.5">
              {watchPicks(picked.app!, picked.title ?? picked.app!).map((p) => (
                <button key={p} disabled={busy} onClick={() => void save(p)} className="rounded-full bg-[#F2F2F0] px-3 py-1.5 text-[12.5px] font-medium leading-4 hover:bg-[#EAEAE7] disabled:opacity-50">
                  {p}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (lookFor.trim()) void save(lookFor.trim());
              }}
              className="flex gap-1.5"
            >
              <input
                autoFocus
                value={lookFor}
                onChange={(e) => setLookFor(e.target.value)}
                placeholder="Or say it your way"
                className="h-9 min-w-0 flex-1 rounded-xl bg-[#F7F7F6] px-3 text-[13.5px] outline-none placeholder:text-[#9A9A98] focus:bg-white focus:shadow-[0_0_0_1.5px_#0A0A0A]"
              />
              <button type="submit" disabled={busy || !lookFor.trim()} className="h-9 shrink-0 rounded-xl bg-ink px-3.5 text-[13px] font-medium text-white disabled:opacity-30">
                {picked.watch ? "Save" : "Watch"}
              </button>
            </form>
            {picked.watch && (
              <button onClick={() => void stop()} className="self-start text-[12.5px] font-medium text-[#B42318] hover:underline">
                Stop watching
              </button>
            )}
          </>
        )}
        {error && <span className="rounded-xl bg-[#FFF4F2] px-3 py-2 text-[12.5px] text-[#B42318]">{error}</span>}
      </div>
    </div>
  );
}
