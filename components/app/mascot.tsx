"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { moodOf, moodSignals, NO_SIGNALS, type MoodSignals } from "@/lib/bot-mood";
import { isMoving, mascotMarkup, type Mood } from "@/lib/mascot";
import type { AppState } from "@/lib/types";
import { useStateArrival } from "./state-arrival";
import { useWindowVisible } from "./window-visible";

/**
 * Plush-style bot mascots with headphones (lib/mascot.ts draws them). Every mascot in the app reads
 * what the bots are doing from one place (BotMoods, set at the top of the app) and picks its mood the
 * same way (lib/bot-mood.ts moodOf): a busy bot opens its eyes, an idle one vibes with them closed.
 */
export const BotMoods = createContext<MoodSignals>(NO_SIGNALS);

/**
 * BotMoods for everything inside, from the app's state and the call. A bot's blush wears off a few
 * seconds after the thanks with nothing new in the state to redraw it, so this draws again when it does.
 */
export function BotMoodsFrom({
  state,
  call,
  children,
}: {
  state: Pick<AppState, "sessions" | "chats" | "messages" | "liveMoods">;
  call: { botId: string; speaking: boolean } | null;
  children: React.ReactNode;
}) {
  // The time the moods are read at: when this first draws, when each new state comes in (a thanks
  // just sent is fresh, one synced in an hour late isn't), and again once a blush wears off.
  const [clock, setClock] = useState(() => Date.now());
  const arrived = useStateArrival();
  const moods = moodSignals(state, call, Math.max(clock, arrived));
  const until = moods.shyUntil;
  useEffect(() => {
    if (!until) return;
    const t = setTimeout(() => setClock(Date.now()), Math.max(0, until - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [until]);
  return <BotMoods.Provider value={moods}>{children}</BotMoods.Provider>;
}

/**
 * Whether the bot on the call is talking right now (CallBar's meter sets it as its voice starts and
 * stops). Kept out of the app's state, so a word starting or ending redraws only that bot's mascots,
 * not the whole window.
 */
export function talkingStore() {
  let talking = false;
  const listeners = new Set<() => void>();
  return {
    get: () => talking,
    set: (now: boolean) => {
      if (now === talking) return;
      talking = now;
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}
export type TalkingStore = ReturnType<typeof talkingStore>;
export const CallTalking = createContext<TalkingStore>(talkingStore());

export function Mascot({
  botId,
  color,
  size = 24,
  antenna = true,
  live = false,
  chatId,
}: {
  botId: string;
  color: string;
  size?: number;
  /** The main bot's highlighter headphones; false draws them in ink (the chat pill's small mark). */
  antenna?: boolean;
  /**
   * Shows what the bot is doing as it does it (thinking, writing, speaking, working, or shy), moving: the
   * mascots people watch (the sidebar's rows and main bot, the chat's header and typing line, the
   * call). Elsewhere a busy bot just opens its eyes.
   */
  live?: boolean;
  /** The chat this mascot stands for: it thinks over a reply there, and only works while it writes one elsewhere. */
  chatId?: string;
}) {
  const signals = useContext(BotMoods);
  const talk = useContext(CallTalking);
  // Only the call's bot reads the store's change (the others' answer stays false, so they don't redraw).
  const onCall = signals.call?.botId === botId;
  const talkingNow = () => onCall && talk.get();
  const talking = useSyncExternalStore(talk.subscribe, talkingNow, talkingNow);
  const mood = moodOf(talking ? { ...signals, call: { botId, speaking: true } } : signals, botId, chatId);
  if (live && isMoving(mood)) return <MovingMascot botId={botId} color={color} size={size} antenna={antenna} mood={mood} />;
  return <MascotSvg botId={botId} color={color} size={size} antenna={antenna} mood={mood === "idle" ? "idle" : "awake"} />;
}

/** A mascot in a mood that moves (app/globals.css, mascot-*): its motion rests while the window is hidden. */
function MovingMascot(props: { botId: string; color: string; size: number; antenna: boolean; mood: Mood }) {
  const visible = useWindowVisible();
  return <MascotSvg {...props} paused={!visible} />;
}

function MascotSvg({ botId, color, size, antenna, mood, paused }: { botId: string; color: string; size: number; antenna: boolean; mood: Mood; paused?: boolean }) {
  // Markup comes from our own constant shapes and bot colors, never from user text.
  return (
    <svg
      viewBox="0 0 40 40"
      className={paused ? "mascot-paused" : undefined}
      style={{ width: size, height: size, flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: mascotMarkup(botId, color, { mood, accent: antenna }) }}
    />
  );
}

export function Spinner({ size = 13, color = "#0A0A0A" }: { size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 14 14" width={size} height={size} className="animate-spin" style={{ flexShrink: 0 }}>
      <circle cx="7" cy="7" r="5.2" fill="none" stroke={color} strokeWidth="1.6" strokeDasharray="24 9" strokeLinecap="round" />
    </svg>
  );
}

/** ♪ and ♫, as on bops.bot (site/notes.js). */
const NOTES = [
  '<ellipse cx="7" cy="17.5" rx="3.3" ry="2.5" transform="rotate(-20 7 17.5)"/><rect x="9.4" y="4" width="1.8" height="13.6" rx=".9"/><path d="M11.2 4c0 3.2 4.8 3.8 4.8 7.6-.9-1.7-2.7-2.4-4.8-2.7z"/>',
  '<ellipse cx="6" cy="18.3" rx="3" ry="2.3" transform="rotate(-20 6 18.3)"/><ellipse cx="17.6" cy="16.3" rx="3" ry="2.3" transform="rotate(-20 17.6 16.3)"/><rect x="8.1" y="6.2" width="1.7" height="12" rx=".85"/><rect x="19.7" y="4.2" width="1.7" height="12" rx=".85"/><path d="M8.1 6.2 21.4 3.6v2.9L8.1 9.1z"/>',
];

/**
 * Boppy listening to music, bopping to the beat while notes drift out of its headphones, singing along,
 * its eyes glancing about and blinking now and then: the app's first load, the same scene as the window's splash (desktop/splash.html). CSS only (globals.css).
 */
export function BoppyLoading({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3.5 text-[13px] text-pencil select-none">
      <div className="boppy-loading-scene" aria-hidden="true">
        <div className="boppy-loading-shadow" />
        {(["l", "r", "l", "r"] as const).map((side, i) => (
          <svg key={i} className={`boppy-loading-note ${side}`} viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: `<g fill="#0A0A0A">${NOTES[i === 0 || i === 3 ? 0 : 1]}</g>` }} />
        ))}
        <svg className="boppy-loading-boppy" viewBox="0 0 40 40" dangerouslySetInnerHTML={{ __html: mascotMarkup("boppy", "#0A0A0A", { mood: "awake" }) }} />
      </div>
      <div>{label}</div>
      {/* Below the label without moving it: the scene stays where the splash had it. */}
      {children && (
        <div className="relative -mt-3.5 h-0 w-full">
          <div className="absolute top-3.5 left-1/2 -translate-x-1/2">{children}</div>
        </div>
      )}
    </div>
  );
}
