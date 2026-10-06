"use client";

import { useEffect, useRef, useState } from "react";
import { DISPLAYS, live, MAIN_WORKSPACE, workspaceOf, type AppState, type Bot, type Chat, type Logo, type Session } from "@/lib/types";
import { Mascot, Spinner } from "./mascot";
export { botBezel, botOnInk, botWash, DESKTOP_BG } from "@/lib/look";

/* Shared helpers and small pieces used across the app. Values follow the Paper designs. */

/** Every state fetcher on the page, so an action can pull fresh state the moment it lands. */
const refreshers = new Set<() => Promise<void>>();
const refreshState = () => Promise.all([...refreshers].map((f) => f()));

/** Sends an action, then refreshes state before resolving, so the UI never shows the old world. */
export const post = async (url: string, body: unknown = {}, method = "POST") => {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await refreshState();
  return res;
};

export const screenNo = (display?: number) => (display === undefined ? undefined : DISPLAYS.indexOf(display) + 1);

export function ago(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return new Date(t).toLocaleDateString(undefined, { weekday: "short" });
}

export function duration(from: number, to = Date.now()) {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

export const clockTime = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** A thread needs the user when its screen hit something only they can get past, its bot is waiting on their answer (Jev decides), or it hit a problem they haven't answered. */
export function needsYou(s: Session) {
  // Dismissed, or a newer thread has the job: it never asks again.
  if (s.dismissed || s.replacedBy) return false;
  // It can't start until the user says where (their Mac or the cloud), whatever they've said since.
  if (s.askWhere && live(s)) return true;
  const lastUser = [...s.replies].reverse().find((r) => r.role === "user");
  const lastBot = [...s.replies].reverse().find((r) => r.role === "bot");
  if (lastUser && (!lastBot || lastUser.at > lastBot.at)) return false;
  if (live(s)) return !!s.blocker;
  if (s.status === "done") return !!s.blocker || (s.waitingOnYou ?? (s.answer ?? "").trim().endsWith("?"));
  return s.status === "failed" && !!s.error && !/stopped by you|paused/i.test(s.error);
}

export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const version = useRef(-1);
  useEffect(() => {
    let stop = false;
    let sent = 0;
    let applied = 0;
    const fetchState = async () => {
      const seq = ++sent;
      try {
        // The version we have: an unchanged state comes back as just the version (no 400 KB to parse).
        const res = await fetch(`/api/state?v=${version.current}`, { cache: "no-store" });
        const json = (await res.json()) as { version: number; state?: AppState };
        if (seq < applied) return; // a newer fetch already landed
        applied = seq;
        if (json.state && json.version !== version.current) {
          version.current = json.version;
          setState(json.state);
        }
      } catch {
        /* retry next tick */
      }
    };
    const tick = async () => {
      await fetchState();
      if (!stop) setTimeout(tick, 900);
    };
    refreshers.add(fetchState);
    void tick();
    return () => {
      stop = true;
      refreshers.delete(fetchState);
    };
  }, []);
  return state;
}

/** Re-render every second so relative times and timers stay current. */
export function useNow(ms = 1000) {
  const [, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function chatName(c: Chat, bots: Bot[]) {
  if (c.title) return c.title;
  const members = c.botIds.map((b) => bots.find((x) => x.id === b)?.name ?? b);
  return c.kind === "bot" ? members[0] : members.join(", ");
}

export function StatusIcon({ session: s, size = 13, dark }: { session: Session; size?: number; dark?: boolean }) {
  // Each state says what it means on hover (the tooltip layer reads data-tip).
  const tip = s.askWhere && live(s) ? "Waiting for you: your Mac or the cloud?" : live(s) ? "Working on it" : needsYou(s) ? "Needs you" : s.status === "done" ? "Done" : `Didn't finish${s.error ? `: ${s.error.slice(0, 80)}` : ""}`;
  const icon = live(s) && !(s.askWhere && needsYou(s)) ? (
    <Spinner size={size} color={dark ? "#0A0A0A" : "#3A3A38"} />
  ) : needsYou(s) ? (
    <span className="block rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]" style={{ width: size - 3, height: size - 3 }} />
  ) : s.status === "done" ? (
    <svg width={size} height={size} viewBox="0 0 14 14" className="block">
      <path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke="#2BB673" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 14 14" className="block">
      <path d="M4 4l6 6M10 4l-6 6" fill="none" stroke="#9A9A98" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
  return (
    <span data-tip={tip} className="flex shrink-0 items-center justify-center">
      {icon}
    </span>
  );
}

/** One avatar for a chat: the bot, or two stacked bots for a group. */
export function ChatAvatar({ chat, bots, size = 44 }: { chat: Chat; bots: Bot[]; size?: number }) {
  const members = chat.botIds.map((b) => bots.find((x) => x.id === b)).filter(Boolean) as Bot[];
  if (chat.kind === "bot" && members[0]) return <Mascot botId={members[0].id} color={members[0].color} size={size} />;
  const small = Math.round(size * 0.68);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {members.slice(0, 2).map((m, i) => (
        <div key={m.id} className="absolute" style={{ left: i * (size - small), top: i * (size - small) }}>
          <Mascot botId={m.id} color={m.color} size={small} />
        </div>
      ))}
    </div>
  );
}

export function MonitorIcon({ size = 12, color = "#8A8A88" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0">
      <rect x="1.5" y="2" width="11" height="7.5" rx="1.5" fill="none" stroke={color} strokeWidth="1.3" />
      <path d="M5 12h4" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function RoundButton({ label, onClick, children, active }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`flex size-[34px] shrink-0 items-center justify-center rounded-full shadow-[0_0_0_1px_#E6E6E3] ${active ? "bg-[#EEEEEC]" : "bg-white hover:bg-[#FCFCFB]"}`}
    >
      <svg width="15" height="15" viewBox="0 0 16 16">
        {children}
      </svg>
    </button>
  );
}


/** A service's real logo on a white tile (or the logo's own tile), else its letter on its color. */
export function BrandTile({ item, size }: { item: { name: string; color: string; glyph: string; logo?: Logo }; size: number }) {
  const radius = Math.round(size * 0.26);
  if (item.logo?.tile)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={item.logo.src} alt={item.name} width={size} height={size} className="shrink-0" style={{ borderRadius: radius }} />;
  if (item.logo)
    return (
      <span className="flex shrink-0 items-center justify-center bg-white shadow-[0_0_0_1px_#0000001A]" style={{ width: size, height: size, borderRadius: radius }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.logo.src} alt={item.name} width={Math.round(size * 0.66)} height={Math.round(size * 0.66)} className="object-contain" />
      </span>
    );
  return (
    <span className="flex shrink-0 items-center justify-center font-bold text-white" style={{ width: size, height: size, borderRadius: radius, background: item.color, fontSize: Math.round(size * 0.4) }}>
      {item.glyph}
    </span>
  );
}

/** The workspace the user is looking at, and its team (the main bot first). */
export const currentWorkspace = (state: AppState) => state.workspace ?? state.workspaces?.[0]?.id ?? MAIN_WORKSPACE;
export const teamOf = (state: AppState) => state.bots.filter((b) => workspaceOf(b) === currentWorkspace(state));
export const chatInWorkspace = (state: AppState, c: Chat) => (c.workspaceId ?? workspaceOf(state.bots.find((b) => b.id === c.botIds[0]))) === currentWorkspace(state);
