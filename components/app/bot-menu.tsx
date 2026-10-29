"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { appsStayLine, live, type AppState, type Bot, type Effort } from "@/lib/types";
import { Mascot } from "./mascot";
import { AskInPlace, needsYou, post } from "./ui";
import { EFFORT_HINT, type Section } from "./bot-panel";

/** What the menu's actions do, from the app (bops-app.tsx). */
export type BotMenuActions = {
  onChat: (botId: string) => void;
  onCall: (botId: string) => void;
  onComputer: (botId: string) => void;
  onProfile: (botId: string, section?: Section) => void;
  /** Its chat, with the composer ready for a new task. */
  onNewTask: (botId: string) => void;
};

/** How hard it thinks, as its profile says it (bot-panel.tsx). */
const EFFORTS: Effort[] = ["auto", "low", "medium", "high"];

/**
 * A bot's right-click menu (the sidebar's rows): who it is and what it's doing, four quick actions
 * (chat, call, its computer, its profile), what it runs (routines, its number and inbox), its settings
 * (Just do it, how hard it thinks), and Delete, which asks first, in place, and says what goes with it. The main
 * bot runs the team, so it has no Delete. Esc, a click outside or a scroll closes it.
 */
export function BotMenu({ state, bot: b, x, y, onClose, actions }: { state: AppState; bot: Bot; x: number; y: number; onClose: () => void; actions: BotMenuActions }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x, top: y });
  const [thinking, setThinking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // Kept inside the window: flipped up or left when it would run off an edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAt({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y, thinking, confirm]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !confirm && onClose();
    const away = () => !confirm && onClose();
    window.addEventListener("keydown", key);
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
    };
  }, [onClose, confirm]);

  const sessions = state.sessions.filter((s) => s.botId === b.id && !s.dismissed);
  const asking = sessions.find((s) => needsYou(s) && !s.askWhere);
  const working = sessions.filter((s) => live(s) && !s.askWhere);
  const status = asking
    ? { dot: "needs", text: `Needs you: ${asking.title}` }
    : working.length
      ? { dot: "busy", text: working.length > 1 ? `Working on ${working.length} things` : `Working on ${working[0].title}` }
      : { dot: "", text: b.role || "Idle" };
  const routines = state.routines.filter((r) => r.botId === b.id);
  const reach = [b.phone && "number", b.email && "inbox"].filter(Boolean).join(" and ");
  const effort = b.effort ?? "auto";
  const go = (f: () => void) => () => {
    onClose();
    f();
  };

  const row = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] leading-4 text-ink hover:bg-[#F2F2F0]";
  const quick = "flex flex-1 flex-col items-center gap-1.5 rounded-xl py-2.5 text-[11.5px] font-medium leading-[14px]";

  return (
    <>
      {/* A press outside closes it; while Delete asks, it puts the question away first. */}
      <div className="fixed inset-0 z-50" onMouseDown={() => (confirm ? setConfirm(false) : onClose())} onContextMenu={(e) => (e.preventDefault(), onClose())} onWheel={() => !confirm && onClose()} />
      <div
        ref={ref}
        role="menu"
        aria-label={`${b.name}`}
        style={{ left: at.left, top: at.top }}
        className="fixed z-50 flex w-[284px] flex-col rounded-2xl bg-white p-1.5 shadow-[0_0_0_1px_#0000000F,0_18px_40px_-14px_#00000047]"
      >
        <div className="flex items-center gap-3 px-2.5 pb-3 pt-2.5">
          <Mascot botId={b.id} color={b.color} size={42} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-[16px] font-semibold leading-5 tracking-[-0.01em]">{b.name}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-4 text-[#6B6B6B]">
              {status.dot && (
                <span className={`size-[7px] shrink-0 rounded-full ${status.dot === "needs" ? "bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]" : "bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A] animate-pulse"}`} />
              )}
              <span className="truncate">{status.text}</span>
            </span>
          </div>
        </div>

        <div className="flex gap-1.5 px-1 pb-2">
          <button role="menuitem" onClick={go(() => actions.onChat(b.id))} className={`${quick} bg-ink text-white`}>
            <ChatGlyph />
            Chat
          </button>
          <button role="menuitem" onClick={go(() => actions.onCall(b.id))} className={`${quick} bg-[#F2F2F0] text-ink hover:bg-[#EAEAE7]`}>
            <CallGlyph />
            Call
          </button>
          <button role="menuitem" onClick={go(() => actions.onComputer(b.id))} className={`${quick} bg-[#F2F2F0] text-ink hover:bg-[#EAEAE7]`}>
            <ComputerGlyph />
            Computer
          </button>
          <button role="menuitem" onClick={go(() => actions.onProfile(b.id))} className={`${quick} bg-[#F2F2F0] text-ink hover:bg-[#EAEAE7]`}>
            <ProfileGlyph />
            Profile
          </button>
        </div>

        <div className="mx-1.5 mb-1 h-px bg-[#ECECEA]" />
        <button role="menuitem" onClick={go(() => actions.onNewTask(b.id))} className={row}>
          <span className="flex-1">New task for {b.name}…</span>
        </button>
        <button role="menuitem" onClick={go(() => actions.onProfile(b.id, "routines"))} className={row}>
          <span className="flex-1">Routines</span>
          <span className="truncate text-[12px] text-[#9A9A98]">{routines.length ? `${routines.filter((r) => r.enabled).length} on` : "None yet"}</span>
        </button>
        <button role="menuitem" onClick={go(() => actions.onProfile(b.id, "phone"))} className={row}>
          <span className="flex-1">Phone and email</span>
          <span className="truncate text-[12px] text-[#9A9A98]">{reach || "Set up"}</span>
        </button>

        <div className="mx-1.5 my-1 h-px bg-[#ECECEA]" />
        <button
          role="menuitemcheckbox"
          aria-checked={!!b.autoApprove}
          onClick={() => void post("/api/bots", { botId: b.id, autoApprove: !b.autoApprove }, "PATCH")}
          className={row}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span>Just do it</span>
            <span className="text-[11.5px] leading-[14px] text-[#9A9A98]">Acts without asking, except to pay</span>
          </span>
          <span className={`flex h-[18px] w-[30px] shrink-0 items-center rounded-full p-0.5 transition-colors ${b.autoApprove ? "justify-end bg-ink" : "justify-start bg-[#D9D9D6]"}`}>
            <span className="size-[14px] rounded-full bg-white shadow-[0_1px_2px_#00000033]" />
          </span>
        </button>
        <button role="menuitem" aria-expanded={thinking} onClick={() => setThinking(!thinking)} className={row}>
          <span className="flex-1">Thinking</span>
          <span className="text-[12px] capitalize text-[#9A9A98]">{effort}</span>
          <svg width="8" height="8" viewBox="0 0 8 8" className={`shrink-0 text-[#9A9A98] transition-transform ${thinking ? "rotate-90" : ""}`} aria-hidden>
            <path d="M2.5 1.5 5.5 4l-3 2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {thinking && (
          <div className="mx-1 mb-1 flex flex-col rounded-xl bg-[#F7F7F6] p-1">
            {EFFORTS.map((e) => (
              <button
                key={e}
                role="menuitemradio"
                aria-checked={e === effort}
                title={EFFORT_HINT[e]}
                onClick={() => void post("/api/bots", { botId: b.id, effort: e }, "PATCH")}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] leading-4 text-ink hover:bg-white"
              >
                <span className="w-3 shrink-0">{e === effort && <Check />}</span>
                <span className="flex-1 capitalize">{e}</span>
              </button>
            ))}
          </div>
        )}

        {!b.isMain && (
          <>
            <div className="mx-1.5 my-1 h-px bg-[#ECECEA]" />
            {confirm ? (
              <DeleteBot state={state} bot={b} onCancel={() => setConfirm(false)} onDone={onClose} />
            ) : (
              <button role="menuitem" onClick={() => setConfirm(true)} className={`${row} text-[#B42318] hover:bg-[#FEF3F2]`}>
                Delete {b.name}…
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

/**
 * Deleting a bot, asked once more in place of the menu's Delete (ui.tsx AskInPlace), saying what goes with it
 * (lib/server/remove.ts deleteBot: its own computer and everything on it, its inboxes, its chat, threads and routines)
 * and what stays (memory and Knowledge, the user's apps and logins, its messages in group chats, and the apps it made,
 * which go to the main bot). Cancel has focus; Esc is Cancel.
 */
function DeleteBot({ state, bot: b, onCancel, onDone }: { state: AppState; bot: Bot; onCancel: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threads = state.sessions.filter((s) => s.botId === b.id).length;
  const routines = state.routines.filter((r) => r.botId === b.id).length;
  const host = !b.computerId ? state.bots.find((x) => x.isMain && x.id !== b.id) : undefined;
  const goes = [
    b.computerId ? "Its cloud computer and everything on it: files in /workspace, open pages, sign-ins" : undefined,
    b.mail ? "Its email inbox" : undefined,
    `Its chat${threads ? `, ${threads} thread${threads === 1 ? "" : "s"}` : ""}${routines ? ` and ${routines} routine${routines === 1 ? "" : "s"}` : ""}`,
  ].filter(Boolean) as string[];
  const stays = ["Knowledge", "your apps and logins", "its messages in group chats", ...(host ? [`${host.name}'s computer, which it shared`] : [])];
  const madeApps = appsStayLine(state, b);
  const remove = async () => {
    setBusy(true);
    setError(null);
    const r = await post("/api/bots", { botId: b.id }, "DELETE");
    if (r.ok) return onDone();
    setBusy(false);
    setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't delete it.");
  };
  return (
    <div className="px-1 pb-1">
      <AskInPlace compact danger focus="cancel" title={`Delete ${b.name}?`} line="This can't be undone." action={`Delete ${b.name}`} busy={busy} error={error} onConfirm={() => void remove()} onCancel={onCancel}>
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10.5px] font-medium tracking-[0.06em] text-[#B42318]">GOES WITH {b.name.toUpperCase()}</span>
          {goes.map((g) => (
            <span key={g} className="text-[12.5px] leading-[17px] text-ink">
              {g}
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-1 border-t border-[#FECDCA] pt-2">
          <span className="font-mono text-[10.5px] font-medium tracking-[0.06em] text-[#6B6B6B]">STAYS</span>
          <span className="text-[12.5px] leading-[17px] text-[#3A3A38]">{stays.join(", ").replace(/^./, (c) => c.toUpperCase())}</span>
          {madeApps && <span className="text-[12.5px] leading-[17px] text-[#3A3A38]">{madeApps}</span>}
        </div>
      </AskInPlace>
    </div>
  );
}

const Check = () => (
  <svg width="11" height="11" viewBox="0 0 14 14" aria-hidden>
    <path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const glyph = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, "aria-hidden": true } as const;
const ChatGlyph = () => (
  <svg {...glyph} strokeLinejoin="round">
    <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 2.5V11.5a2 2 0 0 1-1.5-2z" />
  </svg>
);
const CallGlyph = () => (
  <svg {...glyph} strokeLinejoin="round">
    <path d="M4.5 2.5h2l1 3-1.5 1a7 7 0 0 0 3.5 3.5l1-1.5 3 1v2a1.5 1.5 0 0 1-1.6 1.5A10.5 10.5 0 0 1 3 4.1 1.5 1.5 0 0 1 4.5 2.5z" />
  </svg>
);
const ComputerGlyph = () => (
  <svg {...glyph} strokeLinecap="round">
    <rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.5" />
    <path d="M5.5 13.5h5" />
  </svg>
);
const ProfileGlyph = () => (
  <svg {...glyph} strokeLinecap="round">
    <circle cx="8" cy="5.5" r="2.5" />
    <path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" />
  </svg>
);
