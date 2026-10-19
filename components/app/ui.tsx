"use client";

import { screenNo as screenNumber } from "@/lib/screens";
import { needsYou } from "@/lib/asks";
import { useEffect, useRef, useState } from "react";
import { live, MAIN_WORKSPACE, workspaceOf, type AppState, type Bot, type Chat, type Logo, type Session } from "@/lib/types";
import { Mascot, Spinner } from "./mascot";
export { botBezel, botOnInk, botWash, DESKTOP_BG } from "@/lib/look";

/* Shared helpers and small pieces used across the app. Values follow the Paper designs. */

/** Every state fetcher on the page, so an action can pull fresh state the moment it lands. */
const refreshers = new Set<() => Promise<void>>();
export const refreshState = () => Promise.all([...refreshers].map((f) => f()));

/** Sends an action, then refreshes state before resolving, so the UI never shows the old world. */
export const post = async (url: string, body: unknown = {}, method = "POST") => {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await refreshState();
  return res;
};

export const screenNo = (display?: number) => (display === undefined ? undefined : screenNumber(display));

/** A choice card in Settings (Where your bots work, Where routines run): picked, or not; and its radio. */
export const option = (on: boolean) => (on ? "bg-[#FBFFE0] shadow-[0_0_0_1.5px_#0A0A0A]" : "shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]");
export const radio = (on: boolean) =>
  on ? (
    <span className="flex size-4 items-center justify-center rounded-full bg-ink">
      <span className="size-1.5 rounded-full bg-highlighter" />
    </span>
  ) : (
    <span className="size-4 rounded-full shadow-[inset_0_0_0_1.5px_#C9C9C6]" />
  );

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

/** A quiet routine's thread that found nothing (lib/types.ts, shared with the server): lists of threads leave it out. */
export { quietNothing } from "@/lib/types";

export { needsYou };

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

/** A side's show/hide toggle: a window with that side's bar, filled while it's shown (the sidebar on the left, the panel on the right). */
export function SideToggleIcon({ side, open }: { side: "left" | "right"; open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="#3A3A38" strokeWidth="1.3" />
      <path d={side === "left" ? "M6 2.5v11" : "M10 2.5v11"} stroke="#3A3A38" strokeWidth="1.3" />
      {open && <rect x={side === "left" ? 2.1 : 10.6} y="3.1" width="3.3" height="9.8" fill="#3A3A38" opacity="0.25" />}
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

/**
 * Something needs the user: a small amber dot with an exclamation mark. On their initials while this Mac
 * still needs something (setup.tsx), and on Full access's one warning in the People sheet (members.tsx).
 */
export function NeedsYouDot({ className = "" }: { className?: string }) {
  return (
    <span className={`flex size-4 shrink-0 items-center justify-center rounded-full bg-[#E59A0B] ${className}`}>
      <svg width="8" height="8" viewBox="0 0 8 8">
        <path d="M4 1.3v3.1" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="4" cy="6.3" r="0.85" fill="#FFFFFF" />
      </svg>
    </span>
  );
}

/** The round X the Account sheet closes with, for a tab on the right that reads as a page (the Vault, a bot's profile). */
export function CloseButton({ onClick, className = "" }: { onClick: () => void; className?: string }) {
  return (
    <button onClick={onClick} aria-label="Close" className={`flex size-8 shrink-0 items-center justify-center rounded-full shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6] ${className}`}>
      <svg width="12" height="12" viewBox="0 0 12 12">
        <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
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

/**
 * Whether this is a self-hosted install (/api/config): Bops runs every service for you otherwise, so
 * Settings shows only what's yours to set, and there are no usage events to mention.
 */
export function useSelfHosted() {
  const [selfHosted, setSelfHosted] = useState(false);
  useEffect(() => {
    void fetch("/api/config")
      .then((r) => r.json())
      .then((c: { selfHosted?: boolean }) => setSelfHosted(!!c.selfHosted));
  }, []);
  return selfHosted;
}
